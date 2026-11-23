import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RUN_LOOKUPS, RUN_LOOKUP_MS } from '../src/hosted/tools/publish.js'
import { connectHosted, fakeGitHub } from './fake-github.js'
import { SITE_PACKAGE, textOf } from './helpers.js'

const SITE = 'octo/site'
const DRAFT = 'nera-draft'
const PAGES_URL = 'https://octo.github.io/site/'

/** A Nera site's files, as `nera new` and a first `nera publish` leave them. */
const SITE_FILES = {
    'package.json': SITE_PACKAGE,
    'config/app.yaml': 'name: My site\nlang: en\norigin: https://www.example.org\n',
    'pages/index.md': '---\nlayout: pages/default.pug\ntitle: Home\n---\n\n# Welcome\n',
    'theme/views/pages/default.pug': 'p= meta.title\n',
    '.github/workflows/deploy.yml': 'on:\n    push:\n        branches: [main]\n',
}

let github
let session
let mainHead
let sleeps

beforeEach(async () => {
    github = fakeGitHub()
    github.addRepo(SITE, SITE_FILES)
    github.repos.get(SITE).pagesUrl = PAGES_URL
    mainHead = github.repos.get(SITE).refs.get('main')
    sleeps = []
    session = await connectHosted(github, { sleep: async (ms) => { sleeps.push(ms) } })
})

afterEach(async () => {
    await session.close()
})

/** Expects an `isError` result whose text matches `pattern`. */
function expectError(result, pattern) {
    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(pattern)
}

const repo = () => github.repos.get(SITE)
const mainSha = () => repo().refs.get('main')
const draftHead = () => repo().refs.get(DRAFT)
/** Every move of `main`: the fake starts one deploy run per move, as GitHub's push event does. */
const pushesToMain = () => repo().runs.length
/** The requests that change something on GitHub. */
const writes = () => github.requests.filter((request) => request.method !== 'GET')

/** Three changes through the write tools, as a model makes them. */
async function writeThree() {
    for (const [tool, args] of [
        ['write_page', { path: 'pages/about.md', frontmatter: { layout: 'pages/default.pug', title: 'About' }, body: 'Who we are.', message: 'Add the about page' }],
        ['write_file', { path: 'theme/assets/css/main.css', content: 'body { color: blue; }\n', message: 'Make it blue' }],
        ['write_page', { path: 'pages/index.md', frontmatter: { layout: 'pages/default.pug', title: 'Start' }, message: 'Rename the home page' }],
    ]) {
        const result = await session.call(tool, { site: SITE, ...args })
        expect(result.isError).toBeFalsy()
    }
}

describe('publish', () => {
    it('puts N writes live in exactly one push to main, deletes the draft and reports the deploy run and address', async () => {
        await writeThree()
        expect(pushesToMain()).toBe(0)
        const drafted = draftHead()

        const result = await session.call('publish', { site: SITE })
        expect(result.isError).toBeFalsy()
        expect(pushesToMain()).toBe(1)
        expect(mainSha()).toBe(drafted)
        expect(draftHead()).toBeUndefined()
        const [run] = repo().runs
        expect(result.structuredContent).toEqual({
            site: SITE,
            published: true,
            commits: 3,
            commit: drafted,
            fastForward: true,
            run: { id: run.id, status: 'queued', conclusion: null, url: run.html_url, sha: drafted, event: 'push', createdAt: run.created_at },
            url: PAGES_URL,
        })
        expect(textOf(result)).toMatch(/Published 3 commit\(s\) of "octo\/site" to main \(\w{7}\) and deleted the draft\. The deploy run is queued \(https:\/\/github\.com\/octo\/site\/actions\/runs\/\d+\)\. Once it succeeds, the site is live at https:\/\/octo\.github\.io\/site\//)
        expect(github.files(SITE, 'main')['pages/about.md']).toMatch(/Who we are\./)
        expect(sleeps).toEqual([])

        const again = await session.call('publish', { site: SITE })
        expect(again.isError).toBeFalsy()
        expect(pushesToMain()).toBe(1)
        expect(mainSha()).toBe(drafted)
        expect(again.structuredContent).toMatchObject({ published: false, commits: 0, commit: null, run: { id: run.id }, url: PAGES_URL })
        expect(textOf(again)).toMatch(/has no unpublished changes\. Nothing was pushed to main, so no deploy was started\. The deploy run is queued/)
    })

    it('makes one merge commit with the given message when main moved since the draft began', async () => {
        await writeThree()
        const elsewhere = github.pushFile(SITE, 'main', 'README.md', '# Site\n')
        expect(pushesToMain()).toBe(1)

        const result = await session.call('publish', { site: SITE, message: 'Publish the about page' })
        expect(result.isError).toBeFalsy()
        expect(pushesToMain()).toBe(2)
        expect(result.structuredContent).toMatchObject({ published: true, commits: 3, commit: mainSha(), fastForward: false, run: { sha: mainSha() } })
        expect(github.commit(SITE, 'main')).toMatchObject({ parents: [elsewhere, expect.any(String)], message: 'Publish the about page' })
        expect(draftHead()).toBeUndefined()
    })

    it('uses a default merge message when none is given', async () => {
        await writeThree()
        github.pushFile(SITE, 'main', 'README.md', '# Site\n')
        await session.call('publish', { site: SITE, message: '  ' })
        expect(github.commit(SITE, 'main').message).toBe('Publish the changes from nera-draft')
    })

    it('reports a merge conflict as an error that says what to do, keeping the draft and main', async () => {
        await writeThree()
        const elsewhere = github.pushFile(SITE, 'main', 'pages/about.md', 'conflicting\n')
        const drafted = draftHead()
        github.mergeConflict = true

        const result = await session.call('publish', { site: SITE })
        expectError(result, /draft of octo\/site conflicts with changes made to main.*merge nera-draft into main/)
        expect(mainSha()).toBe(elsewhere)
        expect(draftHead()).toBe(drafted)
        expect(pushesToMain()).toBe(1)
    })

    it('reports published: false when a racing publish put the draft live after this call counted it', async () => {
        await writeThree()
        const drafted = draftHead()
        let counted = false
        github.intercept = (request) => {
            if (request.path.includes('/compare/')) counted = true
            else if (counted && request.method === 'GET' && request.path.endsWith('/git/ref/heads/main')) {
                // The other call's fast-forward of main to the draft, with the deploy run its push starts.
                counted = false
                repo().refs.set('main', drafted)
                github.addRun(SITE, { head_sha: drafted })
            }
            return undefined
        }

        const result = await session.call('publish', { site: SITE })
        expect(result.isError).toBeFalsy()
        expect(result.structuredContent).toMatchObject({ published: false, commits: 0, commit: null, run: { sha: drafted } })
        expect(textOf(result)).toMatch(/The changes of "octo\/site" are already live on main, or were published by another call in the meantime\. Nothing was pushed to main/)
        expect(writes().filter(({ path }) => path.endsWith('/heads/main') || path.endsWith('/merges'))).toEqual([])
        expect(pushesToMain()).toBe(1)
        expect(mainSha()).toBe(drafted)
        expect(draftHead()).toBeUndefined()
    })

    it('pushes nothing without a draft and reports the latest run, the address from origin without Pages', async () => {
        repo().pagesUrl = null
        const old = github.addRun(SITE, { head_sha: mainHead, status: 'completed', conclusion: 'success' })

        const result = await session.call('publish', { site: SITE })
        expect(result.isError).toBeFalsy()
        expect(writes()).toEqual([])
        expect(mainSha()).toBe(mainHead)
        expect(result.structuredContent).toEqual({
            site: SITE,
            published: false,
            commits: 0,
            commit: null,
            run: expect.objectContaining({ id: old.id, status: 'completed', conclusion: 'success' }),
            url: 'https://www.example.org',
        })
        expect(textOf(result)).toMatch(/The deploy run is finished: success .* The site is at https:\/\/www\.example\.org\./)
    })

    it('deletes a draft without unpublished commits and pushes nothing to main', async () => {
        repo().refs.set(DRAFT, mainHead)

        const result = await session.call('publish', { site: SITE })
        expect(result.structuredContent).toMatchObject({ published: false, commits: 0, commit: null, run: null })
        expect(textOf(result)).toMatch(/held no unpublished commits, so it was deleted\. Nothing was pushed to main/)
        expect(draftHead()).toBeUndefined()
        expect(writes().map(({ method, path }) => `${method} ${path}`)).toEqual([`DELETE /repos/${SITE}/git/refs/heads/${DRAFT}`])
        expect(pushesToMain()).toBe(0)
    })

    it('looks for the deploy run a few times while GitHub starts it', async () => {
        await writeThree()
        let lookups = 0
        github.intercept = ({ path }) => {
            if (!path.includes('/actions/workflows/deploy.yml/runs')) return undefined
            lookups += 1
            return lookups < 3 ? Response.json({ total_count: 0, workflow_runs: [] }) : undefined
        }
        const result = await session.call('publish', { site: SITE })
        expect(result.structuredContent.run).toMatchObject({ sha: mainSha(), status: 'queued' })
        expect(sleeps).toEqual([RUN_LOOKUP_MS, RUN_LOOKUP_MS])
        const runQuery = github.requests.filter(({ path }) => path.includes('/actions/workflows/')).at(-1).path
        expect(runQuery).toContain(`head_sha=${mainSha()}`)
        expect(runQuery).toContain('branch=main')
        expect(runQuery).toContain('event=push')
    })

    it('still reports a publish when no run starts, Pages is refused and there is no origin', async () => {
        await session.call('write_file', { site: SITE, path: 'config/app.yaml', content: 'name: My site\n', message: 'Drop the origin' })
        github.intercept = ({ path }) => {
            if (path.endsWith('/pages')) return Response.json({ message: 'Resource not accessible by integration' }, { status: 403 })
            if (path.includes('/actions/workflows/deploy.yml/runs')) return Response.json({ total_count: 0, workflow_runs: [] })
            return undefined
        }

        const result = await session.call('publish', { site: SITE })
        expect(result.isError).toBeFalsy()
        expect(result.structuredContent).toMatchObject({ published: true, commits: 1, run: null, url: null })
        expect(sleeps).toHaveLength(RUN_LOOKUPS - 1)
        expect(textOf(result)).toMatch(/GitHub has not started the deploy run yet; call preview in a minute.*nera publish/)
        expect(textOf(result)).not.toMatch(/live at/)
    })

    it('does not report a run of another commit as the deploy of its push', async () => {
        await writeThree()
        github.intercept = ({ path }) => (path.includes('/actions/workflows/deploy.yml/runs')
            ? Response.json({ total_count: 1, workflow_runs: [{ id: 7, status: 'completed', conclusion: 'success', head_sha: mainHead, html_url: 'x', event: 'push' }] })
            : undefined)
        const result = await session.call('publish', { site: SITE })
        expect(result.structuredContent).toMatchObject({ published: true, run: null })
    })

    it('refuses a repository the user cannot reach without a request to it, and never shows the token', async () => {
        github.addRepo('else/site', SITE_FILES, { installation: 9 })
        github.installations.find(({ id }) => id === 9).repos = []
        expectError(await session.call('publish', { site: 'else/site' }), /not one the Nera Static GitHub App can reach/)
        expect(github.requests.some(({ path }) => path.startsWith('/repos/else/'))).toBe(false)

        // GitHub no longer accepts the token (revoked, App uninstalled).
        github.intercept = () => Response.json({ message: 'Bad credentials' }, { status: 401 })
        const refused = await session.call('publish', { site: SITE })
        expectError(refused, /Sign in again/)
        expect(JSON.stringify(refused)).not.toContain(github.token)
    })
})

describe('preview', () => {
    it('returns the live address, the latest run and the number of unpublished draft commits, changing nothing', async () => {
        await writeThree()
        const old = github.addRun(SITE, { head_sha: mainHead, status: 'completed', conclusion: 'failure' })
        const before = writes().length

        const result = await session.call('preview', { site: SITE })
        expect(result.isError).toBeFalsy()
        expect(writes()).toHaveLength(before)
        expect(result.structuredContent).toEqual({
            site: SITE,
            url: PAGES_URL,
            run: expect.objectContaining({ id: old.id, conclusion: 'failure', url: old.html_url }),
            draft: { exists: true, ahead: 3 },
        })
        expect(textOf(result)).toMatch(/"octo\/site" is served at https:\/\/octo\.github\.io\/site\/\. The deploy run is finished: failure .* 3 unpublished commit\(s\) wait on nera-draft; call publish/)
    })

    it('says when there is no address, no run and no draft', async () => {
        await session.close()
        github = fakeGitHub()
        const files = Object.fromEntries(Object.entries(SITE_FILES).filter(([file]) => !file.startsWith('.github/')))
        github.addRepo(SITE, { ...files, 'config/app.yaml': 'name: My site\n' })
        session = await connectHosted(github)
        const result = await session.call('preview', { site: SITE })
        expect(result.structuredContent).toEqual({ site: SITE, url: null, run: null, draft: { exists: false, ahead: 0 } })
        expect(textOf(result)).toMatch(/No address found for "octo\/site": GitHub Pages is not set up for it and config\/app\.yaml has no origin\. No run of \.github\/workflows\/deploy\.yml on main was found\. It has no unpublished changes\./)
    })
})
