import { spawn as nodeSpawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createServer } from '../src/server.js'

/**
 * Writes `files` (`{ 'relative/path': 'text' }`) below `dir`, creating folders.
 */
export async function writeFiles(dir, files) {
    for (const [file, content] of Object.entries(files)) {
        const target = path.join(dir, file)
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.writeFile(target, content)
    }
}

export const SITE_PACKAGE = JSON.stringify({
    name: 'my-site',
    private: true,
    type: 'module',
    dependencies: {
        '@nera-static/nera': '^1.23.0',
        '@nera-static/plugin-navigation': '^2.0.0',
        '@nera-static/plugin-utils': '^1.0.0',
    },
})

/** The files of a minimal Nera site, as `nera new` would leave them. */
export function siteFiles() {
    return {
        'package.json': SITE_PACKAGE,
        'config/app.yaml': 'title: My site\nlang: en\n',
        'pages/index.md': '---\nlayout: pages/default.pug\ntitle: Home\n---\n# Welcome\n',
        'theme/views/pages/default.pug': 'p= meta.title\n',
    }
}

/**
 * A temp folder holding `root/` (the server's root, with one site in
 * `root/site/`) and `outside/` next to it (for escape tests).
 *
 * @returns {Promise<{ tmp: string, root: string, site: string, outside: string, cleanup: () => Promise<void> }>} real paths
 */
export async function makeRoot() {
    const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nera-mcp-')))
    const root = path.join(tmp, 'root')
    const outside = path.join(tmp, 'outside')
    await writeFiles(path.join(root, 'site'), siteFiles())
    await writeFiles(outside, { 'secret.txt': 'secret', 'pages/secret.md': '---\nlayout: x\n---\nsecret\n' })
    return {
        tmp,
        root,
        site: path.join(root, 'site'),
        outside,
        cleanup: () => fs.rm(tmp, { recursive: true, force: true }),
    }
}

/**
 * A real MCP client connected to `createServer({ root, … })` over the SDK's
 * in-memory transport.
 *
 * @returns {Promise<{ client: Client, server: import('@modelcontextprotocol/sdk/server/mcp.js').McpServer, call: (name: string, args?: object) => Promise<object>, close: () => Promise<void> }>}
 */
export async function connect(root, options = {}) {
    const server = await createServer({
        root,
        runner: options.runner ?? (async () => { throw new Error('runner not expected in this test') }),
        fetch: options.fetch ?? (async () => { throw new Error('fetch not expected in this test') }),
        docsFile: options.docsFile,
        processes: options.processes,
        timing: options.timing,
    })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'nera-mcp-test', version: '0.0.0' })
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    return {
        client,
        server,
        call: (name, args = {}) => client.callTool({ name, arguments: args }),
        close: async () => {
            await client.close()
            await server.close()
        },
    }
}

/** The text of a tool result (its first content item). */
export function textOf(result) {
    return result.content?.[0]?.text ?? ''
}

/**
 * A `spawn` for tests that fake Windows: `taskkill` is recorded instead of
 * run, and ends the target with SIGKILL as the real one would (the target is
 * a POSIX child here, so its own children are not reached); everything else
 * is spawned for real. `taskkill: 'error'` makes it fail to start (an `error`
 * event), `'throw'` makes `spawn` itself throw.
 *
 * @param {{ taskkill?: 'kill'|'error'|'throw' }} [options]
 * @returns {{ spawn: typeof nodeSpawn, taskkills: Array<{ file: string, args: string[], options: object }> }}
 */
export function fakeWindowsSpawn({ taskkill = 'kill' } = {}) {
    const taskkills = []
    const spawn = (file, args, options) => {
        if (!/taskkill(\.exe)?$/i.test(file)) return nodeSpawn(file, args, options)
        taskkills.push({ file, args, options })
        if (taskkill === 'throw') throw new Error('spawn taskkill ENOENT')
        const fake = new EventEmitter()
        setImmediate(() => {
            if (taskkill === 'error') {
                fake.emit('error', new Error('spawn taskkill ENOENT'))
                return
            }
            try {
                process.kill(Number(args[1]), 'SIGKILL')
            } catch {
                // gone already: the real taskkill exits non-zero then
            }
            fake.emit('exit', 0)
        })
        return fake
    }
    return { spawn, taskkills }
}
