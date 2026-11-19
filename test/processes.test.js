import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createProcesses } from '../src/processes.js'
import { pendingAction, previewUrl } from '../src/tools/long-running.js'
import { connect, fakeWindowsSpawn, makeRoot, siteFiles, textOf, writeFiles } from './helpers.js'

/**
 * A fake `nera` for the site's node_modules. It appends its argv and BROWSER
 * to `calls.log` and behaves as `fake.json` in its cwd says:
 * - `dev`: `{ dev: 'serve' }` prints Vite's Local line after 50 ms and stays up;
 *   `'crash'` fails at once; `'silent'` stays up without printing an address.
 *   `{ grandchild: true }` also starts a child that ignores SIGTERM and writes its pid.
 * - `publish`: `{ publish: 'sign-in' }` asks for the GitHub code (the log line
 *   and the `action_required` event line of `--json`), waits for an
 *   `authorized` file, then reports `action_done` and prints the JSON result;
 *   `'fail'` prints a failure object; `'crash'` dies without one; `'slow'` logs
 *   progress, then an event line, and waits.
 */
const FAKE_NERA = `
const fs = require('node:fs')
const { spawn } = require('node:child_process')
const [command, ...args] = process.argv.slice(2)
const config = fs.existsSync('fake.json') ? JSON.parse(fs.readFileSync('fake.json', 'utf8')) : {}
fs.appendFileSync('calls.log', JSON.stringify({ command, args, browser: process.env.BROWSER ?? null }) + '\\n')
const stayUp = () => setInterval(() => {}, 1000)
if (config.grandchild) {
    const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    fs.writeFileSync('grandchild.pid', String(child.pid))
}
if (command === 'dev') {
    const port = args[args.indexOf('--port') + 1]
    if (config.dev === 'crash') {
        console.error('❌ Layout "pages/missing.pug" not found')
        process.exit(1)
    }
    if (config.dev !== 'silent') setTimeout(() => console.log('\\n  \\u001b[32m➜\\u001b[39m  Local:   http://localhost:' + port + '/\\n  ➜  Network: use --host to expose'), 50)
    stayUp()
}
if (command === 'publish') {
    console.error('Nera publishes through "Nera Static", a GitHub App run by Michael Becker.')
    if (config.publish === 'crash') {
        console.error('❌ Cannot find module keyring')
        process.exit(1)
    }
    if (config.publish === 'fail') {
        console.log(JSON.stringify({ ok: false, error: 'The deploy failed', repository: 'octo/site', deploy: { hint: 'Fix the build, then publish again.' } }))
        process.exit(1)
    }
    if (config.publish === 'slow') {
        console.error('Creating the public repository site on GitHub…')
        console.error(JSON.stringify({ event: 'action_done', kind: 'github_app_install' }))
        stayUp()
    }
    if (config.publish === 'sign-in') {
        console.error('To sign in to GitHub, enter the code WDJB-MJHT at https://github.com/login/device')
        console.error(JSON.stringify({ event: 'action_required', action: { kind: 'github_sign_in', code: 'WDJB-MJHT', url: 'https://github.com/login/device' } }))
        console.error('Waiting for you to authorize Nera Static on GitHub…')
        const poll = setInterval(() => {
            if (!fs.existsSync('authorized')) return
            clearInterval(poll)
            console.error('Signed in as octo')
            console.error(JSON.stringify({ event: 'action_done', kind: 'github_sign_in' }))
            console.log(JSON.stringify({ ok: true, url: 'https://octo.github.io/site/', repository: 'octo/site', sha: 'abc123', run: 'https://github.com/octo/site/actions/runs/1' }))
        }, 20)
    }
}
`

let env
let mcp
let processes

async function configure(fake) {
    await writeFiles(env.site, { 'fake.json': JSON.stringify(fake) })
}

async function callsLog() {
    try {
        return (await fs.readFile(path.join(env.site, 'calls.log'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    } catch {
        return []
    }
}

function isAlive(pid) {
    try {
        process.kill(pid, 0)
        return true
    } catch {
        return false
    }
}

async function waitUntil(check, ms = 5000) {
    const end = Date.now() + ms
    while (Date.now() < end) {
        if (await check()) return true
        await new Promise((resolve) => setTimeout(resolve, 20))
    }
    return check()
}

beforeEach(async () => {
    env = await makeRoot()
    // a CommonJS script: the site package is `type: module`, its node_modules copy is not
    await writeFiles(env.site, {
        'node_modules/@nera-static/nera/package.json': '{"name":"@nera-static/nera"}',
        'node_modules/@nera-static/nera/bin/nera.js': FAKE_NERA,
    })
    processes = createProcesses({ grace: 200 })
    mcp = await connect(env.root, { processes, timing: { previewStartMs: 1500, publishWaitMs: 1500 } })
})

afterEach(async () => {
    await mcp.close()
    await processes.stopAll()
    await env.cleanup()
})

describe('preview', () => {
    it('starts nera dev on a free port without opening a browser and returns its URL', async () => {
        await configure({ dev: 'serve' })
        const result = await mcp.call('preview', { site: 'site' })

        expect(result.isError).toBeFalsy()
        const [call] = await callsLog()
        expect(call).toMatchObject({ command: 'dev', browser: 'none' })
        expect(call.args[0]).toBe('--port')
        const port = Number(call.args[1])
        expect(port).toBeGreaterThan(0)
        expect(result.structuredContent).toEqual({ site: 'site', url: `http://localhost:${port}/`, reused: false })
        expect(textOf(result)).toContain(`http://localhost:${port}/`)
    })

    it('reuses the running server on a second call', async () => {
        await configure({ dev: 'serve' })
        const first = await mcp.call('preview', { site: 'site' })
        const second = await mcp.call('preview', { site: './site/' })

        expect(second.structuredContent).toEqual({ ...first.structuredContent, reused: true })
        expect(await callsLog()).toHaveLength(1)
    })

    it('starts one server when two calls for the same site arrive together', async () => {
        await configure({ dev: 'serve' })
        const [a, b] = await Promise.all([mcp.call('preview', { site: 'site' }), mcp.call('preview', { site: 'site' })])

        expect(a.structuredContent.url).toBe(b.structuredContent.url)
        expect([a.structuredContent.reused, b.structuredContent.reused].sort()).toEqual([false, true])
        expect(await callsLog()).toHaveLength(1)
    })

    it('reports a server that dies before it prints an address, with its error', async () => {
        await configure({ dev: 'crash' })
        const result = await mcp.call('preview', { site: 'site' })

        expect(result.isError).toBe(true)
        expect(textOf(result)).toMatch(/^The preview of "site" stopped: ❌ Layout "pages\/missing.pug" not found\nCall validate/)
        // the dead run is not kept: the next call starts again
        await configure({ dev: 'serve' })
        expect((await mcp.call('preview', { site: 'site' })).isError).toBeFalsy()
        expect(await callsLog()).toHaveLength(2)
    })

    it('stops a server that prints no address in time instead of hanging', async () => {
        await configure({ dev: 'silent' })
        const started = Date.now()
        const result = await mcp.call('preview', { site: 'site' })

        expect(Date.now() - started).toBeLessThan(5000)
        expect(result.isError).toBe(true)
        expect(textOf(result)).toMatch(/printed no address within 1.5 s and was stopped/)
        expect(processes.get(`preview:${env.site}`)).toBeUndefined()
    })

    it('stops the running server with stop: true', async () => {
        await configure({ dev: 'serve' })
        await mcp.call('preview', { site: 'site' })
        const run = processes.get(`preview:${env.site}`)

        const stopped = await mcp.call('preview', { site: 'site', stop: true })
        expect(stopped.structuredContent).toEqual({ site: 'site', stopped: true })
        expect(run.exited).toBe(true)
        const again = await mcp.call('preview', { site: 'site', stop: true })
        expect(again.structuredContent).toEqual({ site: 'site', stopped: false })
        expect(textOf(again)).toBe('No preview of "site" was running.')
    })
})

describe('publish', () => {
    it('returns the GitHub sign-in code first and the CLI\'s JSON result on a later call', async () => {
        await configure({ publish: 'sign-in' })
        const first = await mcp.call('publish', { site: 'site' })

        expect(first.isError).toBeFalsy()
        expect(first.structuredContent).toEqual({
            site: 'site',
            state: 'action_required',
            action: { kind: 'github_sign_in', code: 'WDJB-MJHT', url: 'https://github.com/login/device' },
        })
        expect(textOf(first)).toBe('Publishing "site" waits for the user. Ask the user to open https://github.com/login/device and enter the code WDJB-MJHT, then call publish again.')

        await writeFiles(env.site, { authorized: '' })
        const second = await mcp.call('publish', { site: 'site' })
        expect(second.structuredContent).toEqual({
            site: 'site',
            state: 'published',
            result: { ok: true, url: 'https://octo.github.io/site/', repository: 'octo/site', sha: 'abc123', run: 'https://github.com/octo/site/actions/runs/1' },
        })
        expect(textOf(second)).toBe('"site" is live at https://octo.github.io/site/.')
        const calls = await callsLog()
        expect(calls).toHaveLength(1)
        expect(calls[0]).toMatchObject({ command: 'publish', args: ['--yes', '--json'] })

        // the finished run was reported once; the next call publishes again
        await mcp.call('publish', { site: 'site' })
        expect(await callsLog()).toHaveLength(2)
    })

    it('passes target, repo, domain and private to nera publish', async () => {
        await configure({ publish: 'fail' })
        await mcp.call('publish', { site: 'site', target: 'netlify', repo: 'my-site', domain: 'www.example.com', private: true })
        const [call] = await callsLog()
        expect(call.args).toEqual(['--yes', '--json', '--target=netlify', '--repo=my-site', '--domain=www.example.com', '--private'])
    })

    it('refuses an unknown target and a repository name with a slash', async () => {
        for (const args of [{ target: 'vercel' }, { repo: 'octo/site' }, { repo: '../x' }]) {
            const result = await mcp.call('publish', { site: 'site', ...args })
            expect(result.isError, JSON.stringify(args)).toBe(true)
        }
        expect(await callsLog()).toEqual([])
    })

    it('reports a failed publish with the CLI\'s error, hint and object', async () => {
        await configure({ publish: 'fail' })
        const result = await mcp.call('publish', { site: 'site' })
        expect(result.isError).toBe(true)
        expect(textOf(result)).toBe('Publishing "site" failed: The deploy failed. Fix the build, then publish again.\n{"ok":false,"error":"The deploy failed","repository":"octo/site","deploy":{"hint":"Fix the build, then publish again."}}')
    })

    it('reports a CLI that dies without a result instead of waiting for it', async () => {
        await configure({ publish: 'crash' })
        const started = Date.now()
        const result = await mcp.call('publish', { site: 'site' })
        expect(Date.now() - started).toBeLessThan(1500)
        expect(result.isError).toBe(true)
        expect(textOf(result)).toMatch(/^Publishing "site" stopped without a result: .*❌ Cannot find module keyring$/s)
    })

    it('says it is still running, with the last progress line and not an event line, when nothing needs the user', async () => {
        await configure({ publish: 'slow' })
        await mcp.call('publish', { site: 'site' })
        const run = processes.get(`publish:${env.site}`)
        expect(await waitUntil(() => run.stderr.includes('"action_done"'))).toBe(true)

        const result = await mcp.call('publish', { site: 'site' })
        expect(result.structuredContent).toEqual({ site: 'site', state: 'running', progress: 'Creating the public repository site on GitHub…' })
        expect(run.exited).toBe(false)
    })
})

describe('closing the server', () => {
    it('stops the preview and the publish, and what they started, even when it ignores SIGTERM', async () => {
        await configure({ dev: 'serve', publish: 'slow', grandchild: true })
        await mcp.call('preview', { site: 'site' })
        const grandchild = Number(await fs.readFile(path.join(env.site, 'grandchild.pid'), 'utf8'))
        await mcp.call('publish', { site: 'site' })
        const preview = processes.get(`preview:${env.site}`)
        const publish = processes.get(`publish:${env.site}`)

        expect(isAlive(grandchild)).toBe(true)
        await mcp.close()

        expect(await preview.waitFor((r) => r.exited, 5000)).toBe(true)
        expect(await publish.waitFor((r) => r.exited, 5000)).toBe(true)
        expect(await waitUntil(() => !isAlive(grandchild))).toBe(true)
    })
})

describe('stopping on Windows', () => {
    it('stopAll ends each tracked tree with taskkill /T /F, never through a process group', async () => {
        const { spawn, taskkills } = fakeWindowsSpawn()
        const windows = createProcesses({ spawn, platform: 'win32', grace: 5000 })
        const script = ['-e', 'setInterval(() => {}, 1000)']
        const first = windows.start('a', 'node', script, { cwd: env.site })
        const second = windows.start('b', 'node', script, { cwd: env.site })
        const kill = vi.spyOn(process, 'kill')

        await windows.stopAll()
        kill.mockRestore()

        expect(first.exited && second.exited).toBe(true)
        expect(taskkills.map(({ args }) => args)).toEqual([
            ['/pid', String(first.child.pid), '/T', '/F'],
            ['/pid', String(second.child.pid), '/T', '/F'],
        ])
        expect(taskkills.every(({ options }) => options.shell === false && options.stdio === 'ignore')).toBe(true)
        expect(kill.mock.calls.filter(([target]) => target < 0)).toEqual([])
    })
})

describe('the root guard on preview and publish', () => {
    it.each(['preview', 'publish'])('%s refuses `..`, an outside path, a symlink escape and a folder that is no site', async (name) => {
        await writeFiles(env.outside, { 'package.json': siteFiles()['package.json'] })
        await fs.symlink(env.outside, path.join(env.root, 'linked'))
        for (const site of ['../outside', env.outside, 'linked']) {
            const result = await mcp.call(name, { site })
            expect(result.isError, site).toBe(true)
            expect(textOf(result)).toMatch(/contains "\.\."|leads outside/)
        }
        await writeFiles(path.join(env.root, 'other'), { 'package.json': '{"name":"other"}' })
        expect(textOf(await mcp.call(name, { site: 'other' }))).toMatch(/is not a Nera site/)
        expect(await callsLog()).toEqual([])
    })
})

describe('pendingAction', () => {
    const required = (action) => `${JSON.stringify({ event: 'action_required', action })}\n`
    const done = (kind) => `${JSON.stringify({ event: 'action_done', kind })}\n`
    const signIn = { kind: 'github_sign_in', code: 'ABCD-1234', url: 'https://github.com/login/device' }
    const install = { kind: 'github_app_install', url: 'https://github.com/apps/nera-static/installations/new' }
    const netlify = { kind: 'netlify_sign_in', url: 'https://app.netlify.com/authorize?response_type=ticket&ticket=t1' }

    it('reads the last action_required until an action_done of its kind', () => {
        expect(pendingAction('Creating…\n')).toBeNull()
        expect(pendingAction(required(signIn))).toEqual(signIn)
        expect(pendingAction(`${required(signIn)}Signed in as octo\n${done('github_sign_in')}`)).toBeNull()
        expect(pendingAction(`${required(signIn)}${done('github_sign_in')}${required(install)}`)).toEqual(install)
        expect(pendingAction(`${required(install)}${done('github_app_install')}`)).toBeNull()
        expect(pendingAction(required(netlify))).toEqual(netlify)
    })

    it('clears a pending action only with an action_done of the same kind', () => {
        expect(pendingAction(`${required(signIn)}${done('github_app_install')}`)).toEqual(signIn)
        expect(pendingAction(`${required(install)}${done('netlify_sign_in')}${done('nonsense')}`)).toEqual(install)
    })

    it('reads nothing from the CLI\'s log lines alone', () => {
        expect(pendingAction('To sign in to GitHub, enter the code ABCD-1234 at https://github.com/login/device\n')).toBeNull()
        expect(pendingAction('Install it at https://github.com/apps/nera-static/installations/new\n')).toBeNull()
        expect(pendingAction('To sign in to Netlify, open https://app.netlify.com/authorize?ticket=t1 and choose "Authorize".\n')).toBeNull()
    })

    it('ignores an event of an unknown kind, a foreign host, a bad code or a broken line', () => {
        const ignored = [
            required({ kind: 'paypal_sign_in', url: 'https://github.com/x' }),
            required({ kind: 'toString', url: 'https://github.com/x' }),
            required({ ...signIn, url: 'https://evil.example/device' }),
            required({ ...signIn, url: 'http://github.com/login/device' }),
            required({ ...signIn, url: 'https://github.com.evil.example/login/device' }),
            required({ ...install, url: 'https://github.com/apps/x y' }),
            required({ ...netlify, url: 'https://github.com/authorize' }),
            required({ ...signIn, code: 'ghp_secret' }),
            required({ kind: 'github_sign_in', url: signIn.url }),
            `${JSON.stringify({ event: 'action_required' })}\n`,
            `${JSON.stringify({ event: 'action_required', action: null })}\n`,
            `${JSON.stringify({ action: signIn })}\n`,
            '{"event":"action_required","action":{"kind":"github_sign_in"\n',
            '{not json\n',
            'null\n',
            'token: gho_abcdefABCDEF1234\n',
        ]
        for (const line of ignored) expect(pendingAction(line), line).toBeNull()
        // an ignored event leaves the pending one standing
        expect(pendingAction(`${required(install)}${ignored.join('')}`)).toEqual(install)
    })

    it('returns only kind, code and url, whatever else the event carries', () => {
        expect(pendingAction(required({ ...signIn, device_code: 'secret', extra: 1 }))).toEqual(signIn)
        expect(pendingAction(required({ ...install, code: 'ABCD-1234' }))).toEqual(install)
    })
})

describe('previewUrl', () => {
    it('reads Vite\'s Local address, with or without colour codes', () => {
        expect(previewUrl('  \u001b[32m➜\u001b[39m  \u001b[1mLocal\u001b[22m:   \u001b[36mhttp://localhost:\u001b[1m3001\u001b[22m/\u001b[39m\n')).toBe('http://localhost:3001/')
        expect(previewUrl('building…\n')).toBeNull()
    })
})
