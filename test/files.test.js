import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { connect, makeRoot, SITE_PACKAGE, textOf, writeFiles } from './helpers.js'

let env
let mcp

beforeEach(async () => {
    env = await makeRoot()
    mcp = await connect(env.root)
})

afterEach(async () => {
    await mcp.close()
    await env.cleanup()
})

const read = (file) => fs.readFile(path.join(env.site, file), 'utf8')

describe('createServer', () => {
    it('lists the site, file, CLI and catalog tools, each with a description and an input schema', async () => {
        const { tools } = await mcp.client.listTools()
        expect(tools.map((t) => t.name).sort()).toEqual([
            'add_plugin', 'build', 'create_site', 'delete_page', 'get_site', 'list_plugins',
            'list_sites', 'list_starters', 'list_themes', 'read_file', 'read_page', 'validate',
            'write_file', 'write_page',
        ])
        for (const t of tools) {
            expect(t.description.length).toBeGreaterThan(80)
            expect(t.inputSchema.type).toBe('object')
        }
        const writePage = tools.find((t) => t.name === 'write_page')
        expect(writePage.inputSchema.required).toEqual(['site', 'path', 'frontmatter'])
    })

    it('refuses a root that does not exist', async () => {
        const { createServer } = await import('../src/server.js')
        await expect(createServer({ root: path.join(env.tmp, 'nope') })).rejects.toThrow(/does not exist/)
    })

    it('reports invalid arguments as an isError result, not a protocol error', async () => {
        const result = await mcp.call('read_page', { site: 'site' })
        expect(result.isError).toBe(true)
        expect(textOf(result)).toMatch(/path/)
    })
})

describe('list_sites', () => {
    it('finds sites below the root, skipping node_modules, hidden folders and non-sites', async () => {
        await writeFiles(path.join(env.root, 'clients', 'shop'), { 'package.json': SITE_PACKAGE })
        await writeFiles(path.join(env.root, 'site', 'node_modules', 'x'), { 'package.json': SITE_PACKAGE })
        await writeFiles(path.join(env.root, '.hidden'), { 'package.json': SITE_PACKAGE })
        await writeFiles(path.join(env.root, 'other'), { 'package.json': '{"name":"other"}' })
        await fs.symlink(env.outside, path.join(env.root, 'linked'))
        await writeFiles(env.outside, { 'package.json': SITE_PACKAGE })

        const result = await mcp.call('list_sites')
        expect(result.isError).toBeUndefined()
        expect(result.structuredContent.sites).toEqual([
            { site: 'clients/shop', name: 'my-site', nera: '^1.23.0' },
            { site: 'site', name: 'my-site', nera: '^1.23.0' },
        ])
    })

    it('reports the root itself as `.` when it is a site', async () => {
        await writeFiles(env.root, { 'package.json': SITE_PACKAGE })
        const result = await mcp.call('list_sites')
        expect(result.structuredContent.sites.map((s) => s.site)).toEqual(['.'])
    })

    it('says to call create_site when there is none', async () => {
        await fs.rm(env.site, { recursive: true })
        const result = await mcp.call('list_sites')
        expect(result.structuredContent.sites).toEqual([])
        expect(textOf(result)).toMatch(/create_site/)
    })
})

describe('get_site', () => {
    it('describes the site from its config, folders, plugins and pages', async () => {
        await writeFiles(env.site, { 'pages/blog/first.md': '---\nlayout: x\n---\n', 'pages/notes.txt': 'x' })
        const result = await mcp.call('get_site', { site: 'site' })
        expect(result.isError).toBeUndefined()
        expect(result.structuredContent).toMatchObject({
            site: 'site',
            name: 'my-site',
            app: { title: 'My site', lang: 'en' },
            appConfigError: null,
            folders: { pages: './pages', views: './theme/views' },
            theme: null,
            plugins: ['@nera-static/plugin-navigation'],
            pages: ['pages/blog/first.md', 'pages/index.md'],
        })
    })

    it('reads the given site, not the process working directory', async () => {
        expect(process.cwd()).not.toBe(env.site)
        await writeFiles(env.site, { 'config/app.yaml': 'title: Elsewhere\nfolders:\n    pages: ./content\n', 'content/a.md': '---\nlayout: x\n---\n' })
        const result = await mcp.call('get_site', { site: 'site' })
        expect(result.structuredContent.app.title).toBe('Elsewhere')
        expect(result.structuredContent.pages).toEqual(['content/a.md'])
    })

    it('reports a broken app.yaml instead of failing', async () => {
        await writeFiles(env.site, { 'config/app.yaml': 'title: [unclosed\n' })
        const result = await mcp.call('get_site', { site: 'site' })
        expect(result.isError).toBeUndefined()
        expect(result.structuredContent.appConfigError).toBeTruthy()
        expect(textOf(result)).toMatch(/Problems/)
    })

    it('refuses a folder that is not a Nera site', async () => {
        await writeFiles(env.root, { 'other/package.json': '{"name":"other"}' })
        const result = await mcp.call('get_site', { site: 'other' })
        expect(result.isError).toBe(true)
        expect(textOf(result)).toMatch(/not a Nera site.*list_sites/)
    })

    it('refuses a pages folder configured outside the site', async () => {
        await writeFiles(env.site, { 'config/app.yaml': 'folders:\n    pages: ../../outside/pages\n' })
        const result = await mcp.call('get_site', { site: 'site' })
        expect(result.isError).toBe(true)
        expect(textOf(result)).toMatch(/pages folder/)
    })

    it('refuses an output folder configured outside the site, also for write_file', async () => {
        await writeFiles(env.site, { 'config/app.yaml': 'folders:\n    dist: ../..\n' })
        for (const [name, args] of [['get_site', {}], ['write_file', { path: 'assets/x.css', content: 'x' }]]) {
            const result = await mcp.call(name, { site: 'site', ...args })
            expect(result.isError, name).toBe(true)
            expect(textOf(result)).toMatch(/output folder/)
        }
    })
})

describe('read_page', () => {
    it('returns frontmatter as JSON and the Markdown body', async () => {
        const result = await mcp.call('read_page', { site: 'site', path: 'pages/index.md' })
        expect(result.structuredContent).toEqual({
            site: 'site',
            path: 'pages/index.md',
            frontmatter: { layout: 'pages/default.pug', title: 'Home' },
            body: '# Welcome\n',
        })
    })

    it('keeps unquoted dates as the text they are written as', async () => {
        await writeFiles(env.site, { 'pages/post.md': '---\nlayout: x\ndate: 2026-01-02\n---\nHi\n' })
        const result = await mcp.call('read_page', { site: 'site', path: 'pages/post.md' })
        expect(result.structuredContent.frontmatter.date).toBe('2026-01-02')
    })

    it('reports invalid frontmatter with the body, so the page can be fixed', async () => {
        await writeFiles(env.site, { 'pages/bad.md': '---\nlayout: [x\n---\nBody\n' })
        const result = await mcp.call('read_page', { site: 'site', path: 'pages/bad.md' })
        expect(result.isError).toBeUndefined()
        expect(result.structuredContent.frontmatter).toBeNull()
        expect(result.structuredContent.frontmatterError).toBeTruthy()
        expect(result.structuredContent.body).toBe('Body\n')
    })

    it('says when the page does not exist', async () => {
        const result = await mcp.call('read_page', { site: 'site', path: 'pages/nope.md' })
        expect(result.isError).toBe(true)
        expect(textOf(result)).toMatch(/does not exist/)
    })
})

describe('write_page', () => {
    it('creates a page with frontmatter and body, creating folders', async () => {
        const result = await mcp.call('write_page', {
            site: 'site',
            path: 'pages/blog/hello.md',
            frontmatter: { layout: 'pages/default.pug', title: 'Hello: world', tags: ['a', 'b'] },
            body: '# Hello\n\nText',
        })
        expect(result.isError).toBeUndefined()
        expect(result.structuredContent).toEqual({ site: 'site', path: 'pages/blog/hello.md', created: true })
        expect(await read('pages/blog/hello.md')).toBe(
            '---\nlayout: pages/default.pug\ntitle: "Hello: world"\ntags:\n  - a\n  - b\n---\n\n# Hello\n\nText\n',
        )
    })

    it('refuses frontmatter without layout and writes nothing', async () => {
        for (const frontmatter of [{ title: 'No layout' }, { layout: '  ' }, { layout: 3 }]) {
            const result = await mcp.call('write_page', { site: 'site', path: 'pages/x.md', frontmatter, body: 'x' })
            expect(result.isError).toBe(true)
            expect(textOf(result)).toMatch(/layout/)
        }
        await expect(read('pages/x.md')).rejects.toThrow()
    })

    it('keeps comments, quoting and order, the quoting style of a changed value, removes left-out keys, keeps the body', async () => {
        await writeFiles(env.site, {
            'pages/about.md': '---\n# the layout\nlayout: \'pages/default.pug\'\ntitle: "About"\ndraft: true\n---\n\nAbout us.\n',
        })
        const result = await mcp.call('write_page', {
            site: 'site',
            path: 'pages/about.md',
            frontmatter: { layout: 'pages/default.pug', title: 'About us', description: 'Who we are' },
        })
        expect(result.structuredContent.created).toBe(false)
        expect(await read('pages/about.md')).toBe(
            '---\n# the layout\nlayout: \'pages/default.pug\'\ntitle: "About us"\ndescription: Who we are\n---\n\nAbout us.\n',
        )
    })

    it('round-trips what read_page returned unchanged, byte for byte', async () => {
        const original = '---\nlayout: "pages/default.pug" # inline\ndate: 2026-01-02\ntags: [a, b]\n---\n# Title\n'
        await writeFiles(env.site, { 'pages/post.md': original })
        const { structuredContent: page } = await mcp.call('read_page', { site: 'site', path: 'pages/post.md' })
        await mcp.call('write_page', { site: 'site', path: 'pages/post.md', frontmatter: page.frontmatter })
        expect(await read('pages/post.md')).toBe(original)
    })

    it('reads CRLF frontmatter as frontmatter, so it is replaced and not duplicated', async () => {
        await writeFiles(env.site, { 'pages/win.md': '---\r\nlayout: x\r\ntitle: Old\r\n---\r\nBody\r\n' })
        const { structuredContent: page } = await mcp.call('read_page', { site: 'site', path: 'pages/win.md' })
        expect(page.frontmatter).toEqual({ layout: 'x', title: 'Old' })
        await mcp.call('write_page', { site: 'site', path: 'pages/win.md', frontmatter: { layout: 'x', title: 'New' } })
        expect(await read('pages/win.md')).toBe('---\nlayout: x\ntitle: New\n---\nBody\n')
    })

    it('refuses a page path that is a folder', async () => {
        await fs.mkdir(path.join(env.site, 'pages', 'odd.md'))
        const result = await mcp.call('read_page', { site: 'site', path: 'pages/odd.md' })
        expect(result.isError).toBe(true)
        expect(textOf(result)).toMatch(/pages\/odd\.md" is a folder/)
    })

    it('replaces frontmatter that does not parse', async () => {
        await writeFiles(env.site, { 'pages/bad.md': '---\nlayout: [x\n---\nBody\n' })
        await mcp.call('write_page', { site: 'site', path: 'pages/bad.md', frontmatter: { layout: 'pages/default.pug' } })
        expect(await read('pages/bad.md')).toBe('---\nlayout: pages/default.pug\n---\nBody\n')
    })

    it('refuses a path outside the pages folder or not ending in .md', async () => {
        const frontmatter = { layout: 'pages/default.pug' }
        for (const page of ['config/x.md', 'pages', 'pages/about.html']) {
            const result = await mcp.call('write_page', { site: 'site', path: page, frontmatter, body: 'x' })
            expect(result.isError, page).toBe(true)
            expect(textOf(result)).toMatch(/pages folder|\.md/)
        }
    })
})

describe('delete_page', () => {
    it('deletes a page', async () => {
        const result = await mcp.call('delete_page', { site: 'site', path: 'pages/index.md' })
        expect(result.structuredContent).toEqual({ site: 'site', path: 'pages/index.md', deleted: true })
        await expect(read('pages/index.md')).rejects.toThrow()
    })

    it('says when the page does not exist', async () => {
        const result = await mcp.call('delete_page', { site: 'site', path: 'pages/nope.md' })
        expect(result.isError).toBe(true)
        expect(textOf(result)).toMatch(/does not exist/)
    })

    it('refuses a file outside the pages folder', async () => {
        const result = await mcp.call('delete_page', { site: 'site', path: 'package.json' })
        expect(result.isError).toBe(true)
        expect(await read('package.json')).toBe(SITE_PACKAGE)
    })
})

describe('read_file and write_file', () => {
    it('writes and reads back a text file, creating folders', async () => {
        const written = await mcp.call('write_file', { site: 'site', path: 'assets/css/main.css', content: 'body { color: red }\n' })
        expect(written.structuredContent).toEqual({ site: 'site', path: 'assets/css/main.css', created: true })
        const again = await mcp.call('write_file', { site: 'site', path: 'assets/css/main.css', content: 'p {}\n' })
        expect(again.structuredContent.created).toBe(false)
        const result = await mcp.call('read_file', { site: 'site', path: 'assets/css/main.css' })
        expect(result.structuredContent).toEqual({ site: 'site', path: 'assets/css/main.css', content: 'p {}\n' })
    })

    it('refuses .env files, .npmrc and git internals for reading and writing', async () => {
        await writeFiles(env.site, { '.env': 'TOKEN=x', '.npmrc': '//registry.npmjs.org/:_authToken=TOKEN', '.git/config': '[remote]' })
        for (const file of ['.env', '.env.local', 'config/.env', '.npmrc', '.git/config', '.git/hooks/pre-commit']) {
            for (const [name, extra] of [['read_file', {}], ['write_file', { content: 'x' }]]) {
                const result = await mcp.call(name, { site: 'site', path: file, ...extra })
                expect(result.isError, `${name} ${file}`).toBe(true)
                expect(textOf(result)).not.toContain('TOKEN')
            }
        }
        expect(await read('.env')).toBe('TOKEN=x')
    })

    it('refuses .env files and git internals reached through a symbolic link', async () => {
        await writeFiles(env.site, { '.env': 'TOKEN=x', '.git/config': '[remote]' })
        await fs.symlink(path.join(env.site, '.env'), path.join(env.site, 'settings.txt'))
        await fs.symlink(path.join(env.site, '.git'), path.join(env.site, 'repo'))
        for (const file of ['settings.txt', 'repo/config']) {
            for (const [name, extra] of [['read_file', {}], ['write_file', { content: 'x' }]]) {
                const result = await mcp.call(name, { site: 'site', path: file, ...extra })
                expect(result.isError, `${name} ${file}`).toBe(true)
                expect(textOf(result)).not.toContain('TOKEN')
            }
        }
        expect(await read('.env')).toBe('TOKEN=x')
        expect(await read('.git/config')).toBe('[remote]')
    })

    it('refuses to write pages, the output folder and node_modules', async () => {
        const cases = {
            'pages/index.md': /write_page/,
            'public/index.html': /output folder/,
            'node_modules/x/index.js': /npm/,
        }
        for (const [file, message] of Object.entries(cases)) {
            const result = await mcp.call('write_file', { site: 'site', path: file, content: 'x' })
            expect(result.isError, file).toBe(true)
            expect(textOf(result)).toMatch(message)
        }
        expect(await read('pages/index.md')).toMatch(/layout/)
    })

    it('refuses folders, missing, binary and oversized files for reading', async () => {
        await fs.writeFile(path.join(env.site, 'logo.png'), Buffer.from([0x89, 0x50, 0x00, 0x01]))
        await fs.writeFile(path.join(env.site, 'big.txt'), 'x'.repeat(1024 * 1024 + 1))
        const cases = { config: /folder/, 'nope.txt': /does not exist/, 'logo.png': /binary/, 'big.txt': /bytes/, '.': /not the site folder/ }
        for (const [file, message] of Object.entries(cases)) {
            const result = await mcp.call('read_file', { site: 'site', path: file })
            expect(result.isError, file).toBe(true)
            expect(textOf(result)).toMatch(message)
        }
    })
})

describe('the root guard, per tool', () => {
    const page = { layout: 'pages/default.pug' }
    // Each tool with its arguments; `site` and `path` are replaced per case.
    const tools = {
        get_site: {},
        read_page: { path: 'pages/index.md' },
        write_page: { path: 'pages/index.md', frontmatter: page, body: 'x' },
        delete_page: { path: 'pages/index.md' },
        read_file: { path: 'config/app.yaml' },
        write_file: { path: 'config/app.yaml', content: 'x' },
    }
    const pathTools = Object.keys(tools).filter((name) => name !== 'get_site')

    beforeEach(async () => {
        // A site outside the root, and links from inside the root to it.
        await writeFiles(path.join(env.outside, 'site'), { 'package.json': SITE_PACKAGE, 'pages/index.md': '---\nlayout: x\n---\nsecret\n', 'config/app.yaml': 'secret: true\n' })
        await fs.symlink(path.join(env.outside, 'site'), path.join(env.root, 'escape'))
        await fs.symlink(path.join(env.outside, 'site', 'pages'), path.join(env.site, 'pages', 'linked'))
        await fs.symlink(path.join(env.outside, 'site', 'config'), path.join(env.site, 'linked-config'))
    })

    async function expectUntouched() {
        expect(await fs.readFile(path.join(env.outside, 'site', 'pages', 'index.md'), 'utf8')).toBe('---\nlayout: x\n---\nsecret\n')
        expect(await fs.readFile(path.join(env.outside, 'site', 'config', 'app.yaml'), 'utf8')).toBe('secret: true\n')
    }

    for (const [name, args] of Object.entries(tools)) {
        describe(name, () => {
            const siteCases = {
                '..': '../outside/site',
                'an absolute path outside the root': null, // filled in per test
                'a symlink leading out': 'escape',
            }
            for (const [label, site] of Object.entries(siteCases)) {
                it(`refuses a site that is ${label}`, async () => {
                    const value = site ?? path.join(env.outside, 'site')
                    const result = await mcp.call(name, { ...args, site: value })
                    expect(result.isError).toBe(true)
                    expect(textOf(result)).toMatch(/site/)
                    expect(textOf(result)).not.toContain('secret')
                    await expectUntouched()
                })
            }
        })
    }

    for (const name of pathTools) {
        describe(name, () => {
            const isPage = name.endsWith('_page')
            const pathCases = {
                '..': isPage ? 'pages/../../escape/pages/index.md' : '../escape/config/app.yaml',
                'an absolute path outside the root': null,
                'a symlink leading out': isPage ? 'pages/linked/index.md' : 'linked-config/app.yaml',
            }
            for (const [label, value] of Object.entries(pathCases)) {
                it(`refuses a path that is ${label}`, async () => {
                    const absolute = isPage ? path.join(env.outside, 'site', 'pages', 'index.md') : path.join(env.outside, 'site', 'config', 'app.yaml')
                    const result = await mcp.call(name, { ...tools[name], site: 'site', path: value ?? absolute })
                    expect(result.isError).toBe(true)
                    expect(textOf(result)).toMatch(/path/)
                    expect(textOf(result)).not.toContain('secret')
                    await expectUntouched()
                })
            }
        })
    }
})
