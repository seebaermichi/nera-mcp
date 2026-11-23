// A fake GitHub REST API in memory, behind an injectable `fetch`: the user's
// App installations and their repositories, and per repository the git data
// (blobs, trees, commits, refs) the repo client (src/hosted/repo.js) reads and
// writes, plus contents (following a symbolic link to a file, as GitHub
// does), compares, merges, tarballs, the deploy workflow's runs (a run is
// started on every move of `main` while `main` holds the workflow file) and
// the GitHub Pages address. It records every request and
// accepts one token only. `github.intercept` lets a test answer a request
// itself (a lost race, an outage) before the fake does. `connectHosted`
// connects a real MCP client to the hosted server, talking to such a fake.
import { posix } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createCheckouts } from '../src/hosted/checkout.js'
import { createHostedServer } from '../src/hosted/mcp.js'
import { createRepoClient } from '../src/hosted/repo.js'

export const API = 'https://api.github.example'
const SYMLINK_MODE = '120000'

/**
 * @param {object} [options]
 * @param {string} [options.token] the only token the fake accepts
 */
export function fakeGitHub({ token = 'ghu_secret_token' } = {}) {
    let counter = 0
    const nextSha = () => (counter += 1).toString(16).padStart(40, '0')

    const github = {
        token,
        requests: [],
        /** @type {Array<{id: number, repos: string[]}>} */
        installations: [],
        /** @type {Map<string, object>} `owner/name` → git data */
        repos: new Map(),
        /** @type {null | ((request: {method: string, path: string, body: any}) => Response|undefined|Promise<Response|undefined>)} */
        intercept: null,
    }

    /**
     * Adds a repository whose `main` holds `files` in one commit.
     *
     * @param {string} fullName `owner/name`
     * @param {Record<string, string|{symlink: string}>} files path → content, or a symbolic link to `symlink` (relative to the link's folder)
     * @param {object} [options]
     * @param {number} [options.installation] the installation that reaches it
     * @param {boolean} [options.private]
     */
    github.addRepo = (fullName, files, { installation = 1, private: isPrivate = false } = {}) => {
        const repo = { fullName, private: isPrivate, blobs: new Map(), trees: new Map(), commits: new Map(), refs: new Map(), tarball: Buffer.from(`tarball of ${fullName}`), runs: [], pagesUrl: null }
        github.repos.set(fullName, repo)
        const entries = new Map()
        for (const [path, content] of Object.entries(files)) {
            entries.set(path, typeof content === 'object'
                ? { sha: github.addBlob(fullName, content.symlink), mode: SYMLINK_MODE }
                : { sha: github.addBlob(fullName, content), mode: '100644' })
        }
        const tree = nextSha()
        repo.trees.set(tree, entries)
        const commit = nextSha()
        repo.commits.set(commit, { tree, parents: [], message: 'Initial commit' })
        repo.refs.set('main', commit)
        let entry = github.installations.find((candidate) => candidate.id === installation)
        if (!entry) github.installations.push(entry = { id: installation, repos: [] })
        entry.repos.push(fullName)
        return repo
    }

    github.addBlob = (fullName, content) => {
        const sha = nextSha()
        github.repos.get(fullName).blobs.set(sha, Buffer.from(content))
        return sha
    }

    /** The files on `ref` (a branch or commit) as path → text. */
    github.files = (fullName, ref) => {
        const repo = github.repos.get(fullName)
        const commit = repo.commits.get(repo.refs.get(ref) ?? ref)
        const files = {}
        for (const [path, { sha }] of repo.trees.get(commit.tree)) files[path] = repo.blobs.get(sha).toString('utf8')
        return files
    }

    /** The commit `ref` points at, as stored. */
    github.commit = (fullName, ref) => {
        const repo = github.repos.get(fullName)
        return repo.commits.get(repo.refs.get(ref) ?? ref)
    }

    let runCounter = 0
    /**
     * Adds a run of `.github/workflows/<workflow>` to the repository, newest
     * first, as GitHub lists them.
     *
     * @param {string} fullName
     * @param {object} run `head_sha` and anything to override (`status`, `conclusion`, `event`, `head_branch`, `path`)
     */
    github.addRun = (fullName, run) => {
        runCounter += 1
        const added = {
            id: runCounter,
            status: 'queued',
            conclusion: null,
            event: 'push',
            head_branch: 'main',
            path: '.github/workflows/deploy.yml',
            html_url: `https://github.com/${fullName}/actions/runs/${runCounter}`,
            created_at: new Date(Date.UTC(2026, 10, 23, 10, 0, runCounter)).toISOString(),
            ...run,
        }
        github.repos.get(fullName).runs.unshift(added)
        return added
    }

    /** Moves `branch` to `sha`; a move of `main` starts a deploy run when `main` holds the workflow. */
    function moveRef(repo, branch, sha) {
        repo.refs.set(branch, sha)
        if (branch !== 'main') return
        const entries = repo.trees.get(repo.commits.get(sha).tree)
        if (entries.has('.github/workflows/deploy.yml')) github.addRun(repo.fullName, { head_sha: sha })
    }

    /** Adds a commit to `branch` directly, as another client pushing would. */
    github.pushFile = (fullName, branch, path, content, message = 'Pushed elsewhere') => {
        const repo = github.repos.get(fullName)
        const parent = repo.refs.get(branch)
        const entries = new Map(repo.trees.get(repo.commits.get(parent).tree))
        entries.set(path, { sha: github.addBlob(fullName, content), mode: '100644' })
        const tree = nextSha()
        repo.trees.set(tree, entries)
        const commit = nextSha()
        repo.commits.set(commit, { tree, parents: [parent], message })
        moveRef(repo, branch, commit)
        return commit
    }

    const json = (body, status = 200) => Response.json(body, { status })
    const notFound = () => json({ message: 'Not Found' }, 404)

    function isAncestor(repo, ancestor, sha) {
        const queue = [sha]
        while (queue.length) {
            const current = queue.shift()
            if (current === ancestor) return true
            queue.push(...(repo.commits.get(current)?.parents ?? []))
        }
        return false
    }

    function listing(items, url, key) {
        const perPage = Number(url.searchParams.get('per_page') ?? 30)
        const page = Number(url.searchParams.get('page') ?? 1)
        return json({ total_count: items.length, [key]: items.slice((page - 1) * perPage, page * perPage) })
    }

    function repoAnswer(repo, method, rest, url, body) {
        const name = repo.fullName
        let match
        if (method === 'GET' && (match = rest.match(/^git\/ref\/heads\/(.+)$/))) {
            const sha = repo.refs.get(decodeURIComponent(match[1]))
            return sha ? json({ ref: `refs/heads/${match[1]}`, object: { sha, type: 'commit' } }) : notFound()
        }
        if (method === 'POST' && rest === 'git/refs') {
            const branch = body.ref.replace(/^refs\/heads\//, '')
            if (repo.refs.has(branch)) return json({ message: 'Reference already exists' }, 422)
            repo.refs.set(branch, body.sha)
            return json({ ref: body.ref, object: { sha: body.sha } }, 201)
        }
        if ((method === 'PATCH' || method === 'DELETE') && (match = rest.match(/^git\/refs\/heads\/(.+)$/))) {
            const branch = decodeURIComponent(match[1])
            if (!repo.refs.has(branch)) return json({ message: 'Reference does not exist' }, 422)
            if (method === 'DELETE') {
                repo.refs.delete(branch)
                return new Response(null, { status: 204 })
            }
            if (!body.force && !isAncestor(repo, repo.refs.get(branch), body.sha)) {
                return json({ message: 'Update is not a fast forward' }, 422)
            }
            moveRef(repo, branch, body.sha)
            return json({ ref: `refs/heads/${branch}`, object: { sha: body.sha } })
        }
        if (method === 'GET' && (match = rest.match(/^git\/commits\/(\w+)$/))) {
            const commit = repo.commits.get(match[1])
            return commit ? json({ sha: match[1], tree: { sha: commit.tree }, parents: commit.parents.map((sha) => ({ sha })), message: commit.message }) : notFound()
        }
        if (method === 'POST' && rest === 'git/blobs') {
            const sha = nextSha()
            repo.blobs.set(sha, Buffer.from(body.content, body.encoding === 'base64' ? 'base64' : 'utf8'))
            return json({ sha }, 201)
        }
        if (method === 'GET' && (match = rest.match(/^git\/blobs\/(\w+)$/))) {
            const blob = repo.blobs.get(match[1])
            return blob ? json({ sha: match[1], content: blob.toString('base64'), encoding: 'base64', size: blob.length }) : notFound()
        }
        if (method === 'POST' && rest === 'git/trees') {
            const base = repo.trees.get(body.base_tree)
            if (!base) return json({ message: 'Invalid base_tree' }, 422)
            const entries = new Map(base)
            for (const entry of body.tree) {
                if (entry.sha === null) {
                    if (!entries.delete(entry.path)) return json({ message: 'GitRPC::BadObjectState' }, 422)
                } else {
                    entries.set(entry.path, { sha: entry.sha, mode: entry.mode })
                }
            }
            const sha = nextSha()
            repo.trees.set(sha, entries)
            return json({ sha }, 201)
        }
        if (method === 'POST' && rest === 'git/commits') {
            const sha = nextSha()
            repo.commits.set(sha, { tree: body.tree, parents: body.parents, message: body.message })
            return json({ sha }, 201)
        }
        if (method === 'GET' && (match = rest.match(/^git\/trees\/([^/?]+)$/))) {
            const ref = decodeURIComponent(match[1])
            const commit = repo.commits.get(repo.refs.get(ref) ?? ref)
            if (!commit) return notFound()
            const entries = repo.trees.get(commit.tree)
            const folders = new Set()
            for (const path of entries.keys()) {
                const parts = path.split('/')
                for (let i = 1; i < parts.length; i += 1) folders.add(parts.slice(0, i).join('/'))
            }
            const tree = [
                ...[...folders].map((path) => ({ path, type: 'tree', mode: '040000', sha: nextSha() })),
                ...[...entries].map(([path, { sha, mode }]) => ({ path, type: 'blob', mode, sha, size: repo.blobs.get(sha).length })),
            ].sort((a, b) => a.path.localeCompare(b.path))
            return json({ sha: commit.tree, tree, truncated: false })
        }
        if (method === 'GET' && (match = rest.match(/^contents\/(.+)$/))) {
            const path = match[1].split('/').map(decodeURIComponent).join('/')
            const ref = url.searchParams.get('ref') ?? 'main'
            const commit = repo.commits.get(repo.refs.get(ref) ?? ref)
            if (!commit) return notFound()
            const entries = repo.trees.get(commit.tree)
            let file = entries.get(path)
            let filePath = path
            if (file?.mode === SYMLINK_MODE) {
                // Like GitHub: a link to a file answers with the target, anything else describes the link.
                const target = posix.normalize(posix.join(posix.dirname(path), repo.blobs.get(file.sha).toString('utf8')))
                const targetFile = entries.get(target)
                if (!targetFile || targetFile.mode === SYMLINK_MODE) {
                    return json({ type: 'symlink', path, sha: file.sha, target: repo.blobs.get(file.sha).toString('utf8') })
                }
                file = targetFile
                filePath = target
            }
            if (file) {
                const blob = repo.blobs.get(file.sha)
                const large = blob.length > 1024 * 1024
                return json({ type: 'file', path: filePath, sha: file.sha, size: blob.length, encoding: large ? 'none' : 'base64', content: large ? '' : blob.toString('base64') })
            }
            const children = [...entries.keys()].filter((candidate) => candidate.startsWith(`${path}/`))
            return children.length ? json(children.map((child) => ({ type: 'file', path: child }))) : notFound()
        }
        if (method === 'GET' && (match = rest.match(/^compare\/([^.]+)\.\.\.([^?]+)$/))) {
            const base = repo.refs.get(decodeURIComponent(match[1])) ?? decodeURIComponent(match[1])
            const head = repo.refs.get(decodeURIComponent(match[2])) ?? decodeURIComponent(match[2])
            if (!repo.commits.has(base) || !repo.commits.has(head)) return notFound()
            const reachable = (start) => {
                const seen = new Set()
                const queue = [start]
                while (queue.length) {
                    const current = queue.shift()
                    if (seen.has(current)) continue
                    seen.add(current)
                    queue.push(...repo.commits.get(current).parents)
                }
                return seen
            }
            const fromBase = reachable(base)
            const fromHead = reachable(head)
            const aheadBy = [...fromHead].filter((sha) => !fromBase.has(sha)).length
            const behindBy = [...fromBase].filter((sha) => !fromHead.has(sha)).length
            return json({ ahead_by: aheadBy, behind_by: behindBy })
        }
        if (method === 'POST' && rest === 'merges') {
            const base = repo.refs.get(body.base)
            const head = repo.refs.get(body.head)
            if (!base || !head) return notFound()
            if (isAncestor(repo, head, base)) return new Response(null, { status: 204 })
            if (github.mergeConflict) return json({ message: 'Merge conflict' }, 409)
            const sha = nextSha()
            repo.commits.set(sha, { tree: repo.commits.get(head).tree, parents: [base, head], message: body.commit_message })
            moveRef(repo, body.base, sha)
            return json({ sha }, 201)
        }
        if (method === 'GET' && (match = rest.match(/^actions\/workflows\/([^/]+)\/runs$/))) {
            const workflow = `.github/workflows/${decodeURIComponent(match[1])}`
            const main = repo.commits.get(repo.refs.get('main'))
            if (!main || !repo.trees.get(main.tree).has(workflow)) return notFound()
            const filters = ['branch', 'head_sha', 'event'].map((key) => [key, url.searchParams.get(key)]).filter(([, value]) => value !== null)
            const runs = repo.runs.filter((run) => run.path === workflow
                && filters.every(([key, value]) => (key === 'branch' ? run.head_branch : run[key]) === value))
            return listing(runs, url, 'workflow_runs')
        }
        if (method === 'GET' && rest === 'pages') {
            return repo.pagesUrl ? json({ html_url: repo.pagesUrl, status: 'built' }) : notFound()
        }
        if (method === 'GET' && rest.startsWith('tarball/')) {
            return new Response(repo.tarball, { status: 200, headers: { 'Content-Type': 'application/x-gzip', 'Content-Length': String(repo.tarball.length) } })
        }
        return json({ message: `The fake has no ${method} ${name}/${rest}` }, 404)
    }

    async function answer(method, url, body) {
        let match
        if (method === 'GET' && url.pathname === '/user/installations') {
            return listing(github.installations.map(({ id }) => ({ id })), url, 'installations')
        }
        if (method === 'GET' && (match = url.pathname.match(/^\/user\/installations\/(\d+)\/repositories$/))) {
            const installation = github.installations.find(({ id }) => id === Number(match[1]))
            if (!installation) return notFound()
            const repos = installation.repos.map((fullName) => ({
                full_name: fullName,
                name: fullName.split('/')[1],
                owner: { login: fullName.split('/')[0] },
                default_branch: 'main',
                private: github.repos.get(fullName).private,
            }))
            return listing(repos, url, 'repositories')
        }
        if ((match = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/(.+)$/))) {
            const repo = github.repos.get(match[1])
            return repo ? repoAnswer(repo, method, match[2], url, body) : notFound()
        }
        return notFound()
    }

    github.fetch = async (input, init = {}) => {
        const url = new URL(String(input))
        const method = init.method ?? 'GET'
        const body = init.body ? JSON.parse(String(init.body)) : undefined
        const request = { method, path: url.pathname + url.search, body, headers: init.headers ?? {} }
        github.requests.push(request)
        if (url.origin !== API) return notFound()
        const intercepted = github.intercept ? await github.intercept(request) : undefined
        if (intercepted) return intercepted
        if (request.headers.Authorization !== `Bearer ${github.token}`) return json({ message: 'Bad credentials' }, 401)
        return answer(method, url, body)
    }

    return github
}

/**
 * A real MCP client connected in memory to the hosted server, signed in as
 * `userId` with the fake's token. `githubToken` can be replaced to fake a lost
 * sign-in.
 *
 * @param {ReturnType<typeof fakeGitHub>} github
 * @param {object} [options]
 * @param {(userId: string) => Promise<string>} [options.githubToken]
 * @param {string} [options.userId]
 * @param {ReturnType<typeof import('../src/hosted/checkout.js').createCheckouts>} [options.checkouts] validate's checkouts; one whose runner and registry refuse every call by default
 * @param {(ms: number) => Promise<void>} [options.sleep] publish's pause between run lookups; none by default
 */
export async function connectHosted(github, {
    githubToken = async () => github.token,
    userId = 'user-1',
    checkouts = createCheckouts({
        runner: async (command) => { throw new Error(`${command} is not expected in this test`) },
        fetch: async () => { throw new Error('the registry is not expected in this test') },
    }),
    sleep = async () => {},
} = {}) {
    const tokenRequests = []
    const server = createHostedServer({
        fetch: async () => { throw new Error('the registry is not expected in this test') },
        sleep,
        userId,
        githubToken: async (id) => {
            tokenRequests.push(id)
            return githubToken(id)
        },
        createRepo: (token) => createRepoClient({ token, fetch: github.fetch, apiUrl: API }),
        checkouts,
    })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'nera-mcp-test', version: '0.0.0' })
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    return {
        client,
        tokenRequests,
        call: (name, args = {}) => client.callTool({ name, arguments: args }),
        close: async () => {
            await client.close()
            await server.close()
        },
    }
}
