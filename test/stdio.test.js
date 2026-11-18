import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import pkg from '../package.json' with { type: 'json' }
import { makeRoot, writeFiles } from './helpers.js'

const BIN = fileURLToPath(new URL('../bin/nera-mcp.js', import.meta.url))
const EXIT_MS = 15000

/** Every tool of the L7a table; the bin must expose exactly these. */
const TOOLS = [
    'add_plugin', 'build', 'create_site', 'delete_page', 'get_site', 'list_plugins',
    'list_sites', 'list_starters', 'list_themes', 'preview', 'publish', 'read_file',
    'read_page', 'validate', 'write_file', 'write_page',
]

/**
 * Starts the bin with `args` and collects what it writes. `request` sends one
 * JSON-RPC message and resolves with the response carrying its id; `exited`
 * resolves with the exit code once the process ends.
 */
function startBin(args) {
    const child = spawn(process.execPath, [BIN, ...args], { stdio: ['pipe', 'pipe', 'pipe'] })
    const out = { stdout: '', stderr: '' }
    const waiting = new Map()
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
        out.stdout += chunk
        // whether every line is JSON-RPC is asserted by jsonRpcLines; here only answers are matched
        for (const line of out.stdout.split('\n').slice(0, -1)) {
            try {
                const message = JSON.parse(line)
                waiting.get(message.id)?.(message)
            } catch {
                // not JSON: left for jsonRpcLines to fail on
            }
        }
    })
    child.stderr.on('data', (chunk) => { out.stderr += chunk })
    const exited = new Promise((resolve) => child.on('close', (code) => resolve(code)))
    let nextId = 1
    return {
        child,
        out,
        exited,
        notify: (method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`),
        request: (method, params) => new Promise((resolve) => {
            const id = nextId++
            waiting.set(id, resolve)
            child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
        }),
    }
}

async function initialize(bin) {
    const response = await bin.request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'nera-mcp-stdio-test', version: '0.0.0' },
    })
    bin.notify('notifications/initialized')
    return response
}

/** Each stdout line, parsed; throws on anything that is not a JSON-RPC 2.0 message. */
function jsonRpcLines(stdout) {
    expect(stdout.endsWith('\n')).toBe(true)
    return stdout.trimEnd().split('\n').map((line) => {
        const message = JSON.parse(line)
        expect(message.jsonrpc).toBe('2.0')
        return message
    })
}

describe('bin/nera-mcp.js over stdio', () => {
    let tmp
    let bin

    beforeEach(async () => {
        tmp = await makeRoot()
    })

    afterEach(async () => {
        if (bin && bin.child.exitCode === null && bin.child.signalCode === null) {
            bin.child.kill('SIGKILL')
            await bin.exited
        }
        bin = undefined
        await tmp.cleanup()
    })

    it('answers initialize and tools/list with nothing but JSON-RPC on stdout', async () => {
        bin = startBin(['--root', tmp.root])
        const init = await initialize(bin)
        const list = await bin.request('tools/list', {})
        bin.child.stdin.end()

        expect(await bin.exited).toBe(0)
        expect(init.result.serverInfo).toEqual({ name: pkg.name, version: pkg.version })
        expect(list.result.tools.map((t) => t.name).sort()).toEqual(TOOLS)
        expect(jsonRpcLines(bin.out.stdout).map((m) => m.id)).toEqual([1, 2])
        expect(bin.out.stderr).toContain(`nera-mcp ${pkg.version}: serving Nera sites under ${tmp.root}`)
    }, EXIT_MS)

    it('exits 0 on SIGTERM', async () => {
        bin = startBin(['--root', tmp.root])
        await initialize(bin)
        bin.child.kill('SIGTERM')

        expect(await bin.exited).toBe(0)
    }, EXIT_MS)

    it('stops a running preview when the client hangs up', async () => {
        // a site without plugin dependencies, so `nera dev` builds it with this package's CLI
        await writeFiles(path.join(tmp.root, 'bare'), {
            'package.json': JSON.stringify({ name: 'bare', private: true, type: 'module', dependencies: { '@nera-static/nera': '^1.23.0' } }),
            'config/app.yaml': 'title: Bare\nlang: en\n',
            'pages/index.md': '---\nlayout: pages/default.pug\ntitle: Home\n---\n# Hi\n',
            'views/pages/default.pug': 'p= meta.title\n',
        })
        bin = startBin(['--root', tmp.root])
        await initialize(bin)
        const preview = await bin.request('tools/call', { name: 'preview', arguments: { site: 'bare' } })
        const { url } = preview.result.structuredContent
        expect((await fetch(url)).ok).toBe(true)

        bin.child.stdin.end()

        expect(await bin.exited).toBe(0)
        await expect(fetch(url)).rejects.toThrow()
        expect(jsonRpcLines(bin.out.stdout).map((m) => m.id)).toEqual([1, 2])
    }, 60000)

    it('exits 1 with a message on stderr when --root is missing', async () => {
        bin = startBin([])

        expect(await bin.exited).toBe(1)
        expect(bin.out.stderr).toContain('--root <folder> is required')
        expect(bin.out.stdout).toBe('')
    }, EXIT_MS)

    it('exits 1 with a message on stderr when --root does not exist', async () => {
        bin = startBin(['--root', path.join(tmp.tmp, 'missing')])

        expect(await bin.exited).toBe(1)
        expect(bin.out.stderr).toContain('does not exist')
        expect(bin.out.stdout).toBe('')
    }, EXIT_MS)

    it('exits 1 with a message on stderr when --root is a file', async () => {
        const file = path.join(tmp.tmp, 'file.txt')
        await fs.writeFile(file, 'x')
        bin = startBin(['--root', file])

        expect(await bin.exited).toBe(1)
        expect(bin.out.stderr).toContain('is a file, not a folder')
        expect(bin.out.stdout).toBe('')
    }, EXIT_MS)

    it('exits 1 on an unknown option', async () => {
        bin = startBin(['--root', tmp.root, '--port', '3000'])

        expect(await bin.exited).toBe(1)
        expect(bin.out.stderr).toContain('Unknown option \'--port\'')
        expect(bin.out.stdout).toBe('')
    }, EXIT_MS)

    it('prints its version', async () => {
        bin = startBin(['--version'])

        expect(await bin.exited).toBe(0)
        expect(bin.out.stdout).toBe(`${pkg.version}\n`)
    }, EXIT_MS)
})
