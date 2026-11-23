import fs from 'node:fs'
import os from 'node:os'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHostedServer } from '../src/hosted/mcp.js'
import { SignInRequiredError } from '../src/hosted/provider.js'
import { createRepoClient } from '../src/hosted/repo.js'
import { repoFolder, treeFolders } from '../src/hosted/tools/read.js'
import { API, connectHosted, fakeGitHub } from './fake-github.js'
import { SITE_PACKAGE, textOf } from './helpers.js'

const SITE = 'octo/site'
const USER = 'user-1'

/** A Nera site's files, as `nera new` leaves them. */
const SITE_FILES = {
    'package.json': SITE_PACKAGE,
    'config/app.yaml': 'name: My site\nlang: en\n',
    'pages/index.md': '---\nlayout: pages/default.pug\ntitle: Home\n---\n\n# Welcome\n',
    'pages/blog/first.md': '---\nlayout: pages/post.pug\ntitle: First\n---\nHello\n',
    'theme/views/pages/default.pug': 'p= meta.title\n',
    'assets/logo.png': '\u0089PNG\r\n\u001a\n\u0000\u0000',
}

let github
let session

/** A client signed in as `USER`; see `connectHosted`. */
const connect = (options = {}) => connectHosted(github, { userId: USER, ...options })

beforeEach(async () => {
    github = fakeGitHub()
    github.addRepo(SITE, SITE_FILES)
    session = await connect()
})

afterEach(async () => {
    await session.close()
})

/** Expects an `isError` result whose text matches `pattern`. */
function expectError(result, pattern) {
    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(pattern)
}

describe('registration', () => {
    it('offers the read, write, validate, publish and preview tools next to the catalog tools when a user is bound', async () => {
        const { tools } = await session.client.listTools()
        expect(tools.map((tool) => tool.name).sort()).toEqual([
            'delete_page', 'get_site', 'list_plugins', 'list_sites', 'list_starters', 'list_themes', 'preview', 'publish', 'read_file', 'read_page', 'validate', 'write_file', 'write_page',
        ])
        for (const name of ['list_sites', 'get_site', 'read_page', 'read_file', 'validate', 'preview']) {
            expect(tools.find((tool) => tool.name === name).annotations.readOnlyHint).toBe(true)
        }
    })

    it('offers the catalog tools only without a user', async () => {
        const server = createHostedServer({ fetch: async () => new Response('offline', { status: 503 }) })
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
        const client = new Client({ name: 'nera-mcp-test', version: '0.0.0' })
        await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
        const { tools } = await client.listTools()
        expect(tools.map((tool) => tool.name).sort()).toEqual(['list_plugins', 'list_starters', 'list_themes'])
        await client.close()
    })
})

describe('list_sites', () => {
    it('lists the reachable repositories that are Nera sites, across installations', async () => {
        github.addRepo('octo/notes', { 'README.md': '# Notes\n' })
        github.addRepo('octo/app', { 'package.json': '{"dependencies":{"express":"^5.0.0"}}' })
        github.addRepo('team/docs', { 'package.json': SITE_PACKAGE }, { installation: 2, private: true })
        github.addRepo('octo/broken', { 'package.json': '{ not json' })
        const result = await session.call('list_sites')
        expect(result.isError).toBeFalsy()
        expect(result.structuredContent.sites).toEqual([
            { site: 'octo/site', name: 'my-site', nera: '^1.23.0', private: false },
            { site: 'team/docs', name: 'my-site', nera: '^1.23.0', private: true },
        ])
        expect(textOf(result)).toContain('octo/site, team/docs')
        expect(session.tokenRequests).toEqual([USER])
    })

    it('says how to grant access when no reachable repository is a Nera site', async () => {
        github.repos.clear()
        github.installations.length = 0
        github.addRepo('octo/notes', { 'README.md': '# Notes\n' })
        const result = await session.call('list_sites')
        expect(result.structuredContent.sites).toEqual([])
        expect(textOf(result)).toMatch(/None of the 1 repositories .* Grant the App access/)
    })
})

describe('get_site', () => {
    it('describes the site from main: config, folders, plugins, pages, no draft', async () => {
        const result = await session.call('get_site', { site: SITE })
        expect(result.isError).toBeFalsy()
        expect(result.structuredContent).toEqual({
            site: SITE,
            branch: 'main',
            name: 'my-site',
            nera: '^1.23.0',
            app: { name: 'My site', lang: 'en' },
            appConfigError: null,
            folders: {
                assets: './theme/assets',
                config: './config',
                pages: './pages',
                dist: './public',
                views: './theme/views',
                plugins: './src/plugins',
            },
            theme: null,
            plugins: ['@nera-static/plugin-navigation'],
            pages: ['pages/blog/first.md', 'pages/index.md'],
            draft: { exists: false, ahead: 0 },
        })
        expect(textOf(result)).toBe('Site "octo/site" has 2 page(s) and 1 plugin(s). It has no unpublished changes.')
    })

    it('reads from nera-draft while it exists and counts its unpublished commits', async () => {
        const client = createRepoClient({ token: github.token, fetch: github.fetch, apiUrl: API })
        await client.ensureDraft(SITE)
        github.pushFile(SITE, 'nera-draft', 'pages/new.md', '---\nlayout: pages/default.pug\n---\nNew\n')
        github.pushFile(SITE, 'nera-draft', 'pages/other.md', '---\nlayout: pages/default.pug\n---\nOther\n')
        const result = await session.call('get_site', { site: SITE })
        expect(result.structuredContent.branch).toBe('nera-draft')
        expect(result.structuredContent.draft).toEqual({ exists: true, ahead: 2 })
        expect(result.structuredContent.pages).toEqual(['pages/blog/first.md', 'pages/index.md', 'pages/new.md', 'pages/other.md'])
        expect(textOf(result)).toContain('Its draft (nera-draft) holds 2 unpublished commit(s)')
    })

    it('follows folders.pages from config/app.yaml and keeps root views without theme/', async () => {
        github.addRepo('octo/custom', {
            'package.json': SITE_PACKAGE,
            'config/app.yaml': 'folders:\n  pages: ./content/\n',
            'content/a.md': '---\nlayout: a.pug\n---\n',
            'pages/not-a-page.md': '---\nlayout: a.pug\n---\n',
            'views/a.pug': 'p a\n',
        })
        const result = await session.call('get_site', { site: 'octo/custom' })
        expect(result.structuredContent.folders).toMatchObject({ pages: './content/', views: './views', assets: './assets' })
        expect(result.structuredContent.pages).toEqual(['content/a.md'])
    })

    it('reports a theme by name and invalid app.yaml without failing', async () => {
        github.addRepo('octo/themed', { 'package.json': SITE_PACKAGE, 'config/app.yaml': 'theme: blog\n' })
        const themed = await session.call('get_site', { site: 'octo/themed' })
        expect(themed.structuredContent.theme).toEqual({ name: 'blog' })
        expect(themed.structuredContent.folders.views).toBe('./theme/views')

        github.addRepo('octo/bad-yaml', { 'package.json': SITE_PACKAGE, 'config/app.yaml': 'name: [unclosed\n' })
        const bad = await session.call('get_site', { site: 'octo/bad-yaml' })
        expect(bad.isError).toBeFalsy()
        expect(bad.structuredContent.app).toEqual({})
        expect(bad.structuredContent.appConfigError).toEqual(expect.any(String))
        expect(textOf(bad)).toMatch(/config\/app\.yaml is invalid YAML/)
    })

    it('refuses a pages folder that leaves the repository', async () => {
        github.addRepo('octo/escape', { 'package.json': SITE_PACKAGE, 'config/app.yaml': 'folders:\n  pages: ../elsewhere\n' })
        expectError(await session.call('get_site', { site: 'octo/escape' }), /pages folder \(folders\.pages in config\/app\.yaml\) "\.\.\/elsewhere" contains "\." or "\.\." segments/)
    })

    it('does not list a symbolic link in the pages folder', async () => {
        github.addRepo('octo/links', {
            'package.json': SITE_PACKAGE,
            'pages/index.md': '---\nlayout: a.pug\n---\n',
            'pages/env.md': { symlink: '../.env' },
            '.env': 'TOKEN=secret\n',
        })
        const result = await session.call('get_site', { site: 'octo/links' })
        expect(result.structuredContent.pages).toEqual(['pages/index.md'])
    })
})

describe('the site check (D3)', () => {
    it('refuses a repository outside the user\'s installations, without reading it', async () => {
        github.addRepo('evil/site', { 'package.json': SITE_PACKAGE })
        const installation = github.installations.find((entry) => entry.repos.includes('evil/site'))
        installation.repos.splice(installation.repos.indexOf('evil/site'), 1)
        github.requests.length = 0
        for (const name of ['get_site', 'read_file']) {
            expectError(await session.call(name, { site: 'evil/site', path: 'package.json' }), /not one the Nera Static GitHub App can reach for you\. Call list_sites/)
        }
        expect(github.requests.some((request) => request.path.startsWith('/repos/evil/'))).toBe(false)
    })

    it('refuses a reachable repository that is no Nera site', async () => {
        github.addRepo('octo/app', { 'package.json': '{"dependencies":{"express":"^5.0.0"}}', 'secret.txt': 'x' })
        expectError(await session.call('read_file', { site: 'octo/app', path: 'secret.txt' }), /"octo\/app" is not a Nera site: its package\.json on main does not depend on @nera-static\/nera/)
        github.addRepo('octo/empty', {})
        expectError(await session.call('get_site', { site: 'octo/empty' }), /not a Nera site/)
    })

    it('refuses a malformed site name before any request', async () => {
        github.requests.length = 0
        for (const site of ['site', 'octo/site/extra', '../octo', 'octo/..']) {
            expectError(await session.call('get_site', { site }), /is not a GitHub repository name/)
        }
        expect(github.requests).toEqual([])
    })

    it('matches the repository name case-insensitively and answers with its own spelling', async () => {
        const result = await session.call('get_site', { site: 'Octo/Site' })
        expect(result.structuredContent.site).toBe(SITE)
    })
})

describe('read_page', () => {
    it('returns the frontmatter as JSON and the body', async () => {
        const result = await session.call('read_page', { site: SITE, path: 'pages/index.md' })
        expect(result.structuredContent).toEqual({
            site: SITE,
            branch: 'main',
            path: 'pages/index.md',
            frontmatter: { layout: 'pages/default.pug', title: 'Home' },
            body: '# Welcome\n',
        })
        expect(textOf(result)).toBe('Read pages/index.md (layout: pages/default.pug).')
    })

    it('reads the draft version of a page while the draft exists', async () => {
        const client = createRepoClient({ token: github.token, fetch: github.fetch, apiUrl: API })
        await client.ensureDraft(SITE)
        github.pushFile(SITE, 'nera-draft', 'pages/index.md', '---\nlayout: pages/default.pug\ntitle: Draft\n---\nDraft\n')
        const result = await session.call('read_page', { site: SITE, path: 'pages/index.md' })
        expect(result.structuredContent).toMatchObject({ branch: 'nera-draft', frontmatter: { title: 'Draft' }, body: 'Draft\n' })
    })

    it('reports invalid frontmatter instead of failing', async () => {
        github.pushFile(SITE, 'main', 'pages/bad.md', '---\ntitle: [unclosed\n---\nBody\n')
        const result = await session.call('read_page', { site: SITE, path: 'pages/bad.md' })
        expect(result.isError).toBeFalsy()
        expect(result.structuredContent.frontmatter).toBeNull()
        expect(result.structuredContent.frontmatterError).toEqual(expect.any(String))
        expect(textOf(result)).toMatch(/frontmatter is invalid YAML/)
    })

    it('refuses a missing page, a path outside the pages folder and a non-Markdown file', async () => {
        expectError(await session.call('read_page', { site: SITE, path: 'pages/nope.md' }), /The page "pages\/nope\.md" does not exist on main of octo\/site\. Call get_site/)
        expectError(await session.call('read_page', { site: SITE, path: 'config/app.yaml' }), /not inside the site's pages folder \(pages\/\)/)
        expectError(await session.call('read_page', { site: SITE, path: 'pages' }), /not inside the site's pages folder/)
        expectError(await session.call('read_page', { site: SITE, path: 'pages/blog' }), /does not end in \.md/)
    })

    it('refuses a symbolic link, even one that points at a page', async () => {
        github.addRepo('octo/links', {
            'package.json': SITE_PACKAGE,
            'pages/index.md': '---\nlayout: a.pug\n---\n',
            'pages/alias.md': { symlink: 'index.md' },
            'pages/env.md': { symlink: '../.env' },
            '.env': 'TOKEN=secret\n',
        })
        for (const page of ['pages/alias.md', 'pages/env.md']) {
            const result = await session.call('read_page', { site: 'octo/links', path: page })
            expectError(result, /is a symbolic link in octo\/links; these tools do not follow links/)
            expect(textOf(result)).not.toContain('secret')
        }
    })
})

describe('read_file', () => {
    it('returns a text file\'s content', async () => {
        const result = await session.call('read_file', { site: SITE, path: 'config/app.yaml' })
        expect(result.structuredContent).toEqual({ site: SITE, branch: 'main', path: 'config/app.yaml', content: 'name: My site\nlang: en\n' })
        expect(textOf(result)).toBe('name: My site\nlang: en\n')
    })

    it('refuses a missing file, a folder, a binary file and a file over 1 MB', async () => {
        github.pushFile(SITE, 'main', 'assets/big.css', 'a'.repeat(1024 * 1024 + 1))
        github.requests.length = 0
        expectError(await session.call('read_file', { site: SITE, path: 'nope.txt' }), /The file "nope\.txt" does not exist on main of octo\/site/)
        expectError(await session.call('read_file', { site: SITE, path: 'pages' }), /"pages" is a folder, not a file/)
        expectError(await session.call('read_file', { site: SITE, path: 'assets/logo.png' }), /is a binary file/)
        expectError(await session.call('read_file', { site: SITE, path: 'assets/big.css' }), /is 1048577 bytes, more than the 1048576 bytes read_file returns/)
        // the large file's content is never downloaded
        expect(github.requests.some((request) => request.path.includes('/git/blobs/'))).toBe(false)
    })

    it('refuses git internals and files that can hold secrets, before any request', async () => {
        github.requests.length = 0
        for (const file of ['.git/config', '.env', '.env.production', 'config/.npmrc']) {
            expectError(await session.call('read_file', { site: SITE, path: file }), /never read or change/)
        }
        expect(github.requests).toEqual([])
    })

    it('refuses paths that leave the repository, before any request', async () => {
        github.requests.length = 0
        const cases = [
            ['../other/package.json', /contains "\." or "\.\." segments/],
            ['pages/../../x', /contains "\." or "\.\." segments/],
            ['/etc/passwd', /is absolute/],
            ['pages\\index.md', /contains a backslash/],
            ['pages//index.md', /empty segment/],
            ['', /is empty/],
        ]
        for (const [file, pattern] of cases) {
            expectError(await session.call('read_file', { site: SITE, path: file }), pattern)
            expectError(await session.call('read_page', { site: SITE, path: file }), pattern)
        }
        expect(github.requests).toEqual([])
    })

    it('refuses a symbolic link to a secret file and never returns its content', async () => {
        github.addRepo('octo/links', { 'package.json': SITE_PACKAGE, 'notes.txt': { symlink: '.env' }, '.env': 'TOKEN=secret\n' })
        const result = await session.call('read_file', { site: 'octo/links', path: 'notes.txt' })
        expectError(result, /"notes\.txt" is a symbolic link/)
        expect(JSON.stringify(result)).not.toContain('secret')
    })
})

describe('the sign-in and GitHub failures', () => {
    it('turns a lost sign-in into a tool error that says how to reconnect', async () => {
        await session.close()
        session = await connect({ githubToken: async () => { throw new SignInRequiredError('The GitHub sign-in has expired. Sign in again: remove the Nera connector in your AI assistant and connect it once more.') } })
        for (const [name, args] of [['list_sites', {}], ['get_site', { site: SITE }], ['read_file', { site: SITE, path: 'config/app.yaml' }]]) {
            expectError(await session.call(name, args), /sign-in has expired\. Sign in again: remove the Nera connector/)
        }
    })

    it('turns a GitHub refusal into a tool error without the token', async () => {
        github.intercept = () => Response.json({ message: `Server Error for ${github.token}` }, { status: 500 })
        const result = await session.call('list_sites')
        expectError(result, /GitHub refused GET \/user\/installations: Server Error for \[token\]/)
        expect(JSON.stringify(result)).not.toContain(github.token)
    })

    it('adds how to reconnect when GitHub no longer accepts the token', async () => {
        await session.close()
        session = await connect({ githubToken: async () => 'ghu_revoked' })
        expectError(await session.call('list_sites'), /Bad credentials Sign in again: remove the Nera connector/)
    })

    it('never puts the token into a result', async () => {
        const results = [
            await session.call('list_sites'),
            await session.call('get_site', { site: SITE }),
            await session.call('read_page', { site: SITE, path: 'pages/index.md' }),
            await session.call('read_file', { site: SITE, path: 'config/app.yaml' }),
        ]
        for (const result of results) expect(JSON.stringify(result)).not.toContain(github.token)
    })
})

describe('the folder helpers', () => {
    it('turns a configured folder into a repository path', () => {
        expect(repoFolder('./pages', 'pages')).toBe('pages')
        expect(repoFolder('content/', 'pages')).toBe('content')
        expect(repoFolder('./a/b/../c', 'pages')).toBe('a/c')
        expect(() => repoFolder('/abs', 'pages')).toThrow(/is absolute/)
        expect(() => repoFolder('.', 'pages')).toThrow(/"\." or "\.\." segments/)
    })

    it('probes theme/ and views/ in the tree, not on the server, and leaves no folder behind', () => {
        const before = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('nera-mcp-folders-'))
        expect(treeFolders({}, [{ path: 'theme', type: 'tree', mode: '040000' }]).views).toBe('./theme/views')
        expect(treeFolders({}, []).views).toBe('./views')
        expect(treeFolders({}, [{ path: 'theme', type: 'blob', mode: '120000' }]).views).toBe('./views')
        expect(treeFolders({ theme: 'blog' }, [{ path: 'views', type: 'tree', mode: '040000' }]).views).toBe('./views')
        expect(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('nera-mcp-folders-'))).toEqual(before)
    })
})
