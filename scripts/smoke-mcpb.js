#!/usr/bin/env node
// The smoke test of the Claude Desktop extension: builds the `.mcpb`
// (scripts/build-mcpb.js) into a temp folder, unpacks it the way Claude
// Desktop does, starts the unpacked server with the manifest's own arguments
// and env (`NERA_MCP_RUNTIME=bundled`, `--root` a temp sites folder) and drives
// it over stdio like a client: `create_site` (the `blank` starter, a real
// `npm install` through the runtime shims), `preview` (the URL serves the
// site), `preview` with `stop: true`, after which the whole `nera dev` process
// tree must be gone. The server gets a PATH without any npm, so every npm a
// child runs is the bundle's own (`node_modules/npm`, through the shim
// folder), as on a machine without Node. Exits non-zero with the failing
// step's text. Needs the network (npm registry, nera.js.org for the docs);
// it is not part of the vitest suite, which stays offline. CI runs it on
// Windows (.github/workflows/test.yml); it runs on macOS and Linux too.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { unpackExtension } from '@anthropic-ai/mcpb'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { BUNDLED_DOCS } from '../src/resources.js'
import { buildMcpb } from './build-mcpb.js'
import { fetchDocs } from './fetch-docs.js'

/** `create_site` runs `npm install`, which can take minutes on a cold cache. */
const CALL_TIMEOUT_MS = 10 * 60 * 1000
/** How long the preview's process tree gets to disappear after the stop. */
const GONE_WAIT_MS = 15000
const SITE = 'smoke-site'

/**
 * `value` (a PATH) without every folder that holds an npm, so a child that
 * runs `npm` finds only the shim's. Node itself may stay findable: the shim
 * folder comes first anyway, and Claude Desktop's PATH is not empty either.
 *
 * @param {string} value
 * @param {NodeJS.Platform} [platform]
 * @returns {string}
 */
export function withoutNpm(value, platform = process.platform) {
    const delimiter = platform === 'win32' ? ';' : ':'
    const names = platform === 'win32' ? ['npm.cmd', 'npm'] : ['npm']
    return value.split(delimiter)
        .filter((dir) => dir && !names.some((name) => existsSync(path.join(dir, name))))
        .join(delimiter)
}

/**
 * Every process on this machine: its pid, its parent's pid and its command
 * line (`ps` on POSIX, CIM through PowerShell on Windows).
 *
 * @returns {Array<{ pid: number, ppid: number, command: string }>}
 */
export function processTable() {
    const options = { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true }
    if (process.platform === 'win32') {
        const json = execFileSync('powershell.exe', [
            '-NoProfile', '-NonInteractive', '-Command',
            'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress',
        ], options)
        return [].concat(JSON.parse(json)).map((row) => ({
            pid: row.ProcessId,
            ppid: row.ParentProcessId,
            command: row.CommandLine || '',
        }))
    }
    return execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command='], options)
        .split('\n')
        .map((line) => /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(line))
        .filter(Boolean)
        .map(([, pid, ppid, command]) => ({ pid: Number(pid), ppid: Number(ppid), command }))
}

/**
 * `root` and every process below it in `table`.
 *
 * @param {ReturnType<typeof processTable>} table
 * @param {{ pid: number }} root
 * @returns {ReturnType<typeof processTable>}
 */
export function processTree(table, root) {
    const tree = [root]
    for (let i = 0; i < tree.length; i++) {
        tree.push(...table.filter((row) => row.ppid === tree[i].pid && !tree.includes(row)))
    }
    return tree
}

/**
 * The processes of `tree` still running: same pid and same command line, so
 * a pid the system has handed to someone else does not count.
 *
 * @param {ReturnType<typeof processTable>} tree
 * @returns {ReturnType<typeof processTable>}
 */
function stillRunning(tree) {
    const table = processTable()
    return tree.filter((gone) => table.some((row) => row.pid === gone.pid && row.command === gone.command))
}

/**
 * Throws `message` unless `condition` holds.
 *
 * @param {unknown} condition
 * @param {string} message
 */
function check(condition, message) {
    if (!condition) throw new Error(message)
}

/**
 * Calls a tool and returns its structured content; an error result throws
 * with the tool's own text.
 *
 * @param {Client} client
 * @param {string} name
 * @param {object} args
 * @returns {Promise<object>}
 */
async function call(client, name, args) {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS })
    const text = result.content.map((part) => part.text).join('\n')
    check(!result.isError, `${name} ${JSON.stringify(args)} failed: ${text}`)
    console.log(`${name}: ${text}`)
    return result.structuredContent
}

/**
 * The manifest's `mcp_config` with its placeholders filled in, as Claude
 * Desktop fills them: `${__dirname}` is the unpacked extension,
 * `${user_config.root}` the sites folder.
 *
 * @param {string} extension
 * @param {string} root
 * @returns {Promise<{ args: string[], env: Record<string, string> }>}
 */
async function serverConfig(extension, root) {
    const manifest = JSON.parse(await fs.readFile(path.join(extension, 'manifest.json'), 'utf8'))
    const { args, env } = manifest.server.mcp_config
    const fill = (value) => value.replaceAll('${__dirname}', extension).replaceAll('${user_config.root}', root)
    return { args: args.map(fill), env }
}

/**
 * The paths of a case-insensitive file system compared as such.
 *
 * @param {string} value
 * @returns {string}
 */
function comparable(value) {
    return process.platform === 'win32' ? value.toLowerCase() : value
}

/**
 * Runs the smoke test; throws with the failing step's text.
 */
export async function smoke() {
    // realpath: the server sees its own files under their real path (macOS
    // /var → /private/var), and the checks below compare against them
    const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nera-mcp-smoke-')))
    // a space in every path, like Claude Desktop's own on macOS (Application Support)
    const base = path.join(tmp, 'Nera Smoke')
    const extension = path.join(base, 'extension')
    const root = path.join(base, 'sites')
    let client
    let stderr = ''
    let tree = []
    try {
        await fs.mkdir(extension, { recursive: true })
        await fs.mkdir(root, { recursive: true })
        if (!existsSync(BUNDLED_DOCS)) await fetchDocs()
        const bundle = await buildMcpb({ outputDir: tmp })
        check(await unpackExtension({ mcpbPath: bundle, outputDir: extension, silent: true }), `Could not unpack ${bundle}`)
        console.log(`Unpacked ${path.basename(bundle)} into ${extension}`)

        const { args, env } = await serverConfig(extension, root)
        const transport = new StdioClientTransport({
            command: process.execPath,
            args,
            // the SDK adds its own small env (PATH under that name on Windows
            // too, so this one replaces it), much like Claude Desktop's
            env: { ...env, PATH: withoutNpm(process.env.PATH || '') },
            cwd: extension,
            stderr: 'pipe',
        })
        transport.stderr.setEncoding('utf8')
        transport.stderr.on('data', (chunk) => { stderr += chunk })
        client = new Client({ name: 'nera-mcp-smoke', version: '1.0.0' })
        await client.connect(transport)

        // the bundled runtime: a shim folder whose npm is the bundle's own (the
        // bin reports it on stderr, which may arrive after the handshake)
        const shimLine = /npm and npx for children in (.+?)\r?\n/
        for (let i = 0; i < 50 && !shimLine.test(stderr); i++) await sleep(100)
        const shim = shimLine.exec(stderr)?.[1]
        check(shim, `The server did not report the bundled runtime with npm. Its log:\n${stderr}`)
        const npmShim = await fs.readFile(path.join(shim, process.platform === 'win32' ? 'npm.cmd' : 'npm'), 'utf8')
        const bundledNpm = path.join(extension, 'node_modules', 'npm', 'bin', 'npm-cli.js')
        check(comparable(npmShim).includes(comparable(bundledNpm)), `The npm shim does not run the bundle's npm (${bundledNpm}):\n${npmShim}`)
        console.log(`The npm shim runs ${bundledNpm}`)

        await call(client, 'create_site', { name: SITE, starter: 'blank', title: 'Smoke' })
        const siteDir = path.join(root, SITE)
        check(existsSync(path.join(siteDir, 'node_modules', '@nera-static', 'nera', 'package.json')), `create_site installed no @nera-static/nera in ${siteDir}`)

        const { url } = await call(client, 'preview', { site: SITE })
        const response = await fetch(url)
        const body = await response.text()
        check(response.ok, `GET ${url} answered HTTP ${response.status}`)
        const title = /<title>[^<]*<\/title>/.exec(await fs.readFile(path.join(siteDir, 'public', 'index.html'), 'utf8'))?.[0]
        check(title && body.includes(title), `GET ${url} did not serve the built index page (${title || 'no <title>'}):\n${body.slice(0, 500)}`)
        console.log(`GET ${url} → HTTP ${response.status}, ${title}`)

        const table = processTable()
        const dev = table.find((row) => row.ppid === transport.pid && comparable(row.command).includes(comparable(siteDir)) && / dev /.test(row.command))
        check(dev, `No \`nera dev\` process of ${siteDir} below the server (pid ${transport.pid})`)
        tree = processTree(table, dev)
        console.log(`The preview runs as ${tree.length} process(es), led by pid ${dev.pid}: ${dev.command}`)

        const { stopped } = await call(client, 'preview', { site: SITE, stop: true })
        check(stopped, 'preview with stop: true found no running preview')
        const deadline = Date.now() + GONE_WAIT_MS
        let left = stillRunning(tree)
        while (left.length && Date.now() < deadline) {
            await sleep(500)
            left = stillRunning(tree)
        }
        check(!left.length, `The preview's processes outlived the stop:\n${left.map((row) => `${row.pid} ${row.command}`).join('\n')}`)
        await fetch(url).then(
            (res) => check(false, `GET ${url} still answers (HTTP ${res.status}) after the stop`),
            () => {},
        )
        console.log(`All ${tree.length} process(es) of the preview are gone and ${url} no longer answers`)
    } catch (error) {
        error.message = `${error.message}${stderr ? `\n\nThe server's log:\n${stderr.slice(-8000)}` : ''}`
        throw error
    } finally {
        await client?.close()
        // after a failure: whatever of the preview is left, so the folder can go
        for (const row of tree.length ? stillRunning(tree) : []) {
            try {
                process.kill(row.pid, 'SIGKILL')
            } catch {
                // gone in between
            }
        }
        await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        await smoke()
        console.log('Smoke test of the Desktop extension passed')
    } catch (error) {
        console.error(`Smoke test of the Desktop extension failed: ${error.message}`)
        process.exitCode = 1
    }
}
