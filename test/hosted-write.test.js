import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { connectHosted, fakeGitHub } from './fake-github.js'
import { SITE_PACKAGE, textOf } from './helpers.js'

const SITE = 'octo/site'
const DRAFT = 'nera-draft'

/** A Nera site's files, as `nera new` leaves them. */
const SITE_FILES = {
    'package.json': SITE_PACKAGE,
    'config/app.yaml': 'name: My site\nlang: en\n',
    'pages/index.md': '---\nlayout: pages/default.pug\n# shown in the tab\ntitle: Home\n---\n\n# Welcome\n',
    'pages/blog/first.md': '---\nlayout: pages/post.pug\ntitle: First\n---\nHello\n',
    'theme/views/pages/default.pug': 'p= meta.title\n',
    'theme/assets/css/main.css': 'body { color: red; }\n',
    'docs': { symlink: 'theme' },
}

let github
let session
let mainHead

beforeEach(async () => {
    github = fakeGitHub()
    github.addRepo(SITE, SITE_FILES)
    mainHead = github.repos.get(SITE).refs.get('main')
    session = await connectHosted(github)
})

afterEach(async () => {
    await session.close()
})

/** Expects an `isError` result whose text matches `pattern`. */
function expectError(result, pattern) {
    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(pattern)
}

/** The draft branch's head, undefined while there is none. */
const draftHead = () => github.repos.get(SITE).refs.get(DRAFT)

/** The requests that change something on GitHub. */
const writes = () => github.requests.filter((request) => request.method !== 'GET')

/** Starts the draft from `main` with one commit of `path`, as another client would. */
function pushToDraft(path, content, message) {
    const repo = github.repos.get(SITE)
    if (!repo.refs.has(DRAFT)) repo.refs.set(DRAFT, repo.refs.get('main'))
    return github.pushFile(SITE, DRAFT, path, content, message)
}

/** Expects nothing to have changed: no draft, no write request, `main` where it was. */
function expectUntouched() {
    expect(draftHead()).toBeUndefined()
    expect(writes()).toEqual([])
    expect(github.repos.get(SITE).refs.get('main')).toBe(mainHead)
}

describe('write_page', () => {
    it('creates the draft from main and commits a new page once, with the given message', async () => {
        const result = await session.call('write_page', {
            site: SITE,
            path: 'pages/about.md',
            frontmatter: { layout: 'pages/default.pug', title: 'About' },
            body: 'Who we are.',
            message: 'Add the about page',
        })
        expect(result.isError).toBeFalsy()
        const commit = draftHead()
        expect(result.structuredContent).toEqual({ site: SITE, path: 'pages/about.md', created: true, commit, branch: DRAFT })
        expect(textOf(result)).toMatch(/Created pages\/about\.md in octo\/site\. Nothing is live yet.*call validate.*then publish/i)
        expect(github.commit(SITE, DRAFT)).toMatchObject({ parents: [mainHead], message: 'Add the about page' })
        expect(github.files(SITE, DRAFT)['pages/about.md']).toBe('---\nlayout: pages/default.pug\ntitle: About\n---\n\nWho we are.\n')
        expect(github.repos.get(SITE).refs.get('main')).toBe(mainHead)
        expect(github.files(SITE, 'main')['pages/about.md']).toBeUndefined()
    })

    it('edits the page as it is on the draft, keeping its comments, and stacks one commit per call', async () => {
        const drafted = pushToDraft('pages/index.md', '---\nlayout: pages/default.pug\n# drafted comment\ntitle: Draft home\n---\nDraft body\n', 'Earlier draft change')
        const result = await session.call('write_page', {
            site: SITE,
            path: 'pages/index.md',
            frontmatter: { layout: 'pages/default.pug', title: 'Start' },
            message: 'Rename the home page',
        })
        expect(result.structuredContent).toMatchObject({ created: false, branch: DRAFT })
        expect(github.files(SITE, DRAFT)['pages/index.md']).toBe('---\nlayout: pages/default.pug\n# drafted comment\ntitle: Start\n---\nDraft body\n')
        expect(github.commit(SITE, DRAFT)).toMatchObject({ parents: [drafted], message: 'Rename the home page' })
        expect(github.files(SITE, 'main')['pages/index.md']).toBe(SITE_FILES['pages/index.md'])
    })

    it('starts from the draft another call created in the meantime, not from the main it read', async () => {
        github.intercept = ({ method, path }) => {
            if (method !== 'POST' || !path.endsWith('/git/refs')) return undefined
            github.intercept = null
            pushToDraft('pages/index.md', '---\nlayout: pages/default.pug\n# concurrent\ntitle: Home\n---\nConcurrent body\n')
            return Response.json({ message: 'Reference already exists' }, { status: 422 })
        }
        const result = await session.call('write_page', {
            site: SITE,
            path: 'pages/index.md',
            frontmatter: { layout: 'pages/default.pug', title: 'Start' },
            message: 'Rename the home page',
        })
        expect(result.isError).toBeFalsy()
        expect(github.files(SITE, DRAFT)['pages/index.md']).toBe('---\nlayout: pages/default.pug\n# concurrent\ntitle: Start\n---\nConcurrent body\n')
    })

    it('commits on the new head when the draft moves during the commit (one retry)', async () => {
        pushToDraft('config/app.yaml', 'name: Drafted\n')
        let other
        github.intercept = ({ method, path }) => {
            if (method !== 'PATCH' || !path.endsWith(`/git/refs/heads/${DRAFT}`)) return undefined
            github.intercept = null
            other = github.pushFile(SITE, DRAFT, 'pages/other.md', '---\nlayout: x\n---\n')
            return Response.json({ message: 'Update is not a fast forward' }, { status: 422 })
        }
        const result = await session.call('write_page', {
            site: SITE,
            path: 'pages/about.md',
            frontmatter: { layout: 'pages/default.pug' },
            body: 'About',
            message: 'Add the about page',
        })
        expect(result.isError).toBeFalsy()
        expect(github.commit(SITE, DRAFT)).toMatchObject({ parents: [other], message: 'Add the about page' })
        expect(Object.keys(github.files(SITE, DRAFT))).toEqual(expect.arrayContaining(['pages/about.md', 'pages/other.md']))
    })

    it('refuses a page without layout, outside the pages folder, not Markdown or without a message, changing nothing', async () => {
        const page = { site: SITE, path: 'pages/about.md', frontmatter: { layout: 'pages/default.pug' }, message: 'Add it' }
        expectError(await session.call('write_page', { ...page, frontmatter: { title: 'About' } }), /has no `layout`/)
        expectError(await session.call('write_page', { ...page, message: '  ' }), /commit message is empty/)
        expectError(await session.call('write_page', { ...page, path: 'config/about.md' }), /not inside the site's pages folder \(pages\/\)/)
        expectError(await session.call('write_page', { ...page, path: 'pages/about.html' }), /does not end in \.md/)
        expectError(await session.call('write_page', { ...page, path: 'pages/blog/first.md/x.md' }), /below pages\/blog\/first\.md, which is a file/)
        expectUntouched()
    })

    it('refuses paths that leave the repository and secret files, before any request', async () => {
        const page = { site: SITE, frontmatter: { layout: 'pages/default.pug' }, message: 'Add it' }
        for (const [path, pattern] of [
            ['../pages/x.md', /"\." or "\.\." segments/],
            ['/pages/x.md', /is absolute/],
            ['pages\\x.md', /backslash/],
            ['pages/.git/x.md', /inside \.git\//],
            ['pages/.env', /can hold secrets/],
        ]) {
            expectError(await session.call('write_page', { ...page, path }), pattern)
        }
        expect(github.requests).toEqual([])
    })
})

describe('write_file', () => {
    it('creates and updates a file, one commit each, and leaves main alone', async () => {
        const created = await session.call('write_file', { site: SITE, path: 'config/navigation.yaml', content: 'items: []\n', message: 'Add the navigation' })
        expect(created.structuredContent).toEqual({ site: SITE, path: 'config/navigation.yaml', created: true, commit: draftHead(), branch: DRAFT })
        const first = draftHead()
        const updated = await session.call('write_file', { site: SITE, path: 'theme/assets/css/main.css', content: 'body { color: blue; }\n', message: 'Make it blue' })
        expect(updated.structuredContent).toMatchObject({ created: false, commit: draftHead() })
        expect(github.commit(SITE, DRAFT)).toMatchObject({ parents: [first], message: 'Make it blue' })
        expect(github.commit(SITE, first)).toMatchObject({ parents: [mainHead], message: 'Add the navigation' })
        const files = github.files(SITE, DRAFT)
        expect(files['config/navigation.yaml']).toBe('items: []\n')
        expect(files['theme/assets/css/main.css']).toBe('body { color: blue; }\n')
        expect(github.files(SITE, 'main')).toEqual(Object.fromEntries(Object.entries(SITE_FILES).map(([k, v]) => [k, typeof v === 'object' ? v.symlink : v])))
    })

    it('refuses pages, the output folder, node_modules, secrets, links and folders, changing nothing', async () => {
        const file = { site: SITE, content: 'x', message: 'Change it' }
        for (const [path, pattern] of [
            ['pages/about.md', /is a page\. Use write_page/],
            ['public/index.html', /in the output folder \(public\/\)/],
            ['public', /in the output folder/],
            ['node_modules/x/index.js', /inside node_modules\//],
            ['.npmrc', /can hold secrets/],
            ['config/.env.local', /can hold secrets/],
            ['.git/config', /inside \.git\//],
            ['docs/x.css', /below docs, which is a symbolic link/],
            ['docs', /is a symbolic link/],
            ['theme/views', /is a folder, not a file/],
            ['../x.css', /"\." or "\.\." segments/],
        ]) {
            expectError(await session.call('write_file', { ...file, path }), pattern)
        }
        expectError(await session.call('write_file', { ...file, path: 'x.css', message: '' }), /commit message is empty/)
        expectUntouched()
    })

    it('follows folders.dist from config/app.yaml', async () => {
        pushToDraft('config/app.yaml', 'folders:\n  dist: ./out\n')
        expectError(await session.call('write_file', { site: SITE, path: 'out/x.html', content: 'x', message: 'Change it' }), /output folder \(out\/\)/)
        const written = await session.call('write_file', { site: SITE, path: 'public/robots.txt', content: 'x', message: 'Add robots' })
        expect(written.isError).toBeFalsy()
    })

    it('refuses a repository outside the user\'s installations without writing', async () => {
        github.addRepo('else/site', SITE_FILES, { installation: 9 })
        github.installations.pop()
        expectError(await session.call('write_file', { site: 'else/site', path: 'x.css', content: 'x', message: 'Change it' }), /not one the Nera Static GitHub App can reach/)
        expect(writes()).toEqual([])
    })

    it('turns a GitHub refusal into a tool error without the token, and leaves the draft as it was', async () => {
        github.intercept = ({ method, path }) => (method === 'POST' && path.endsWith('/git/blobs')
            ? Response.json({ message: `Server Error for ${github.token}` }, { status: 500 })
            : undefined)
        const result = await session.call('write_file', { site: SITE, path: 'x.css', content: 'x', message: 'Change it' })
        expectError(result, /GitHub refused POST \/repos\/octo\/site\/git\/blobs: Server Error for \[token\]/)
        expect(JSON.stringify(result)).not.toContain(github.token)
        expect(draftHead()).toBe(mainHead)
    })
})

describe('delete_page', () => {
    it('deletes a page in one commit on the draft', async () => {
        const result = await session.call('delete_page', { site: SITE, path: 'pages/blog/first.md', message: 'Remove the first post' })
        expect(result.structuredContent).toEqual({ site: SITE, path: 'pages/blog/first.md', deleted: true, commit: draftHead(), branch: DRAFT })
        expect(textOf(result)).toMatch(/Deleted pages\/blog\/first\.md .*validate.*publish/)
        expect(github.commit(SITE, DRAFT)).toMatchObject({ parents: [mainHead], message: 'Remove the first post' })
        expect(github.files(SITE, DRAFT)['pages/blog/first.md']).toBeUndefined()
        expect(github.files(SITE, 'main')['pages/blog/first.md']).toBe(SITE_FILES['pages/blog/first.md'])
    })

    it('deletes the draft\'s own page that main never had', async () => {
        pushToDraft('pages/drafted.md', '---\nlayout: x\n---\n')
        const result = await session.call('delete_page', { site: SITE, path: 'pages/drafted.md', message: 'Drop it' })
        expect(result.isError).toBeFalsy()
        expect(github.files(SITE, DRAFT)['pages/drafted.md']).toBeUndefined()
    })

    it('refuses a missing page, a non-page and a secret, changing nothing', async () => {
        const page = { site: SITE, message: 'Remove it' }
        expectError(await session.call('delete_page', { ...page, path: 'pages/missing.md' }), /The page "pages\/missing\.md" does not exist/)
        expectError(await session.call('delete_page', { ...page, path: 'config/app.yaml' }), /not inside the site's pages folder/)
        expectError(await session.call('delete_page', { ...page, path: 'pages/.env' }), /can hold secrets/)
        expectUntouched()
    })

    it('is marked destructive', async () => {
        const { tools } = await session.client.listTools()
        expect(tools.find((tool) => tool.name === 'delete_page').annotations.destructiveHint).toBe(true)
        for (const name of ['write_page', 'write_file', 'delete_page']) {
            expect(tools.find((tool) => tool.name === name).inputSchema.required).toContain('message')
        }
    })
})
