import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { createRunner, neraBin, neraVersion, npmCommand } from '../src/runner.js'
import { activateShim } from '../src/runtime.js'
import { fakeWindowsSpawn, makeRoot, writeFiles } from './helpers.js'

let env

/** Vitest's limit for a case that polls `gone()`: above its own 5 s, so its assertions fail first. */
const GONE_TIMEOUT = 10_000

beforeEach(async () => {
    env = await makeRoot()
})

afterEach(async () => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    activateShim(null)
    await env.cleanup()
})

/** A fake `nera` in the site's node_modules that prints its argv and cwd. */
async function installFakeNera(dir) {
    await writeFiles(dir, {
        'node_modules/@nera-static/nera/bin/nera.js':
            'console.log(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }))\nconsole.error("to stderr")\nprocess.exitCode = 3\n',
    })
}

describe('createRunner', () => {
    it('runs the site\'s own nera with argv as an array and captures both streams', async () => {
        await installFakeNera(env.site)
        const stdoutWrite = vi.spyOn(process.stdout, 'write')
        const run = await createRunner()('nera', ['new', 'a b; echo pwned', '--name=$(whoami)'], { cwd: env.site })

        expect(run.code).toBe(3)
        expect(run.timedOut).toBe(false)
        expect(JSON.parse(run.stdout)).toEqual({ argv: ['new', 'a b; echo pwned', '--name=$(whoami)'], cwd: env.site })
        expect(run.stderr).toBe('to stderr\n')
        expect(stdoutWrite).not.toHaveBeenCalled()
    })

    it('gives the child no stdin, so nothing can wait for an answer', async () => {
        const run = await createRunner()('node', ['-e', 'process.stdin.on("data", () => {}); process.stdin.on("end", () => console.log("eof"))'], { cwd: env.site })
        expect(run).toMatchObject({ code: 0, stdout: 'eof\n' })
    })

    it('stops a run that exceeds the timeout', async () => {
        const run = await createRunner({ timeout: 200 })('node', ['-e', 'setTimeout(() => {}, 20000)'], { cwd: env.site })
        expect(run.code).toBeNull()
        expect(run.timedOut).toBe(true)
        expect(run.stderr).toMatch(/Stopped after 0.2 s\./)
    })

    it('escalates to SIGKILL when a run ignores SIGTERM, and stops what it started too', async () => {
        const script = [
            'process.on("SIGTERM", () => {})',
            'const child = require("node:child_process").spawn(process.execPath, ["-e", "process.on(\'SIGTERM\', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" })',
            'console.log(child.pid)',
            'setInterval(() => {}, 1000)',
        ].join(';')
        const started = Date.now()
        const run = await createRunner({ timeout: 300, grace: 200 })('node', ['-e', script], { cwd: env.site })

        expect(Date.now() - started).toBeLessThan(5000)
        expect(run).toMatchObject({ code: null, timedOut: true })
        const grandchild = Number(run.stdout)
        expect(grandchild).toBeGreaterThan(0)
        expect(await gone(grandchild)).toBe(true)
    }, GONE_TIMEOUT)

    it('stops a run when its signal aborts (the request was cancelled or the server closed)', async () => {
        const controller = new AbortController()
        const pending = createRunner()('node', ['-e', 'setTimeout(() => {}, 20000)'], { cwd: env.site, signal: controller.signal })
        setTimeout(() => controller.abort(), 100)
        const run = await pending
        expect(run).toMatchObject({ code: null, timedOut: false, cancelled: true })
        expect(run.stderr).toMatch(/Cancelled\.$/)
    })

    it('does not start a run whose signal has already aborted', async () => {
        const spawn = vi.fn()
        const run = await createRunner({ spawn })('node', [], { cwd: env.site, signal: AbortSignal.abort() })
        expect(spawn).not.toHaveBeenCalled()
        expect(run).toMatchObject({ code: null, cancelled: true })
    })

    it('reports a command that cannot start instead of throwing', async () => {
        const run = await createRunner()('node', [], { cwd: path.join(env.tmp, 'missing') })
        expect(run.code).toBeNull()
        expect(run.stderr).toMatch(/Could not start node: .*ENOENT/)
    })

    it('starts npm through Node, without a shell', async () => {
        const spawn = vi.fn(() => { throw new Error('stop') })
        await expect(createRunner({ spawn })('npm', ['install', 'x'], { cwd: env.site })).rejects.toThrow('stop')
        const [file, args, options] = spawn.mock.calls[0]
        const npm = npmCommand()
        expect(file).toBe(npm.file)
        expect(args).toEqual([...npm.prefix, 'install', 'x'])
        expect(options).toMatchObject({ cwd: env.site, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    })

    it('puts the active shim folder first on the child\'s PATH, and leaves the PATH alone without one', async () => {
        const printPath = ['-e', 'console.log(process.env.PATH)']
        const plain = await createRunner()('node', printPath, { cwd: env.site })
        expect(plain.stdout).toBe(`${process.env.PATH}\n`)

        activateShim(path.join(env.tmp, 'shim'))
        const shimmed = await createRunner()('node', printPath, { cwd: env.site })
        expect(shimmed.stdout).toBe(`${path.join(env.tmp, 'shim')}${path.delimiter}${process.env.PATH}\n`)
    })

    it('gives a run with `env` exactly that environment, nothing of this process\'s', async () => {
        vi.stubEnv('NERA_MCP_RUNNER_SECRET', 'do-not-pass')
        const printEnv = ['-e', 'console.log(JSON.stringify(process.env))']
        const run = await createRunner()('node', printEnv, { cwd: env.site, env: { PATH: process.env.PATH, ONLY: 'this' } })
        const childEnvironment = JSON.parse(run.stdout)
        expect(childEnvironment.ONLY).toBe('this')
        expect(childEnvironment.NERA_MCP_RUNNER_SECRET).toBeUndefined()
    })

    it('starts the system tar from the PATH, without a shell', async () => {
        const spawn = vi.fn(() => { throw new Error('stop') })
        await expect(createRunner({ spawn })('tar', ['-xf', 'a.tar'], { cwd: env.site })).rejects.toThrow('stop')
        const [file, args, options] = spawn.mock.calls[0]
        expect(file).toBe('tar')
        expect(args).toEqual(['-xf', 'a.tar'])
        expect(options).toMatchObject({ cwd: env.site, shell: false })
    })

    it('refuses any other command', async () => {
        await expect(createRunner()('sh', ['-c', 'true'], { cwd: env.site })).rejects.toThrow(/nera, npm, node or tar only/)
    })
})

describe('stopping a run on Windows', () => {
    const LONG = ['-e', 'setTimeout(() => {}, 20000)']

    it('ends the whole tree with taskkill /T /F, without a shell and never through a process group', async () => {
        const { spawn, taskkills, children } = fakeWindowsSpawn()
        const kill = vi.spyOn(process, 'kill')
        const run = await createRunner({ spawn, platform: 'win32', timeout: 200, grace: 5000 })('node', LONG, { cwd: env.site })

        expect(run).toMatchObject({ code: null, timedOut: true })
        expect(children).toHaveLength(1)
        expect(children[0]).toBeGreaterThan(0)
        const pid = String(children[0])
        // once, at the stop; not again after the child exited (its pid may be reused by then)
        // by its absolute path: a bare name would be looked up in the working directory first
        const file = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\taskkill.exe`
        expect(taskkills).toEqual([{ file, args: ['/pid', pid, '/T', '/F'], options: { stdio: 'ignore', shell: false, windowsHide: true } }])
        expect(kill.mock.calls.filter(([target]) => target < 0)).toEqual([])
    })

    it('spawns the child without its own process group', async () => {
        const spawn = vi.fn(() => { throw new Error('stop') })
        await expect(createRunner({ spawn, platform: 'win32' })('node', [], { cwd: env.site })).rejects.toThrow('stop')
        expect(spawn.mock.calls[0][2]).toMatchObject({ detached: false, shell: false })
    })

    it.each(['error', 'throw'])('terminates the child itself when taskkill cannot start (%s), without throwing', async (failure) => {
        const { spawn, taskkills, children } = fakeWindowsSpawn({ taskkill: failure })
        const controller = new AbortController()
        const pending = createRunner({ spawn, platform: 'win32', grace: 5000 })('node', LONG, { cwd: env.site, signal: controller.signal })
        setTimeout(() => controller.abort(), 200)
        const started = Date.now()
        const run = await pending

        expect(run).toMatchObject({ code: null, cancelled: true })
        expect(Date.now() - started).toBeLessThan(4000)
        expect(taskkills).toHaveLength(1)
        expect(children).toHaveLength(1)
        expect(await gone(children[0])).toBe(true)
    }, GONE_TIMEOUT)

    it('leaves POSIX alone: no taskkill, the process group is signalled', async () => {
        const { spawn, taskkills, children } = fakeWindowsSpawn()
        const kill = vi.spyOn(process, 'kill')
        const run = await createRunner({ spawn, platform: 'linux', timeout: 200 })('node', LONG, { cwd: env.site })

        expect(run).toMatchObject({ code: null, timedOut: true })
        expect(taskkills).toEqual([])
        expect(children).toHaveLength(1)
        expect(children[0]).toBeGreaterThan(0)
        expect(kill).toHaveBeenCalledWith(-children[0], 'SIGTERM')
    })
})

/**
 * True once `pid` no longer exists (polled, at most 5 s). A pid of 0 or less
 * would address a process group, which always exists, so it fails at once.
 */
async function gone(pid) {
    expect(pid).toBeGreaterThan(0)
    const end = Date.now() + 5000
    for (;;) {
        try {
            process.kill(pid, 0)
        } catch {
            return true
        }
        if (Date.now() > end) return false
        await new Promise((resolve) => setTimeout(resolve, 20))
    }
}

describe('neraBin', () => {
    it('prefers the site\'s own CLI and falls back to the one this server depends on', async () => {
        expect(neraBin(env.site)).toMatch(/node_modules[\\/]@nera-static[\\/]nera[\\/]bin[\\/]nera\.js$/)
        expect(neraBin(env.site).startsWith(env.site)).toBe(false)
        await installFakeNera(env.site)
        expect(neraBin(env.site)).toBe(path.join(env.site, 'node_modules', '@nera-static', 'nera', 'bin', 'nera.js'))
        await expect(fs.access(neraBin(env.root))).resolves.toBeUndefined()
    })
})

describe('neraVersion', () => {
    it('reads the version of the site\'s own CLI and falls back to the one this server depends on', async () => {
        const own = createRequire(import.meta.url)('@nera-static/nera/package.json').version
        expect(neraVersion(env.site)).toBe(own)
        await writeFiles(env.site, {
            'node_modules/@nera-static/nera/package.json': '{"name":"@nera-static/nera","version":"1.26.0"}',
            'node_modules/@nera-static/nera/bin/nera.js': '',
        })
        expect(neraVersion(env.site)).toBe('1.26.0')
    })

    it('is null for a site CLI whose package.json is missing, broken or has no string version', async () => {
        await writeFiles(env.site, { 'node_modules/@nera-static/nera/bin/nera.js': '' })
        expect(neraVersion(env.site)).toBeNull()
        for (const manifest of ['{', '{"name":"@nera-static/nera"}', '{"version":127}', 'null']) {
            await writeFiles(env.site, { 'node_modules/@nera-static/nera/package.json': manifest })
            expect(neraVersion(env.site), manifest).toBeNull()
        }
    })
})

describe('npmCommand', () => {
    it('uses npm-cli.js next to the Node binary when it is there', async () => {
        const node = path.join(env.tmp, 'node', 'bin', 'node')
        expect(npmCommand(node, null)).toEqual({ file: 'npm', prefix: [] })
        await writeFiles(path.join(env.tmp, 'node'), { 'lib/node_modules/npm/bin/npm-cli.js': '' })
        expect(npmCommand(node, null)).toEqual({ file: node, prefix: [path.join(env.tmp, 'node', 'bin', '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')] })
    })

    it('prefers the npm in the server\'s own node_modules (the Desktop extension bundles one)', async () => {
        const node = path.join(env.tmp, 'node', 'bin', 'node')
        await writeFiles(path.join(env.tmp, 'node'), { 'lib/node_modules/npm/bin/npm-cli.js': '' })
        const own = path.join(env.tmp, 'ext', 'node_modules', 'npm')
        await writeFiles(own, { 'bin/npm-cli.js': '' })
        expect(npmCommand(node, own)).toEqual({ file: node, prefix: [path.join(own, 'bin', 'npm-cli.js')] })
    })
})
