import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createSite, validate } from '@nera-static/nera'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { activateShim } from '../src/runtime.js'
import { connect, makeRoot, siteFiles, textOf, writeFiles } from './helpers.js'

let env
let mcp
let calls
let respond
let signals
let created

/** A fake runner: records every call, answers with `respond(call)` (default: success, no output). */
async function fakeRunner(command, args, options) {
    const call = { command, args, cwd: options.cwd }
    calls.push(call)
    signals.push(options.signal)
    return { code: 0, stdout: '', stderr: '', timedOut: false, ...(await respond(call)) }
}

/**
 * The CLI's real createSite without its npm install (no network): records the
 * options the tool passes, then writes the site with `install: false`.
 */
async function offlineCreateSite(name, options) {
    created.push({ projectName: name, ...options })
    return createSite(name, { ...options, install: false })
}

beforeEach(async () => {
    env = await makeRoot()
    calls = []
    signals = []
    created = []
    respond = async () => ({})
    mcp = await connect(env.root, { runner: fakeRunner, createSite: offlineCreateSite })
})

afterEach(async () => {
    activateShim(null)
    await mcp.close()
    await env.cleanup()
})

const exists = (file) => fs.access(file).then(() => true, () => false)

describe('create_site', () => {
    const STARTER = {
        'package.json': JSON.stringify({
            name: 'starter-mine',
            nera: { starter: { label: 'Mine' } },
            dependencies: { '@nera-static/nera': '^1.0.0', '@nera-static/plugin-tags': '^3.0.0' },
        }),
        'pages/index.md': '---\nlayout: pages/default.pug\ntitle: Mine\n---\n# Mine\n',
        'README.md': '# Mine\n\n## First steps\n\n1. Edit pages/index.md.\n\n## More\n\nNot this.\n',
    }
    const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'))

    it('writes and installs the site with the CLI\'s createSite, with the call\'s signal and nothing through the runner', async () => {
        const result = await mcp.call('create_site', { name: 'my-bakery', title: 'Bakery: "Brot"', lang: 'de' })
        expect(result.isError).toBeUndefined()
        const dir = path.join(env.root, 'my-bakery')
        expect(await exists(path.join(dir, 'pages/index.md'))).toBe(true)
        expect(await exists(path.join(dir, 'AGENTS.md'))).toBe(true)
        const appYaml = await fs.readFile(path.join(dir, 'config/app.yaml'), 'utf8')
        expect(appYaml).toMatch(/^name: "Bakery: \\"Brot\\""$/m)
        expect(appYaml).toMatch(/^lang: de$/m)
        expect((await readJson(path.join(dir, 'package.json'))).name).toBe('my-bakery')
        expect(calls).toEqual([])
        expect(created).toHaveLength(1)
        expect(created[0]).toMatchObject({ projectName: 'my-bakery', cwd: env.root, install: true, name: 'Bakery: "Brot"', lang: 'de' })
        expect(created[0].signal).toBeInstanceOf(AbortSignal)
        expect(created[0].env.PATH).toBe(process.env.PATH)
        expect(created[0].log).toBeTypeOf('function')
        // No `stdio`: npm install's output goes where the CLI's createSite sends it, to stderr.
        expect(created[0]).not.toHaveProperty('stdio')
        expect(result.structuredContent).toMatchObject({ site: 'my-bakery', firstSteps: null })
        expect(result.structuredContent.log).toMatch(/Creating a new Nera site/)
        expect(textOf(result)).toMatch(/get_site/)
    })

    it('hands a theme to createSite, whose own install turns its `latest` placeholder into a range', async () => {
        const result = await mcp.call('create_site', { name: 'blog', theme: 'blog' })
        expect(result.isError).toBeUndefined()
        expect(created[0]).toMatchObject({ theme: 'blog', install: true })
        expect((await readJson(path.join(env.root, 'blog', 'package.json'))).dependencies['@nera-static/theme-blog']).toBe('latest')
        expect(calls).toEqual([])
    })

    it('gives createSite a child\'s env: the bundled runtime\'s shim folder first on the PATH', async () => {
        activateShim('/shim')
        const result = await mcp.call('create_site', { name: 'bundled' })
        expect(result.isError).toBeUndefined()
        const delimiter = process.platform === 'win32' ? ';' : ':'
        const pathOf = (vars) => Object.entries(vars).find(([key]) => key.toUpperCase() === 'PATH')[1]
        expect(pathOf(created[0].env).split(delimiter)[0]).toBe('/shim')
        expect(created[0].env.NO_COLOR).toBe('1')
        expect(pathOf(process.env).split(delimiter)[0]).not.toBe('/shim')
    })

    it('aborts createSite when the call is cancelled', async () => {
        let seen
        await mcp.close()
        mcp = await connect(env.root, {
            runner: fakeRunner,
            createSite: (name, options) => new Promise((resolve, reject) => {
                seen = options.signal
                options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
            }),
        })
        const controller = new AbortController()
        const pending = mcp.client.callTool({ name: 'create_site', arguments: { name: 'cancelled' } }, undefined, { signal: controller.signal })
        await vi.waitFor(() => expect(seen).toBeInstanceOf(AbortSignal))
        controller.abort()
        await expect(pending).rejects.toThrow()
        await vi.waitFor(() => expect(seen.aborted).toBe(true))
        expect(calls).toEqual([])
    })

    it('applies a starter folder inside the root and returns its first steps', async () => {
        await writeFiles(path.join(env.root, 'starters', 'mine'), STARTER)
        const result = await mcp.call('create_site', { name: 'a', starter: `${env.root}/starters/mine` })
        expect(result.isError).toBeUndefined()
        const dir = path.join(env.root, 'a')
        expect(await fs.readFile(path.join(dir, 'pages/index.md'), 'utf8')).toMatch(/# Mine/)
        expect((await readJson(path.join(dir, 'package.json'))).dependencies['@nera-static/plugin-tags']).toBe('^3.0.0')
        expect(result.structuredContent.firstSteps).toBe('## First steps\n\n1. Edit pages/index.md.')
        expect(textOf(result)).toMatch(/first steps \(in firstSteps\)/)
        expect(calls).toEqual([])
    })

    it('hands package and GitHub starters to createSite unchanged, with the root as cwd', async () => {
        const received = []
        await mcp.close()
        mcp = await connect(env.root, {
            runner: fakeRunner,
            createSite: async (name, options) => {
                received.push({ name, ...options })
                const dir = path.join(options.cwd, name)
                await writeFiles(dir, siteFiles())
                return { dir, firstSteps: null }
            },
        })
        for (const starter of ['business', '@nera-static/starter-blog', 'github:owner/repo#v1', 'https://github.com/owner/repo']) {
            const result = await mcp.call('create_site', { name: `s${received.length}`, starter })
            expect(result.isError, starter).toBeUndefined()
        }
        expect(received.map((r) => r.starter)).toEqual(['business', '@nera-static/starter-blog', 'github:owner/repo#v1', 'https://github.com/owner/repo'])
        for (const options of received) {
            expect(options).toMatchObject({ cwd: env.root, install: true })
            expect(options.log).toBeTypeOf('function')
        }
    })

    it('creates the site in the root itself for `.`, which must be empty', async () => {
        const empty = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nera-mcp-empty-')))
        const inRoot = await connect(empty, { runner: fakeRunner, createSite: offlineCreateSite })
        try {
            const result = await inRoot.call('create_site', { name: '.' })
            expect(result.isError).toBeUndefined()
            expect(result.structuredContent.site).toBe('.')
            expect(await exists(path.join(empty, 'package.json'))).toBe(true)
            expect(created[0]).toMatchObject({ projectName: '.', cwd: empty, install: true })
        } finally {
            await inRoot.close()
            await fs.rm(empty, { recursive: true, force: true })
        }
    })

    it('reports createSite\'s refusal of `.` in a root that is not empty', async () => {
        const result = await mcp.call('create_site', { name: '.' })
        expect(result.isError).toBe(true)
        expect(textOf(result)).toMatch(/^Creating the site failed: The current folder is not empty \(site\)/)
        expect(calls).toEqual([])
    })

    it('writes nothing to stdout: every progress line lands in the result', async () => {
        await writeFiles(path.join(env.root, 'starters', 'mine'), STARTER)
        const stdout = vi.spyOn(process.stdout, 'write')
        const log = vi.spyOn(console, 'log')
        try {
            const result = await mcp.call('create_site', { name: 'quiet', starter: './starters/mine' })
            expect(result.isError).toBeUndefined()
            expect(result.structuredContent.log).toMatch(/Applied the "Mine" starter/)
            expect(stdout).not.toHaveBeenCalled()
            expect(log).not.toHaveBeenCalled()
        } finally {
            stdout.mockRestore()
            log.mockRestore()
        }
    })

    it.each([
        ['../escape', /Invalid site folder/],
        ['a/b', /Invalid site folder/],
        [env => env.outside, /Invalid site folder/],
        ['--starter=evil', /Invalid site folder/],
        ['site', /already exists/],
    ])('refuses the target %s', async (name, message) => {
        const result = await mcp.call('create_site', { name: typeof name === 'function' ? name(env) : name })
        expect(result.isError).toBe(true)
        expect(textOf(result)).toMatch(message)
        expect(calls).toEqual([])
    })

    it('refuses a name that is a symbolic link leading out of the root', async () => {
        await fs.symlink(env.outside, path.join(env.root, 'linked'))
        const result = await mcp.call('create_site', { name: 'linked' })
        expect(result.isError).toBe(true)
        expect(calls).toEqual([])
    })

    it.each([
        ['../outside', /contains "\.\."/],
        [env => env.outside, /leads outside/],
        ['--yes', /Invalid starter/],
    ])('refuses the starter %s', async (starter, message) => {
        const result = await mcp.call('create_site', { name: 'new', starter: typeof starter === 'function' ? starter(env) : starter })
        expect(result.isError).toBe(true)
        expect(textOf(result)).toMatch(message)
        expect(calls).toEqual([])
        expect(await exists(path.join(env.root, 'new'))).toBe(false)
    })

    it('refuses a theme that is not a package name', async () => {
        const result = await mcp.call('create_site', { name: 'new', theme: '../outside' })
        expect(result.isError).toBe(true)
        expect(textOf(result)).toMatch(/Invalid theme/)
        expect(calls).toEqual([])
    })

    it.each([
        [{ lang: 'xx_' }, /^Creating the site failed: Invalid language "xx_"/],
        [{ starter: 'blog', theme: 'blog' }, /^Creating the site failed: A starter brings its own theme/],
        [{ starter: './starters/none' }, /^Creating the site failed: Starter folder "\.\/starters\/none" not found/],
    ])('reports the CLI\'s refusal of %o and writes nothing', async (options, message) => {
        const result = await mcp.call('create_site', { name: 'new', ...options })
        expect(result.isError).toBe(true)
        expect(textOf(result)).toMatch(message)
        expect(calls).toEqual([])
        expect(await exists(path.join(env.root, 'new'))).toBe(false)
    })

    it('reports a failed npm install, which keeps the written site', async () => {
        await mcp.close()
        mcp = await connect(env.root, {
            runner: fakeRunner,
            createSite: async (name, options) => {
                await createSite(name, { ...options, install: false })
                throw Object.assign(new Error('Command failed: npm install (exit code 1)'), { code: 1 })
            },
        })
        const result = await mcp.call('create_site', { name: 'offline' })
        expect(result.isError).toBe(true)
        expect(textOf(result)).toMatch(/^The files of the site "offline" are written, but installing its packages failed: Command failed: npm install \(exit code 1\)\nnpm's own output is in the server's log\. Fix what npm reports/)
    })

    it('reports a failure before the install as the site not being created', async () => {
        await mcp.close()
        mcp = await connect(env.root, {
            runner: fakeRunner,
            createSite: async () => {
                throw Object.assign(new Error('Command failed: npm pack @nera-static/starter-blog (exit code 1)'), { code: 1 })
            },
        })
        const result = await mcp.call('create_site', { name: 'nopack', starter: 'blog' })
        expect(result.isError).toBe(true)
        expect(textOf(result)).toMatch(/^Creating the site failed: Command failed: npm pack/)
    })
})

describe('build', () => {
    const records = [
        { file: 'public/index.html', line: 3, severity: 'error', rule: 'a11y-img-alt', message: 'image has no alt text' },
        { file: 'public/index.html', line: null, severity: 'warning', rule: 'privacy-external-font', message: 'font from a third party' },
    ]

    it('runs `nera build --json` in the site and returns its result', async () => {
        respond = async () => ({ stdout: '{\n  "ok": true,\n  "results": []\n}\n', stderr: 'Built 1 page\n' })
        const result = await mcp.call('build', { site: 'site' })
        expect(calls).toEqual([{ command: 'nera', args: ['build', '--json'], cwd: env.site }])
        expect(result.isError).toBeUndefined()
        expect(result.structuredContent).toEqual({ site: 'site', ok: true, results: [] })
    })

    it('returns the output check\'s records unchanged with check: true', async () => {
        respond = async () => ({ code: 1, stdout: JSON.stringify({ ok: false, results: records }) })
        const result = await mcp.call('build', { site: './site/', check: true })
        expect(calls[0].args).toEqual(['build', '--json', '--check'])
        expect(result.isError).toBeUndefined()
        expect(result.structuredContent).toEqual({ site: 'site', ok: false, results: records })
        expect(textOf(result)).toMatch(/1 error\(s\) and 1 warning\(s\)/)
    })

    it('reports a build that threw, with the end of its log', async () => {
        respond = async () => ({ code: 1, stdout: '{"ok":false,"error":"layout not found","results":[]}', stderr: 'rendering index.md\n' })
        const result = await mcp.call('build', { site: 'site' })
        expect(result.isError).toBe(true)
        expect(textOf(result)).toMatch(/failed: layout not found\. Call validate.*\nBuild log:\nrendering index\.md$/s)
    })

    it('reports a CLI that printed no JSON', async () => {
        respond = async () => ({ code: 1, stdout: 'Usage: nera …', stderr: '' })
        const result = await mcp.call('build', { site: 'site' })
        expect(result.isError).toBe(true)
        expect(textOf(result)).toMatch(/gave no result: Usage: nera …/)
    })
})

describe('validate', () => {
    it('returns the validator\'s records unchanged, without running anything', async () => {
        await writeFiles(env.site, {
            'pages/draft.md': '---\ntitle: Draft\n---\nNo layout.\n',
            'pages/broken.md': '---\nlayout: pages/missing.pug\n---\n',
        })
        const result = await mcp.call('validate', { site: 'site' })
        const expected = validate({ cwd: env.site })
        expect(expected.map((r) => r.rule).sort()).toEqual(['layout-missing', 'layout-unresolved'])
        expect(result.isError).toBeUndefined()
        expect(result.structuredContent).toEqual({ site: 'site', ok: false, results: expected })
        expect(calls).toEqual([])
    })

    it('says a clean site is valid', async () => {
        const result = await mcp.call('validate', { site: 'site' })
        expect(result.structuredContent).toEqual({ site: 'site', ok: true, results: [] })
        expect(textOf(result)).toMatch(/is valid/)
    })
})

describe('add_plugin', () => {
    const pluginDir = () => path.join(env.site, 'node_modules', '@nera-static', 'plugin-tags')

    beforeEach(() => {
        // `npm install @nera-static/plugin-tags` leaves the package in node_modules.
        respond = async ({ command }) => {
            if (command !== 'npm') return {}
            await writeFiles(pluginDir(), {
                'package.json': JSON.stringify({ name: '@nera-static/plugin-tags', bin: { 'nera-tags': './bin/publish-template.js' } }),
                'config/tags.yaml': 'meta_property_name: tags\n',
                'bin/publish-template.js': '',
            })
            return { stdout: 'added 1 package\n' }
        }
    })

    it('installs the plugin, copies its default config and publishes its templates', async () => {
        const result = await mcp.call('add_plugin', { site: 'site', plugin: 'tags' })
        expect(result.isError).toBeUndefined()
        expect(calls).toEqual([
            { command: 'npm', args: ['install', '@nera-static/plugin-tags'], cwd: env.site },
            { command: 'node', args: [path.join(pluginDir(), 'bin', 'publish-template.js')], cwd: env.site },
        ])
        expect(await fs.readFile(path.join(env.site, 'config', 'tags.yaml'), 'utf8')).toBe('meta_property_name: tags\n')
        expect(result.structuredContent).toEqual({
            site: 'site',
            plugin: '@nera-static/plugin-tags',
            config: { file: 'config/tags.yaml', status: 'copied' },
            templates: 'published',
            log: 'added 1 package',
        })
    })

    it('keeps the site\'s own config and skips templates when the plugin ships none', async () => {
        await writeFiles(env.site, { 'config/tags.yaml': 'mine: true\n' })
        respond = async () => {
            await writeFiles(pluginDir(), { 'package.json': '{"name":"@nera-static/plugin-tags"}', 'config/tags.yaml': 'x: 1\n' })
            return {}
        }
        const result = await mcp.call('add_plugin', { site: 'site', plugin: '@nera-static/plugin-tags' })
        expect(await fs.readFile(path.join(env.site, 'config', 'tags.yaml'), 'utf8')).toBe('mine: true\n')
        expect(result.structuredContent.config).toEqual({ file: 'config/tags.yaml', status: 'kept' })
        expect(result.structuredContent.templates).toBe('none')
        expect(calls.map((c) => c.command)).toEqual(['npm'])
    })

    it('refuses a template script that leads outside the site', async () => {
        respond = async ({ command }) => {
            if (command === 'npm') {
                await writeFiles(pluginDir(), { 'package.json': JSON.stringify({ bin: { x: '../../../../outside/publish-template.js' } }) })
            }
            return {}
        }
        const result = await mcp.call('add_plugin', { site: 'site', plugin: 'tags' })
        expect(result.isError).toBe(true)
        expect(textOf(result)).toMatch(/plugin template script/)
        expect(calls.map((c) => c.command)).toEqual(['npm'])
    })

    it.each(['lodash@4', '@other/plugin-tags', 'tags@3.0.0', 'utils', '@nera-static/plugin-utils', '../outside', 'file:../outside', 'Tags', ''])(
        'refuses %j before running anything',
        async (plugin) => {
            const result = await mcp.call('add_plugin', { site: 'site', plugin })
            expect(result.isError).toBe(true)
            expect(textOf(result)).toMatch(/is not a Nera plugin/)
            expect(calls).toEqual([])
        },
    )

    it('reports a failed npm install', async () => {
        respond = async () => ({ code: 1, stderr: 'npm error 404 Not Found\n' })
        const result = await mcp.call('add_plugin', { site: 'site', plugin: 'nope' })
        expect(result.isError).toBe(true)
        expect(textOf(result)).toBe('Installing @nera-static/plugin-nope failed: npm error 404 Not Found')
        expect(await exists(path.join(env.site, 'config', 'nope.yaml'))).toBe(false)
    })
})

describe('cancelling', () => {
    it('hands every command the request\'s abort signal, so a cancelled call or a closing server stops it', async () => {
        await writeFiles(path.join(env.site, 'node_modules/@nera-static/plugin-tags'), { 'package.json': '{"bin":{"x":"bin/publish-template.js"}}', 'bin/publish-template.js': '' })
        respond = async ({ command }) => (command === 'nera' ? { stdout: '{"ok":true,"results":[]}' } : {})
        await mcp.call('create_site', { name: 'new-site' })
        await mcp.call('build', { site: 'site' })
        await mcp.call('add_plugin', { site: 'site', plugin: 'tags' })
        expect(created[0].signal).toBeInstanceOf(AbortSignal)
        expect(calls.map((c) => `${c.command} ${c.args[0]}`)).toEqual(['nera build', 'npm install', `node ${path.join(env.site, 'node_modules/@nera-static/plugin-tags/bin/publish-template.js')}`])
        for (const signal of signals) expect(signal).toBeInstanceOf(AbortSignal)
    })
})

describe('the root guard on build, validate and add_plugin', () => {
    const tools = [['build', {}], ['validate', {}], ['add_plugin', { plugin: 'tags' }]]

    it.each(tools)('%s refuses `..`, an outside path and a symlink escape', async (name, extra) => {
        await writeFiles(env.outside, { 'package.json': siteFiles()['package.json'] })
        await fs.symlink(env.outside, path.join(env.root, 'linked'))
        for (const site of ['../outside', env.outside, 'linked']) {
            const result = await mcp.call(name, { site, ...extra })
            expect(result.isError, site).toBe(true)
            expect(textOf(result)).toMatch(/contains "\.\."|leads outside/)
        }
        expect(calls).toEqual([])
    })

    it.each(tools)('%s refuses a folder that is no Nera site', async (name, extra) => {
        await writeFiles(path.join(env.root, 'other'), { 'package.json': '{"name":"other"}' })
        const result = await mcp.call(name, { site: 'other', ...extra })
        expect(result.isError).toBe(true)
        expect(textOf(result)).toMatch(/is not a Nera site/)
        expect(calls).toEqual([])
    })
})
