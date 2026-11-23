// The GitHub repository side of the hosted mode (L7b, plan D2–D6): the user's
// repository is the working copy. This client reads files and trees, keeps the
// draft branch `nera-draft` (every write commits there, so nothing deploys),
// commits one file change at a time through the Git Data API, merges the
// draft into `main` (one push, so one deploy), downloads a tarball for
// `validate` and reads the deploy workflow's runs and the GitHub Pages
// address for `publish` and `preview`. It is GitHub plumbing, not Nera logic;
// the page rules live in src/pages.js. Every call goes through the injected
// `fetch`, so tests never touch the network, and no message it builds can
// carry the token.
import { ToolError } from '../results.js'
import { GitHubError } from './github.js'

const USER_AGENT = 'nera-mcp'
const API_VERSION = '2022-11-28'
/** The branch a site deploys from. */
export const BASE_BRANCH = 'main'
/** The branch every write commits to until `publish` merges it (plan D2). */
export const DRAFT_BRANCH = 'nera-draft'
/** GitHub's largest page size; more than this many pages of repositories is not followed. */
const PER_PAGE = 100
const MAX_PAGES = 10
/** The default cap on a downloaded tarball. */
const MAX_TARBALL_BYTES = 50 * 1024 * 1024
/** git's modes of a regular and of an executable file. */
const FILE_MODE = '100644'
const EXECUTABLE_MODE = '100755'
/** `owner/name` as GitHub allows them: no slashes, dots or spaces where they could leave the API path. */
const REPO_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/

/**
 * Reads a response body of at most `maxBytes`: a larger `content-length` is
 * refused before reading, a body that grows past the cap while it streams is
 * refused the moment it does.
 *
 * @param {Response} response
 * @param {number} maxBytes
 * @param {() => Error} tooLarge the error to throw
 * @returns {Promise<Buffer>}
 */
export async function readLimited(response, maxBytes, tooLarge) {
    if (Number(response.headers.get('content-length')) > maxBytes) {
        await response.body?.cancel()
        throw tooLarge()
    }
    const chunks = []
    let size = 0
    for await (const chunk of response.body ?? []) {
        size += chunk.length
        if (size > maxBytes) throw tooLarge()
        chunks.push(chunk)
    }
    return Buffer.concat(chunks)
}

/**
 * Checks a repository path a model passed: relative, POSIX, no `..`, `.` or
 * empty segments, no backslashes. There is no filesystem to `realpath`
 * against, so the path itself is all there is to check.
 *
 * @param {string} input e.g. `pages/about.md`
 * @param {string} [label] how the message names the argument
 * @returns {string} the same path, safe to put into an API URL and a tree entry
 * @throws {ToolError}
 */
export function repoPath(input, label = 'path') {
    if (typeof input !== 'string' || input === '') {
        throw new ToolError(`The ${label} is empty. Give a path relative to the repository root, e.g. pages/about.md.`)
    }
    if (input.includes('\\')) {
        throw new ToolError(`The ${label} "${input}" contains a backslash. Use forward slashes, e.g. pages/blog/post.md.`)
    }
    if (input.startsWith('/')) {
        throw new ToolError(`The ${label} "${input}" is absolute. Give it relative to the repository root, e.g. ${input.replace(/^\/+/, '') || 'pages/about.md'}.`)
    }
    const segments = input.split('/')
    if (segments.some((segment) => segment === '')) {
        throw new ToolError(`The ${label} "${input}" has an empty segment (a doubled or trailing /). Give it like pages/blog/post.md.`)
    }
    if (segments.some((segment) => segment === '..' || segment === '.')) {
        throw new ToolError(`The ${label} "${input}" contains "." or ".." segments. Give the path inside the repository directly, e.g. pages/about.md.`)
    }
    if (/[\0-\x1f]/.test(input)) {
        throw new ToolError(`The ${label} "${input}" contains a control character.`)
    }
    return input
}

/**
 * Checks a site name: a GitHub repository as `owner/name`.
 *
 * @param {string} site
 * @returns {string}
 * @throws {ToolError}
 */
export function repoName(site) {
    if (typeof site !== 'string' || !REPO_NAME.test(site) || site.split('/')[1].startsWith('.')) {
        throw new ToolError(`"${site}" is not a GitHub repository name. Give the site as owner/name, e.g. octo/my-site — list_sites lists the ones you can edit.`)
    }
    return site
}

/**
 * Checks a commit message a model passed: not empty.
 *
 * @param {string} message
 * @returns {string}
 * @throws {ToolError}
 */
export function commitMessage(message) {
    if (typeof message !== 'string' || message.trim() === '') {
        throw new ToolError('The commit message is empty. Say in one line what the change does, e.g. "Add the about page".')
    }
    return message
}

/** `path` with each segment percent-encoded, for an API URL. */
function encodePath(path) {
    return path.split('/').map(encodeURIComponent).join('/')
}

/**
 * Creates a client for the repositories of one signed-in user.
 *
 * @param {object} options
 * @param {string} options.token the user's GitHub token (from `provider.githubToken`)
 * @param {typeof fetch} [options.fetch]
 * @param {string} [options.apiUrl] `https://api.github.com`, overridable for tests
 */
export function createRepoClient({ token, fetch = globalThis.fetch, apiUrl = 'https://api.github.com' }) {
    if (!token) throw new Error('The repository client needs the user\'s GitHub token.')

    /** Removes the token from a text that came from elsewhere (an error of `fetch`). */
    const redact = (text) => String(text).split(token).join('[token]')

    /**
     * Calls the REST API.
     *
     * @param {string} method
     * @param {string} pathname from the API root, already encoded
     * @param {object} [options]
     * @param {object} [options.body] sent as JSON
     * @param {number[]} [options.accept] statuses besides 2xx the caller handles itself
     * @param {boolean} [options.raw] leave the answer's body unread (a download)
     * @returns {Promise<{status: number, body: any, response: Response}>}
     */
    async function request(method, pathname, { body, accept = [], raw = false } = {}) {
        let response
        try {
            response = await fetch(new URL(pathname, apiUrl), {
                method,
                headers: {
                    Accept: 'application/vnd.github+json',
                    Authorization: `Bearer ${token}`,
                    'User-Agent': USER_AGENT,
                    'X-GitHub-Api-Version': API_VERSION,
                    ...(body ? { 'Content-Type': 'application/json' } : {}),
                },
                body: body ? JSON.stringify(body) : undefined,
            })
        } catch (error) {
            throw new GitHubError(`Cannot reach GitHub: ${redact(error.message)}`)
        }
        if (raw && response.ok) return { status: response.status, body: null, response }
        if (response.ok || accept.includes(response.status)) {
            const parsed = response.status === 204 ? null : await response.json().catch(() => null)
            return { status: response.status, body: parsed, response }
        }
        const failed = await response.json().catch(() => ({}))
        const reason = failed?.message ? redact(failed.message) : `HTTP ${response.status}`
        throw new GitHubError(`GitHub refused ${method} ${pathname.split('?')[0]}: ${reason}`, { status: response.status })
    }

    /** All pages of a paginated listing, `key` being the array in each answer. */
    async function paginate(pathname, key) {
        const items = []
        for (let page = 1; page <= MAX_PAGES; page += 1) {
            const { body } = await request('GET', `${pathname}?per_page=${PER_PAGE}&page=${page}`)
            const batch = body?.[key] ?? []
            items.push(...batch)
            if (batch.length < PER_PAGE || items.length >= (body?.total_count ?? Infinity)) break
        }
        return items
    }

    const repoUrl = (repo) => `/repos/${repoName(repo)}`

    /** The commit a branch points at, null when the branch does not exist. */
    async function branchHead(repo, branch) {
        const { status, body } = await request('GET', `${repoUrl(repo)}/git/ref/heads/${encodePath(branch)}`, { accept: [404] })
        return status === 404 ? null : body.object.sha
    }

    /** Points `branch` at `sha` without force; false when GitHub refuses (422: not a fast-forward). */
    async function moveBranch(repo, branch, sha) {
        const { status } = await request('PATCH', `${repoUrl(repo)}/git/refs/heads/${encodePath(branch)}`, { body: { sha, force: false }, accept: [422] })
        return status !== 422
    }

    /** Deletes the draft branch; nothing happens when it is already gone. */
    async function deleteDraft(repo) {
        await request('DELETE', `${repoUrl(repo)}/git/refs/heads/${encodePath(DRAFT_BRANCH)}`, { accept: [404, 422] })
    }

    /**
     * The mode a file written at `path` on `head` gets: an executable file
     * stays executable (`100755`), anything else — a new file, a regular one —
     * is a regular file (`100644`). A tree too large for one listing
     * (`truncated`, far beyond any site) yields `100644` for files it misses.
     */
    async function fileMode(repo, head, path) {
        const { body } = await request('GET', `${repoUrl(repo)}/git/trees/${head}?recursive=1`)
        const existing = body.tree.find((candidate) => candidate.path === path && candidate.type === 'blob')
        return existing?.mode === EXECUTABLE_MODE ? EXECUTABLE_MODE : FILE_MODE
    }

    /** A commit on `head` that changes the one file `file` to `blob` (null: deleted). */
    async function commitOn(repo, head, file, blob, message) {
        const entry = blob === null
            ? { path: file, mode: FILE_MODE, type: 'blob', sha: null }
            : { path: file, mode: await fileMode(repo, head, file), type: 'blob', sha: blob }
        const { body: parent } = await request('GET', `${repoUrl(repo)}/git/commits/${head}`)
        const { body: tree } = await request('POST', `${repoUrl(repo)}/git/trees`, {
            body: { base_tree: parent.tree.sha, tree: [entry] },
        })
        const { body: commit } = await request('POST', `${repoUrl(repo)}/git/commits`, {
            body: { message, tree: tree.sha, parents: [head] },
        })
        return commit.sha
    }

    return {
        /**
         * The repositories the GitHub App can reach with the user's token,
         * across all its installations, each once.
         *
         * @returns {Promise<Array<{site: string, owner: string, name: string, defaultBranch: string, private: boolean}>>}
         */
        async listRepos() {
            const installations = await paginate('/user/installations', 'installations')
            const repos = new Map()
            for (const installation of installations) {
                for (const repo of await paginate(`/user/installations/${encodeURIComponent(installation.id)}/repositories`, 'repositories')) {
                    repos.set(repo.full_name, {
                        site: repo.full_name,
                        owner: repo.owner?.login ?? repo.full_name.split('/')[0],
                        name: repo.name,
                        defaultBranch: repo.default_branch,
                        private: Boolean(repo.private),
                    })
                }
            }
            return [...repos.values()].sort((a, b) => a.site.localeCompare(b.site))
        },

        branchHead,

        /**
         * Reads one file at a ref.
         *
         * @param {string} repo `owner/name`
         * @param {string} path checked with `repoPath`
         * @param {string} ref a branch or commit
         * @param {object} [options]
         * @param {number} [options.maxBytes] a larger file comes with `content` null, without downloading it
         * @returns {Promise<{type: 'file', content: Buffer|null, size: number, sha: string} | {type: 'dir'} | {type: 'symlink'} | null>} null when nothing is at `path`
         */
        async readFile(repo, path, ref, { maxBytes = Infinity } = {}) {
            const { status, body } = await request('GET', `${repoUrl(repo)}/contents/${encodePath(repoPath(path))}?ref=${encodeURIComponent(ref)}`, { accept: [404] })
            if (status === 404) return null
            if (Array.isArray(body) || body.type === 'dir') return { type: 'dir' }
            // The contents API follows a symbolic link to a file and answers
            // with the target (another path), so a link is never read through.
            if (body.type === 'symlink' || (body.type === 'file' && body.path !== path)) return { type: 'symlink' }
            if (body.type !== 'file') return null
            if (body.size > maxBytes) return { type: 'file', content: null, size: body.size, sha: body.sha }
            let base64 = body.content
            // Files over 1 MB come without content; the blob API has it.
            if (body.encoding !== 'base64') {
                const { body: blob } = await request('GET', `${repoUrl(repo)}/git/blobs/${body.sha}`)
                base64 = blob.content
            }
            return { type: 'file', content: Buffer.from(base64 ?? '', 'base64'), size: body.size, sha: body.sha }
        },

        /**
         * Lists every file and folder at a ref.
         *
         * @param {string} repo `owner/name`
         * @param {string} ref a branch or commit
         * @returns {Promise<{entries: Array<{path: string, type: 'blob'|'tree', mode: string, size?: number}>, truncated: boolean}>}
         *     `mode` is git's: `120000` marks a symbolic link
         */
        async readTree(repo, ref) {
            const { body } = await request('GET', `${repoUrl(repo)}/git/trees/${encodeURIComponent(ref)}?recursive=1`)
            return {
                entries: body.tree
                    .filter((entry) => entry.type === 'blob' || entry.type === 'tree')
                    .map((entry) => ({ path: entry.path, type: entry.type, mode: entry.mode, ...(entry.size === undefined ? {} : { size: entry.size }) })),
                truncated: Boolean(body.truncated),
            }
        },

        /**
         * How many commits `head` has that `base` lacks.
         *
         * @param {string} repo `owner/name`
         * @param {string} base a branch or commit
         * @param {string} head a branch or commit
         * @returns {Promise<number>}
         */
        async aheadBy(repo, base, head) {
            const { body } = await request('GET', `${repoUrl(repo)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=1`)
            return body.ahead_by
        },

        /**
         * Makes sure the draft branch exists, creating it from `main`.
         *
         * @param {string} repo `owner/name`
         * @returns {Promise<{sha: string, created: boolean}>} the draft's head
         */
        async ensureDraft(repo) {
            const existing = await branchHead(repo, DRAFT_BRANCH)
            if (existing) return { sha: existing, created: false }
            const base = await branchHead(repo, BASE_BRANCH)
            if (!base) {
                throw new GitHubError(`The repository ${repo} has no ${BASE_BRANCH} branch to start the draft from.`, { status: 404 })
            }
            const { status } = await request('POST', `${repoUrl(repo)}/git/refs`, {
                body: { ref: `refs/heads/${DRAFT_BRANCH}`, sha: base },
                accept: [422],
            })
            // 422: another call created it in the meantime.
            if (status === 422) return { sha: await branchHead(repo, DRAFT_BRANCH), created: false }
            return { sha: base, created: true }
        },

        /**
         * Commits one file change to the draft branch, which must exist
         * (`ensureDraft`): blob → tree → commit → ref update. When the ref
         * update loses a race (the branch moved), the commit is made once more
         * on the new head; a second lost race is an error. A file that exists
         * keeps its mode (an executable stays executable), a new one is a
         * regular file.
         *
         * @param {string} repo `owner/name`
         * @param {object} change
         * @param {string} change.path checked with `repoPath`
         * @param {string|Buffer|null} change.content the new content; null deletes the file
         * @param {string} change.message the commit message
         * @returns {Promise<{sha: string}>} the new commit
         */
        async commitFile(repo, { path, content, message }) {
            const file = repoPath(path)
            commitMessage(message)
            let blob = null
            if (content !== null) {
                const { body } = await request('POST', `${repoUrl(repo)}/git/blobs`, {
                    body: { content: Buffer.from(content).toString('base64'), encoding: 'base64' },
                })
                blob = body.sha
            }
            for (let attempt = 0; attempt < 2; attempt += 1) {
                const head = await branchHead(repo, DRAFT_BRANCH)
                if (!head) {
                    throw new GitHubError(`The branch ${DRAFT_BRANCH} of ${repo} does not exist.`, { status: 404 })
                }
                const sha = await commitOn(repo, head, file, blob, message)
                if (await moveBranch(repo, DRAFT_BRANCH, sha)) return { sha }
            }
            throw new GitHubError(`The branch ${DRAFT_BRANCH} of ${repo} changed twice while committing ${file}. Try the change again.`, { code: 'conflict', status: 422 })
        },

        /**
         * Brings the draft into `main` — a fast-forward when `main` has not
         * moved, else a merge commit; either way one push to `main` — and
         * deletes the draft. `pushed` says whether this call moved `main`.
         * It is false when a racing publish put the draft live first: `main`'s
         * sha read before the merge is already the draft's, or the merge API
         * answers 204 (nothing to merge). A push that did not happen is never
         * reported as one.
         *
         * @param {string} repo `owner/name`
         * @param {string} message the merge commit's message, when one is needed
         * @returns {Promise<{sha: string, fastForward: boolean, pushed: boolean} | null>}
         *     `sha` is `main`'s head afterwards; null when there is no draft
         */
        async mergeDraft(repo, message) {
            const draft = await branchHead(repo, DRAFT_BRANCH)
            if (!draft) return null
            const before = await branchHead(repo, BASE_BRANCH)
            let result
            if (before === draft) {
                result = { sha: draft, fastForward: false, pushed: false }
            } else if (await moveBranch(repo, BASE_BRANCH, draft)) {
                result = { sha: draft, fastForward: true, pushed: true }
            } else {
                const { status, body } = await request('POST', `${repoUrl(repo)}/merges`, {
                    body: { base: BASE_BRANCH, head: DRAFT_BRANCH, commit_message: message },
                    accept: [409],
                })
                if (status === 409) {
                    throw new GitHubError(`The draft of ${repo} conflicts with changes made to ${BASE_BRANCH} in the meantime. Resolve it on GitHub (merge ${DRAFT_BRANCH} into ${BASE_BRANCH}).`, { code: 'merge_conflict', status })
                }
                // 204: main already contains every draft commit, so this call merged nothing.
                result = status === 204
                    ? { sha: await branchHead(repo, BASE_BRANCH), fastForward: false, pushed: false }
                    : { sha: body.sha, fastForward: false, pushed: true }
            }
            await deleteDraft(repo)
            return result
        },

        deleteDraft,

        /**
         * The newest run of a workflow on `main`, null when there is none or
         * the workflow does not exist.
         *
         * @param {string} repo `owner/name`
         * @param {string} workflow the workflow's file name, e.g. `deploy.yml`
         * @param {object} [options]
         * @param {string} [options.sha] only a run of a push of this commit
         * @returns {Promise<{id: number, status: string, conclusion: string|null, url: string, sha: string, event: string, createdAt: string} | null>}
         */
        async latestRun(repo, workflow, { sha } = {}) {
            const query = new URLSearchParams({ branch: BASE_BRANCH, per_page: '1' })
            if (sha) {
                query.set('head_sha', sha)
                query.set('event', 'push')
            }
            const { status, body } = await request('GET', `${repoUrl(repo)}/actions/workflows/${encodeURIComponent(workflow)}/runs?${query}`, { accept: [404] })
            const run = status === 404 ? null : body?.workflow_runs?.[0]
            // The filters narrow the list; the run is checked again so another commit is never reported as this one.
            if (!run || (sha && run.head_sha !== sha)) return null
            return {
                id: run.id,
                status: run.status,
                conclusion: run.conclusion ?? null,
                url: run.html_url,
                sha: run.head_sha,
                event: run.event,
                createdAt: run.created_at,
            }
        },

        /**
         * The address GitHub Pages serves the repository at, null when Pages
         * is not set up for it.
         *
         * @param {string} repo `owner/name`
         * @returns {Promise<string|null>}
         */
        async pagesUrl(repo) {
            const { status, body } = await request('GET', `${repoUrl(repo)}/pages`, { accept: [404] })
            return status === 404 ? null : (body?.html_url ?? null)
        },

        /**
         * Downloads the repository as a gzipped tarball, refusing one larger
         * than `maxBytes`.
         *
         * @param {string} repo `owner/name`
         * @param {string} ref a branch or commit
         * @param {object} [options]
         * @param {number} [options.maxBytes]
         * @returns {Promise<Buffer>}
         */
        async downloadTarball(repo, ref, { maxBytes = MAX_TARBALL_BYTES } = {}) {
            const { response } = await request('GET', `${repoUrl(repo)}/tarball/${encodeURIComponent(ref)}`, { raw: true })
            return readLimited(response, maxBytes, () => new GitHubError(`The repository ${repo} is larger than the ${maxBytes} bytes a checkout may have.`, { code: 'too_large' }))
        },
    }
}
