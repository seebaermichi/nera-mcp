import fs from 'node:fs/promises'
import path from 'node:path'
import { validateSite } from '@nera-static/validate'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { connect, makeRoot, siteFiles, textOf, writeFiles } from './helpers.js'

let env
let mcp
let calls
let respond

/** A fake runner: records every call, answers with `respond(call)` (default: success, no output). */
async function fakeRunner(command, args, options) {
    const call = { command, args, cwd: options.cwd }
    calls.push(call)
    return { code: 0, stdout: '', stderr: '', timedOut: false, ...(await respond(call)) }
}

beforeEach(async () => {
    env = await makeRoot()
    calls = []
    respond = async () => ({})
    mcp = await connect(env.root, { runner: fakeRunner })
})

afterEach(async () => {
    await mcp.close()
    await env.cleanup()
})

const exists = (file) => fs.access(file).then(() => true, () => false)

describe('create_site', () => {
    beforeEach(() => {
        // `nera new <name>` leaves a site in <cwd>/<name>.
        respond = async ({ args, cwd }) => {
            await writeFiles(path.join(cwd, args[1]), siteFiles())
            return { stdout: 'Created my-bakery\n## First steps\n' }
        }
    })

    it('runs `nera new` in the root with the options as separate --flag=value arguments', async () => {
        const result = await mcp.call('create_site', {
            name: 'my-bakery', starter: 'business', title: 'Bakery; rm -rf ~', lang: 'de',
        })
        expect(result.isError).toBeUndefined()
        expect(calls).toEqual([{
            command: 'nera',
            args: ['new', 'my-bakery', '--yes', '--starter=business', '--name=Bakery; rm -rf ~', '--lang=de'],
            cwd: env.root,
        }])
        expect(result.structuredContent).toEqual({ site: 'my-bakery', log: 'Created my-bakery\n## First steps' })
        expect(textOf(result)).toMatch(/get_site/)
    })

    it('passes a theme, and a starter folder inside the root relative to it', async () => {
        await writeFiles(path.join(env.root, 'starters', 'mine'), { 'package.json': '{}' })
        await mcp.call('create_site', { name: 'a', starter: `${env.root}/starters/mine` })
        await mcp.call('create_site', { name: 'b', theme: '@nera-static/theme-blog' })
        await mcp.call('create_site', { name: 'c', starter: 'github:owner/repo#v1' })
        expect(calls.map((c) => c.args)).toEqual([
            ['new', 'a', '--yes', '--starter=./starters/mine'],
            ['new', 'b', '--yes', '--theme=@nera-static/theme-blog'],
            ['new', 'c', '--yes', '--starter=github:owner/repo#v1'],
        ])
    })

    it('creates the site in the root itself for `.`', async () => {
        respond = async ({ cwd }) => {
            await writeFiles(cwd, { 'package.json': '{}' })
            return {}
        }
        const result = await mcp.call('create_site', { name: '.' })
        expect(result.isError).toBeUndefined()
        expect(calls[0]).toEqual({ command: 'nera', args: ['new', '.', '--yes'], cwd: env.root })
        expect(result.structuredContent.site).toBe('.')
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
    })

    it('refuses a theme that is not a package name', async () => {
        const result = await mcp.call('create_site', { name: 'new', theme: '../outside' })
        expect(result.isError).toBe(true)
        expect(textOf(result)).toMatch(/Invalid theme/)
        expect(calls).toEqual([])
    })

    it('reports the CLI\'s error when `nera new` fails', async () => {
        respond = async () => ({ code: 1, stderr: '❌ Invalid language code "xx_".\n' })
        const result = await mcp.call('create_site', { name: 'new', lang: 'xx_' })
        expect(result.isError).toBe(true)
        expect(textOf(result)).toBe('Creating the site failed: ❌ Invalid language code "xx_".')
    })

    it('reports a failure when the CLI exits 0 but created no site', async () => {
        respond = async () => ({ stdout: 'nothing' })
        const result = await mcp.call('create_site', { name: 'new' })
        expect(result.isError).toBe(true)
        expect(textOf(result)).toMatch(/Creating the site failed: nothing/)
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
        const expected = validateSite({ cwd: env.site })
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
