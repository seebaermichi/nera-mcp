import { beforeEach, describe, expect, it } from 'vitest'
import { GitHubError } from '../src/hosted/github.js'
import { BASE_BRANCH, createRepoClient, DRAFT_BRANCH, repoName, repoPath } from '../src/hosted/repo.js'
import { ToolError } from '../src/results.js'
import { API, fakeGitHub } from './fake-github.js'

const SITE = 'octo/site'
const FILES = {
    'package.json': '{"dependencies":{"@nera-static/nera":"^1.27.0"}}\n',
    'config/app.yaml': 'name: Site\n',
    'pages/index.md': '---\nlayout: pages/default.pug\n---\n\n# Home\n',
}

let github
let client

beforeEach(() => {
    github = fakeGitHub()
    github.addRepo(SITE, FILES)
    client = createRepoClient({ token: github.token, fetch: github.fetch, apiUrl: API })
})

/** The error a promise rejects with. */
async function rejection(promise) {
    try {
        await promise
    } catch (error) {
        return error
    }
    throw new Error('expected the promise to reject')
}

/** Answers the first `count` requests matching `method` and `path` with `respond()`. */
function interceptFirst(count, method, path, respond) {
    let left = count
    github.intercept = async (request) => {
        if (left > 0 && request.method === method && request.path === path) {
            left -= 1
            return respond(request)
        }
        return undefined
    }
}

describe('repoPath', () => {
    it('accepts relative POSIX paths unchanged', () => {
        expect(repoPath('pages/about.md')).toBe('pages/about.md')
        expect(repoPath('.neraignore')).toBe('.neraignore')
        expect(repoPath('theme/views/my..file.pug')).toBe('theme/views/my..file.pug')
    })

    it.each([
        ['', /is empty/],
        ['/etc/passwd', /is absolute/],
        ['../secret', /"\." or "\.\." segments/],
        ['pages/../../x', /"\." or "\.\." segments/],
        ['pages/..', /"\." or "\.\." segments/],
        ['./pages/a.md', /"\." or "\.\." segments/],
        ['pages\\about.md', /backslash/],
        ['pages//about.md', /empty segment/],
        ['pages/', /empty segment/],
        ['pages/a\nb.md', /control character/],
    ])('refuses %j', (input, message) => {
        expect(() => repoPath(input)).toThrow(ToolError)
        expect(() => repoPath(input)).toThrow(message)
    })
})

describe('repoName', () => {
    it('accepts owner/name', () => {
        expect(repoName('octo/my-site.github.io')).toBe('octo/my-site.github.io')
    })

    it.each(['octo', 'octo/site/extra', 'octo/..', 'octo/.git', '../site', 'octo/si te', ''])('refuses %j', (site) => {
        expect(() => repoName(site)).toThrow(ToolError)
    })

    it('is checked before any request goes out', async () => {
        await expect(client.branchHead('octo/../../user', BASE_BRANCH)).rejects.toThrow(ToolError)
        expect(github.requests).toHaveLength(0)
    })
})

describe('createRepoClient', () => {
    it('needs a token', () => {
        expect(() => createRepoClient({ token: '', fetch: github.fetch })).toThrow(/token/)
    })

    it('sends the token as a bearer header only, never in a URL', async () => {
        await client.listRepos()
        await client.readFile(SITE, 'config/app.yaml', BASE_BRANCH)
        expect(github.requests.length).toBeGreaterThan(0)
        for (const request of github.requests) {
            expect(request.headers.Authorization).toBe(`Bearer ${github.token}`)
            expect(request.path).not.toContain(github.token)
        }
    })
})

describe('listRepos', () => {
    it('lists the repositories of every installation once, sorted', async () => {
        github.addRepo('acme/docs', {}, { installation: 2, private: true })
        github.installations.find(({ id }) => id === 2).repos.push(SITE)
        expect(await client.listRepos()).toEqual([
            { site: 'acme/docs', owner: 'acme', name: 'docs', defaultBranch: 'main', private: true },
            { site: SITE, owner: 'octo', name: 'site', defaultBranch: 'main', private: false },
        ])
    })

    it('follows the pages of a long listing', async () => {
        for (let i = 0; i < 100; i += 1) github.addRepo(`octo/extra-${String(i).padStart(3, '0')}`, {})
        const repos = await client.listRepos()
        expect(repos).toHaveLength(101)
        expect(github.requests.filter(({ path }) => path.startsWith('/user/installations/1/repositories'))).toHaveLength(2)
    })
})

describe('reading', () => {
    it('reads a file, a folder and a missing path at a ref', async () => {
        const file = await client.readFile(SITE, 'config/app.yaml', BASE_BRANCH)
        expect(file).toMatchObject({ type: 'file', size: FILES['config/app.yaml'].length })
        expect(file.content.toString('utf8')).toBe(FILES['config/app.yaml'])
        expect(await client.readFile(SITE, 'pages', BASE_BRANCH)).toEqual({ type: 'dir' })
        expect(await client.readFile(SITE, 'pages/missing.md', BASE_BRANCH)).toBeNull()
    })

    it('reads a file over 1 MB through the blob API', async () => {
        const large = 'x'.repeat(1024 * 1024 + 1)
        github.pushFile(SITE, BASE_BRANCH, 'assets/large.txt', large)
        const file = await client.readFile(SITE, 'assets/large.txt', BASE_BRANCH)
        expect(file.content.toString('utf8')).toBe(large)
        expect(github.requests.some(({ path }) => path.includes('/git/blobs/'))).toBe(true)
    })

    it('refuses an escaping path before asking GitHub', async () => {
        await expect(client.readFile(SITE, '../other/secret', BASE_BRANCH)).rejects.toThrow(ToolError)
        expect(github.requests).toHaveLength(0)
    })

    it('lists the files and folders of a ref', async () => {
        const { entries, truncated } = await client.readTree(SITE, BASE_BRANCH)
        expect(truncated).toBe(false)
        expect(entries.map(({ path, type }) => `${type} ${path}`)).toEqual([
            'tree config',
            'blob config/app.yaml',
            'blob package.json',
            'tree pages',
            'blob pages/index.md',
        ])
        expect(entries.find(({ path }) => path === 'package.json').size).toBe(FILES['package.json'].length)
    })

    it('reads a branch head, null for a branch that does not exist', async () => {
        expect(await client.branchHead(SITE, BASE_BRANCH)).toBe(github.repos.get(SITE).refs.get('main'))
        expect(await client.branchHead(SITE, DRAFT_BRANCH)).toBeNull()
    })
})

describe('the draft branch', () => {
    it('is created from main once', async () => {
        const main = github.repos.get(SITE).refs.get('main')
        expect(await client.ensureDraft(SITE)).toEqual({ sha: main, created: true })
        expect(await client.ensureDraft(SITE)).toEqual({ sha: main, created: false })
        expect(github.repos.get(SITE).refs.get(DRAFT_BRANCH)).toBe(main)
    })

    it('needs a main branch to start from', async () => {
        github.repos.get(SITE).refs.delete('main')
        const error = await rejection(client.ensureDraft(SITE))
        expect(error).toBeInstanceOf(GitHubError)
        expect(error.message).toMatch(/no main branch/)
    })
})

describe('commitFile', () => {
    beforeEach(async () => {
        await client.ensureDraft(SITE)
    })

    it('writes a file in exactly one commit on the draft, with the given message', async () => {
        const before = github.repos.get(SITE).refs.get(DRAFT_BRANCH)
        const { sha } = await client.commitFile(SITE, { path: 'pages/about.md', content: '# About\n', message: 'Add the about page' })
        const commit = github.commit(SITE, DRAFT_BRANCH)
        expect(github.repos.get(SITE).refs.get(DRAFT_BRANCH)).toBe(sha)
        expect(commit).toMatchObject({ parents: [before], message: 'Add the about page' })
        expect(github.files(SITE, DRAFT_BRANCH)).toEqual({ ...FILES, 'pages/about.md': '# About\n' })
        expect(github.files(SITE, BASE_BRANCH)).toEqual(FILES)
        expect(github.requests.filter(({ method, path }) => method === 'POST' && path.endsWith('/git/commits'))).toHaveLength(1)
    })

    it('deletes a file in one commit', async () => {
        await client.commitFile(SITE, { path: 'pages/index.md', content: null, message: 'Remove the home page' })
        expect(github.files(SITE, DRAFT_BRANCH)).not.toHaveProperty('pages/index.md')
        expect(github.commit(SITE, DRAFT_BRANCH).message).toBe('Remove the home page')
    })

    it('refuses an empty message and an escaping path', async () => {
        github.requests.length = 0
        await expect(client.commitFile(SITE, { path: 'pages/a.md', content: 'a', message: ' ' })).rejects.toThrow(/commit message is empty/)
        await expect(client.commitFile(SITE, { path: 'pages/../../a.md', content: 'a', message: 'm' })).rejects.toThrow(ToolError)
        expect(github.requests).toHaveLength(0)
    })

    it('commits once more on the new head when the ref update loses a race', async () => {
        const draftRef = `/repos/${SITE}/git/refs/heads/${DRAFT_BRANCH}`
        let theirs
        interceptFirst(1, 'PATCH', draftRef, () => {
            theirs = github.pushFile(SITE, DRAFT_BRANCH, 'pages/theirs.md', 'theirs\n')
            return undefined // the fake now answers 422: not a fast-forward
        })
        await client.commitFile(SITE, { path: 'pages/mine.md', content: 'mine\n', message: 'Add mine' })
        expect(github.commit(SITE, DRAFT_BRANCH)).toMatchObject({ parents: [theirs], message: 'Add mine' })
        expect(github.files(SITE, DRAFT_BRANCH)).toMatchObject({ 'pages/theirs.md': 'theirs\n', 'pages/mine.md': 'mine\n' })
        expect(github.requests.filter(({ method, path }) => method === 'PATCH' && path === draftRef)).toHaveLength(2)
    })

    it('reports a second lost race, without the token', async () => {
        const draftRef = `/repos/${SITE}/git/refs/heads/${DRAFT_BRANCH}`
        interceptFirst(2, 'PATCH', draftRef, () => Response.json({ message: 'Update is not a fast forward' }, { status: 422 }))
        const before = github.repos.get(SITE).refs.get(DRAFT_BRANCH)
        const error = await rejection(client.commitFile(SITE, { path: 'pages/mine.md', content: 'mine\n', message: 'Add mine' }))
        expect(error).toBeInstanceOf(GitHubError)
        expect(error).toMatchObject({ code: 'conflict', status: 422 })
        expect(error.message).toMatch(/changed twice while committing pages\/mine\.md/)
        expect(error.message).not.toContain(github.token)
        expect(github.repos.get(SITE).refs.get(DRAFT_BRANCH)).toBe(before)
        expect(github.requests.filter(({ method, path }) => method === 'PATCH' && path === draftRef)).toHaveLength(2)
    })
})

describe('mergeDraft', () => {
    it('fast-forwards main to the draft and deletes the draft', async () => {
        await client.ensureDraft(SITE)
        await client.commitFile(SITE, { path: 'pages/a.md', content: 'a\n', message: 'Add a' })
        await client.commitFile(SITE, { path: 'pages/b.md', content: 'b\n', message: 'Add b' })
        const head = github.repos.get(SITE).refs.get(DRAFT_BRANCH)
        expect(await client.mergeDraft(SITE, 'Publish')).toEqual({ sha: head, fastForward: true })
        expect(github.repos.get(SITE).refs.get('main')).toBe(head)
        expect(github.repos.get(SITE).refs.has(DRAFT_BRANCH)).toBe(false)
        expect(github.requests.filter(({ method, path }) => method === 'PATCH' && path.endsWith('/heads/main'))).toHaveLength(1)
    })

    it('merges with a commit when main moved in the meantime', async () => {
        await client.ensureDraft(SITE)
        await client.commitFile(SITE, { path: 'pages/a.md', content: 'a\n', message: 'Add a' })
        github.pushFile(SITE, 'main', 'README.md', 'readme\n')
        const result = await client.mergeDraft(SITE, 'Publish the draft')
        expect(result.fastForward).toBe(false)
        expect(github.repos.get(SITE).refs.get('main')).toBe(result.sha)
        expect(github.commit(SITE, 'main').message).toBe('Publish the draft')
        expect(github.repos.get(SITE).refs.has(DRAFT_BRANCH)).toBe(false)
    })

    it('reports a conflict and keeps the draft', async () => {
        await client.ensureDraft(SITE)
        await client.commitFile(SITE, { path: 'pages/a.md', content: 'a\n', message: 'Add a' })
        github.pushFile(SITE, 'main', 'pages/a.md', 'other\n')
        github.mergeConflict = true
        const error = await rejection(client.mergeDraft(SITE, 'Publish'))
        expect(error).toMatchObject({ code: 'merge_conflict', status: 409 })
        expect(github.repos.get(SITE).refs.has(DRAFT_BRANCH)).toBe(true)
    })

    it('returns null when there is no draft', async () => {
        expect(await client.mergeDraft(SITE, 'Publish')).toBeNull()
    })
})

describe('downloadTarball', () => {
    it('downloads the bytes', async () => {
        const tarball = await client.downloadTarball(SITE, BASE_BRANCH)
        expect(tarball.equals(github.repos.get(SITE).tarball)).toBe(true)
    })

    it('refuses a tarball over the cap by its length', async () => {
        const error = await rejection(client.downloadTarball(SITE, BASE_BRANCH, { maxBytes: 4 }))
        expect(error).toMatchObject({ code: 'too_large' })
    })

    it('refuses a tarball over the cap while streaming, when no length is sent', async () => {
        github.intercept = async (request) => request.path.includes('/tarball/')
            ? new Response(new ReadableStream({
                start(controller) {
                    controller.enqueue(new Uint8Array(3))
                    controller.enqueue(new Uint8Array(3))
                    controller.close()
                },
            }))
            : undefined
        const error = await rejection(client.downloadTarball(SITE, BASE_BRANCH, { maxBytes: 4 }))
        expect(error).toMatchObject({ code: 'too_large' })
    })
})

describe('errors never carry the token', () => {
    it('when fetch itself fails', async () => {
        const failing = createRepoClient({
            token: github.token,
            apiUrl: API,
            fetch: async () => { throw new TypeError(`connect failed for ${github.token}`) },
        })
        const error = await rejection(failing.listRepos())
        expect(error).toBeInstanceOf(GitHubError)
        expect(error.message).toBe('Cannot reach GitHub: connect failed for [token]')
        expect(error.cause).toBeUndefined()
    })

    it('when GitHub refuses the token', async () => {
        const stale = createRepoClient({ token: 'ghu_stale_token', fetch: github.fetch, apiUrl: API })
        const error = await rejection(stale.listRepos())
        expect(error).toMatchObject({ status: 401 })
        expect(error.message).toBe('GitHub refused GET /user/installations: Bad credentials')
    })

    it('when GitHub echoes it in a message', async () => {
        github.intercept = async () => Response.json({ message: `token ${github.token} is suspended` }, { status: 403 })
        const error = await rejection(client.readTree(SITE, BASE_BRANCH))
        expect(error.message).toBe(`GitHub refused GET /repos/${SITE}/git/trees/main: token [token] is suspended`)
    })
})
