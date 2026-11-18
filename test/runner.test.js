import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRunner, neraBin, npmCommand } from '../src/runner.js'
import { fakeWindowsSpawn, makeRoot, writeFiles } from './helpers.js'

let env

beforeEach(async () => {
    env = await makeRoot()
})

afterEach(async () => {
    vi.restoreAllMocks()
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
    })

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

    it('refuses any other command', async () => {
        await expect(createRunner()('sh', ['-c', 'true'], { cwd: env.site })).rejects.toThrow(/nera, npm or node only/)
    })
})

describe('stopping a run on Windows', () => {
    const LONG = ['-e', 'console.log(process.pid); setTimeout(() => {}, 20000)']

    it('ends the whole tree with taskkill /T /F, without a shell and never through a process group', async () => {
        const { spawn, taskkills } = fakeWindowsSpawn()
        const kill = vi.spyOn(process, 'kill')
        const run = await createRunner({ spawn, platform: 'win32', timeout: 200, grace: 5000 })('node', LONG, { cwd: env.site })

        expect(run).toMatchObject({ code: null, timedOut: true })
        const pid = String(Number(run.stdout))
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
        const { spawn, taskkills } = fakeWindowsSpawn({ taskkill: failure })
        const controller = new AbortController()
        const pending = createRunner({ spawn, platform: 'win32', grace: 5000 })('node', LONG, { cwd: env.site, signal: controller.signal })
        setTimeout(() => controller.abort(), 200)
        const started = Date.now()
        const run = await pending

        expect(run).toMatchObject({ code: null, cancelled: true })
        expect(Date.now() - started).toBeLessThan(4000)
        expect(taskkills).toHaveLength(1)
        expect(await gone(Number(run.stdout))).toBe(true)
    })

    it('leaves POSIX alone: no taskkill, the process group is signalled', async () => {
        const { spawn, taskkills } = fakeWindowsSpawn()
        const kill = vi.spyOn(process, 'kill')
        const run = await createRunner({ spawn, platform: 'linux', timeout: 200 })('node', LONG, { cwd: env.site })

        expect(run).toMatchObject({ code: null, timedOut: true })
        expect(taskkills).toEqual([])
        expect(kill).toHaveBeenCalledWith(-Number(run.stdout), 'SIGTERM')
    })
})

/** True once `pid` no longer exists (polled, at most 5 s). */
async function gone(pid) {
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

describe('npmCommand', () => {
    it('uses npm-cli.js next to the Node binary when it is there', async () => {
        const node = path.join(env.tmp, 'node', 'bin', 'node')
        expect(npmCommand(node)).toEqual({ file: 'npm', prefix: [] })
        await writeFiles(path.join(env.tmp, 'node'), { 'lib/node_modules/npm/bin/npm-cli.js': '' })
        expect(npmCommand(node)).toEqual({ file: node, prefix: [path.join(env.tmp, 'node', 'bin', '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')] })
    })
})
