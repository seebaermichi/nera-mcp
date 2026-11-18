import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRunner, neraBin, npmCommand } from '../src/runner.js'
import { makeRoot, writeFiles } from './helpers.js'

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
