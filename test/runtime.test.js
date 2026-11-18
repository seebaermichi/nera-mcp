import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { childEnv, spawnOptions } from '../src/runner.js'
import {
    activateShim, activeShim, npmScripts, ownNpm, pathKey, setupRuntime, shimScripts, withPathPrefix, writeShim,
} from '../src/runtime.js'
import { makeRoot, writeFiles } from './helpers.js'

const posix = process.platform === 'win32' ? it.skip : it

let env
let shims

beforeEach(async () => {
    env = await makeRoot()
    shims = []
})

afterEach(async () => {
    activateShim(null)
    for (const shim of shims) shim.remove()
    await env.cleanup()
})

/** A fake npm package whose two scripts print which one ran and their argv. */
async function fakeNpm(dir) {
    await writeFiles(dir, {
        'bin/npm-cli.js': 'console.log(JSON.stringify({ cli: "npm", argv: process.argv.slice(2) }))\n',
        'bin/npx-cli.js': 'console.log(JSON.stringify({ cli: "npx", argv: process.argv.slice(2) }))\n',
    })
    return { npmCli: path.join(dir, 'bin', 'npm-cli.js'), npxCli: path.join(dir, 'bin', 'npx-cli.js') }
}

/** Runs `command args` with `PATH` set to `dir` alone; resolves with its exit code and output. */
function runWithPath(dir, command, args) {
    return new Promise((resolve) => {
        const child = spawn(command, args, { env: { PATH: dir }, stdio: ['ignore', 'pipe', 'pipe'] })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (chunk) => { stdout += chunk })
        child.stderr.on('data', (chunk) => { stderr += chunk })
        child.on('error', (error) => resolve({ code: null, stdout, stderr: error.message }))
        child.on('close', (code) => resolve({ code, stdout, stderr }))
    })
}

describe('the shim folder', () => {
    posix('lets a child with nothing else on its PATH run node, npm and npx', async () => {
        const npm = await fakeNpm(path.join(env.tmp, 'npm'))
        const shim = writeShim({ npm, platform: process.platform })
        shims.push(shim)

        const node = await runWithPath(shim.dir, 'node', ['-e', 'console.log(process.execPath)'])
        expect(node).toMatchObject({ code: 0, stdout: `${process.execPath}\n` })
        const npmRun = await runWithPath(shim.dir, 'npm', ['install', 'a b', '$HOME', '\'q\''])
        expect(npmRun.code).toBe(0)
        expect(JSON.parse(npmRun.stdout)).toEqual({ cli: 'npm', argv: ['install', 'a b', '$HOME', '\'q\''] })
        const npx = await runWithPath(shim.dir, 'npx', ['vite'])
        expect(JSON.parse(npx.stdout)).toEqual({ cli: 'npx', argv: ['vite'] })
    })

    posix('runs a `#!/usr/bin/env node` script through the shim', async () => {
        const shim = writeShim({ npm: null, platform: process.platform })
        shims.push(shim)
        const script = path.join(env.tmp, 'tool.js')
        await fs.writeFile(script, '#!/usr/bin/env node\nconsole.log("ran")\n', { mode: 0o755 })

        expect(await runWithPath(shim.dir, script, [])).toMatchObject({ code: 0, stdout: 'ran\n' })
    })

    posix('quotes paths with spaces, quotes and dollar signs', async () => {
        const npm = await fakeNpm(path.join(env.tmp, 'it\'s $HOME `x`'))
        const shim = writeShim({ npm, platform: process.platform })
        shims.push(shim)

        const run = await runWithPath(shim.dir, 'npm', ['-v'])
        expect(run.code).toBe(0)
        expect(JSON.parse(run.stdout)).toEqual({ cli: 'npm', argv: ['-v'] })
    })

    it('writes .cmd twins on Windows that pass %* on and double a % in a path', () => {
        const scripts = shimScripts({
            execPath: 'C:\\Program Files\\Claude\\node.exe',
            npm: { npmCli: 'C:\\ext\\100%\\npm\\bin\\npm-cli.js', npxCli: 'C:\\ext\\100%\\npm\\bin\\npx-cli.js' },
            platform: 'win32',
        })

        expect(Object.keys(scripts).sort()).toEqual(['node.cmd', 'npm.cmd', 'npx.cmd'])
        expect(scripts['node.cmd']).toBe('@echo off\r\n"C:\\Program Files\\Claude\\node.exe" %*\r\n')
        expect(scripts['npm.cmd']).toBe('@echo off\r\n"C:\\Program Files\\Claude\\node.exe" "C:\\ext\\100%%\\npm\\bin\\npm-cli.js" %*\r\n')
        expect(scripts['npx.cmd']).toContain('npx-cli.js" %*\r\n')
    })

    it('writes node alone when no npm was found', () => {
        expect(Object.keys(shimScripts({ execPath: '/n/node', npm: null, platform: 'linux' }))).toEqual(['node'])
    })

    it('lives in the temp folder, never in the root or a site, and goes on remove', () => {
        const shim = writeShim({ npm: null })
        shims.push(shim)

        expect(shim.dir.startsWith(path.join(os.tmpdir(), 'nera-mcp-runtime-'))).toBe(true)
        expect(shim.dir.startsWith(env.root)).toBe(false)
        shim.remove()
        expect(existsSync(shim.dir)).toBe(false)
        expect(() => shim.remove()).not.toThrow()
    })
})

describe('npm lookup', () => {
    it('prefers the server\'s own npm over the one next to Node', async () => {
        const node = path.join(env.tmp, 'node', 'bin', 'node')
        await writeFiles(path.join(env.tmp, 'node'), { 'lib/node_modules/npm/bin/npm-cli.js': '' })
        const own = path.join(env.tmp, 'own', 'npm')
        await writeFiles(own, { 'bin/npm-cli.js': '' })

        expect(npmScripts(node, own)).toEqual({ npmCli: path.join(own, 'bin', 'npm-cli.js'), npxCli: path.join(own, 'bin', 'npx-cli.js') })
        expect(npmScripts(node, null).npmCli).toBe(path.join(env.tmp, 'node', 'bin', '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'))
        expect(npmScripts(path.join(env.tmp, 'bare', 'node'), null)).toBeNull()
    })

    it('finds no npm of its own in an ordinary install', () => {
        expect(ownNpm()).toBeNull()
    })
})

describe('the PATH a child gets', () => {
    it('puts the shim folder first, keeping the rest', () => {
        expect(withPathPrefix({ PATH: '/usr/bin:/bin', HOME: '/h' }, '/shim', 'darwin')).toEqual({ PATH: '/shim:/usr/bin:/bin', HOME: '/h' })
        expect(withPathPrefix({}, '/shim', 'linux')).toEqual({ PATH: '/shim' })
    })

    it('keeps the spelling Windows uses and folds duplicates into one', () => {
        expect(pathKey({ Path: 'C:\\a' }, 'win32')).toBe('Path')
        expect(pathKey({}, 'win32')).toBe('Path')
        expect(pathKey({ Path: 'x' }, 'linux')).toBe('PATH')
        expect(withPathPrefix({ Path: 'C:\\a;C:\\b' }, 'C:\\shim', 'win32')).toEqual({ Path: 'C:\\shim;C:\\a;C:\\b' })
        expect(withPathPrefix({ Path: 'C:\\a', PATH: 'C:\\z' }, 'C:\\shim', 'win32')).toEqual({ Path: 'C:\\shim;C:\\a' })
    })

    it('is untouched without an active shim, and prefixed with one', () => {
        expect(activeShim()).toBeNull()
        expect(spawnOptions(env.site).env.PATH).toBe(process.env.PATH)

        activateShim('/shim')
        expect(spawnOptions(env.site, {}, 'linux').env.PATH).toBe(`/shim:${process.env.PATH}`)
        expect(spawnOptions(env.site, { PATH: '/only' }, 'linux').env.PATH).toBe('/shim:/only')
    })
})

describe('setupRuntime', () => {
    it('does nothing without NERA_MCP_RUNTIME=bundled', () => {
        const unbundled = { NERA_MCP_RUNTIME: 'system', PATH: '/usr/bin' }
        expect(setupRuntime({ env: {} })).toBeNull()
        expect(setupRuntime({ env: unbundled })).toBeNull()
        expect(unbundled).toEqual({ NERA_MCP_RUNTIME: 'system', PATH: '/usr/bin' })
        expect(activeShim()).toBeNull()
    })

    it('writes and activates the shim under NERA_MCP_RUNTIME=bundled', () => {
        const shim = setupRuntime({ env: { NERA_MCP_RUNTIME: 'bundled' }, shim: { npm: null } })
        shims.push(shim)

        expect(activeShim()).toBe(shim.dir)
        expect(existsSync(path.join(shim.dir, process.platform === 'win32' ? 'node.cmd' : 'node'))).toBe(true)
    })

    it('leaves the env it is given unchanged: children get the shim through childEnv', () => {
        const bundled = { NERA_MCP_RUNTIME: 'bundled', PATH: '/usr/bin:/bin', HOME: '/h' }
        const shim = setupRuntime({ env: bundled, shim: { npm: null } })
        shims.push(shim)

        expect(bundled).toEqual({ NERA_MCP_RUNTIME: 'bundled', PATH: '/usr/bin:/bin', HOME: '/h' })
        expect(childEnv({}, 'linux').PATH).toBe(`${shim.dir}:${process.env.PATH}`)
    })
})
