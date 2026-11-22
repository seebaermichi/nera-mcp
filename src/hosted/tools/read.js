// The read tools of the hosted mode (L7b, plan D2–D4): `list_sites`,
// `get_site`, `read_page` and `read_file` over the signed-in user's GitHub
// repositories. A site is a repository as `owner/name` that the GitHub App can
// reach with the user's token and whose package.json depends on
// `@nera-static/nera`; any other name is refused before a file is read. Reads
// come from the draft branch `nera-draft` while it exists (that is where the
// write tools commit), else from `main`. The page rules are the local mode's
// (src/pages.js), the folders are core's (`computeFolders`). The site lookup
// (`createSiteAccess`) and the error wrapper (`hostedTool`) are shared with
// the write tools (./write.js).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { computeFolders, defaultSettings } from '@nera-static/core'
import yaml from 'yaml'
import { z } from 'zod'
import { parsePage, refuseSecrets } from '../../pages.js'
import { fail, ok, tool, ToolError } from '../../results.js'
import { isNeraSite, neraRange, sitePlugins } from '../../tools/sites.js'
import { GitHubError } from '../github.js'
import { SignInRequiredError } from '../provider.js'
import { BASE_BRANCH, DRAFT_BRANCH, repoName, repoPath } from '../repo.js'

/** Larger files are refused by read_file: a model cannot use them whole. */
export const MAX_READ_BYTES = 1024 * 1024
/** What a user does when GitHub no longer accepts their sign-in. */
const RECONNECT = 'Sign in again: remove the Nera connector in your AI assistant and connect it once more.'
/** git's mode of a symbolic link: never listed, never read through. */
export const SYMLINK_MODE = '120000'

export const hostedSiteInput = z
    .string()
    .describe('The site: its GitHub repository as owner/name (e.g. `octo/my-site`), as list_sites returns it.')
export const pageInput = z
    .string()
    .describe('The page file, relative to the repository root, inside the site\'s pages folder and ending in .md — e.g. `pages/about.md` or `pages/blog/first-post.md`. The page is published at the same path with .html (`/about.html`).')
export const fileInput = z
    .string()
    .describe('The file, relative to the repository root — e.g. `config/app.yaml`, `theme/views/layouts/default.pug`, `assets/css/main.css`.')

/**
 * A folder from `config/app.yaml` (`./pages`, `public/`) as a repository path
 * (`pages`, `public`), refused when it leaves the repository.
 *
 * @param {string} folder
 * @param {string} key the `folders.<key>` it came from
 * @returns {string}
 * @throws {ToolError}
 */
export function repoFolder(folder, key) {
    const normalized = path.posix.normalize(String(folder)).replace(/\/+$/, '')
    return repoPath(normalized, `${key} folder (folders.${key} in config/app.yaml)`)
}

/**
 * The folders the build uses, as core's `computeFolders` computes them. It
 * probes the site folder for `theme/` and `views/`; the hosted server has no
 * checkout, so the probe runs against an empty temporary folder that holds
 * just those two names when the repository's tree has them.
 *
 * @param {object} appConfig the parsed `config/app.yaml`
 * @param {Array<{path: string, mode: string}>} entries the repository's tree
 * @returns {Record<string, string>}
 */
export function treeFolders(appConfig, entries) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nera-mcp-folders-'))
    try {
        for (const name of ['theme', 'views']) {
            if (entries.some((entry) => entry.path === name && entry.mode !== SYMLINK_MODE)) {
                fs.mkdirSync(path.join(dir, name))
            }
        }
        return computeFolders(appConfig, { cwd: dir })
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
}

/**
 * Parses `config/app.yaml` the way core's `resolveSiteModel` does.
 *
 * @param {{content: Buffer|null, size: number}|null} file null when the file is missing
 * @returns {{ appConfig: object, appConfigError: string|null }}
 */
function parseAppConfig(file) {
    if (file === null) return { appConfig: {}, appConfigError: null }
    if (file.content === null) {
        return { appConfig: {}, appConfigError: `config/app.yaml is ${file.size} bytes, more than the ${MAX_READ_BYTES} bytes these tools read.` }
    }
    try {
        const parsed = yaml.parse(file.content.toString('utf8')) || {}
        if (typeof parsed !== 'object' || Array.isArray(parsed)) {
            return { appConfig: {}, appConfigError: 'config/app.yaml is not a list of `key: value` lines.' }
        }
        return { appConfig: parsed, appConfigError: null }
    } catch (error) {
        return { appConfig: {}, appConfigError: error.message }
    }
}

/** Parses a package.json from the repository; null when it is missing or no JSON. */
function parsePackage(file) {
    if (file?.type !== 'file') return null
    try {
        return JSON.parse(file.content.toString('utf8'))
    } catch {
        return null
    }
}

/**
 * Wraps a hosted tool handler: besides a user mistake (`tool`), a sign-in that
 * is gone and a refusal by GitHub become `isError` results too, with their own
 * messages, which never hold a token.
 */
export function hostedTool(handler) {
    const wrapped = tool(handler)
    return async (args, extra) => {
        try {
            return await wrapped(args, extra)
        } catch (error) {
            if (error instanceof SignInRequiredError) return fail(error.message)
            if (error instanceof GitHubError) {
                // 401: GitHub no longer accepts the token (revoked, App uninstalled).
                return fail(error.status === 401 ? `${error.message} ${RECONNECT}` : error.message)
            }
            throw error
        }
    }
}

/**
 * Checks that `file` is a page: inside the site's pages folder, ending in `.md`.
 *
 * @param {string} file a repository path, already checked with `repoPath`
 * @param {Record<string, string>} folders the site's folders (`treeFolders`)
 * @throws {ToolError}
 */
export function requirePagePath(file, folders) {
    const pagesFolder = repoFolder(folders.pages, 'pages')
    if (!file.startsWith(`${pagesFolder}/`)) {
        throw new ToolError(`"${file}" is not inside the site's pages folder (${pagesFolder}/). Give a path like ${pagesFolder}/about.md; for other files use read_file / write_file.`)
    }
    if (path.posix.extname(file) !== '.md') {
        throw new ToolError(`"${file}" does not end in .md. Pages are Markdown files, e.g. ${pagesFolder}/about.md.`)
    }
}

/**
 * The site lookup every hosted tool goes through (plan D3), bound to the
 * signed-in user's repository client.
 *
 * @param {() => Promise<ReturnType<import('../repo.js').createRepoClient>>} repos
 */
export function createSiteAccess(repos) {
    /**
     * Resolves a `site` argument: a repository the user's installations reach,
     * whose package.json (on the branch reads come from) depends on
     * `@nera-static/nera`.
     *
     * @returns {Promise<{ client: object, site: string, branch: string, ref: string, draft: {exists: boolean, sha: string|null}, mainSha: string|null, pkg: object }>}
     */
    async function openSite(input) {
        const wanted = repoName(input).toLowerCase()
        const client = await repos()
        const repo = (await client.listRepos()).find((candidate) => candidate.site.toLowerCase() === wanted)
        if (!repo) {
            throw new ToolError(`The repository "${input}" is not one the Nera Static GitHub App can reach for you. Call list_sites for the sites you can edit; to add a repository, grant the Nera Static GitHub App access to it in your GitHub settings (Applications → Nera Static → Configure).`)
        }
        const site = repo.site
        const draftSha = await client.branchHead(site, DRAFT_BRANCH)
        const mainSha = await client.branchHead(site, BASE_BRANCH)
        const ref = draftSha ?? mainSha
        if (!ref) {
            throw new ToolError(`The repository "${site}" has no ${BASE_BRANCH} branch, so it holds no Nera site yet.`)
        }
        const branch = draftSha ? DRAFT_BRANCH : BASE_BRANCH
        const pkg = parsePackage(await client.readFile(site, 'package.json', ref))
        if (!isNeraSite(pkg)) {
            throw new ToolError(`"${site}" is not a Nera site: its package.json on ${branch} does not depend on @nera-static/nera. Call list_sites for the sites you can edit.`)
        }
        return { client, site, branch, ref, draft: { exists: Boolean(draftSha), sha: draftSha }, mainSha, pkg }
    }

    /**
     * Reads `file` at `ref` (default: the site's read ref), refusing a
     * symbolic link and a folder.
     */
    async function readAt(target, file, what, ref = target.ref) {
        const found = await target.client.readFile(target.site, file, ref, { maxBytes: MAX_READ_BYTES })
        if (found?.type === 'symlink') {
            throw new ToolError(`"${file}" is a symbolic link in ${target.site}; these tools do not follow links. Use the file it points to instead.`)
        }
        if (found?.type === 'dir') throw new ToolError(`"${file}" is a folder, not ${what}.`)
        return found
    }

    /** The site's folders and its tree at the read ref. */
    async function siteModel(target) {
        const { appConfig, appConfigError } = parseAppConfig(
            await readAt(target, `${repoFolder(defaultSettings.folders.config, 'config')}/app.yaml`, 'a file'),
        )
        const tree = await target.client.readTree(target.site, target.ref)
        const folders = treeFolders(appConfig, tree.entries)
        return { appConfig, appConfigError, folders, tree }
    }

    return { openSite, readAt, siteModel }
}

/**
 * Registers the hosted read tools.
 *
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @param {object} ctx
 * @param {() => Promise<ReturnType<import('../repo.js').createRepoClient>>} ctx.repos the signed-in user's repository client
 */
export function registerHostedReadTools(server, { repos }) {
    const { openSite, readAt, siteModel } = createSiteAccess(repos)

    server.registerTool('list_sites', {
        title: 'List Nera sites',
        description: 'Lists the Nera static sites you can edit: your GitHub repositories that the Nera Static GitHub App can reach and whose package.json depends on @nera-static/nera. A site\'s pages are Markdown files in pages/, rendered through Pug layouts into plain HTML. Call this first to find the `site` value (owner/name) every other tool takes. A repository missing here needs the GitHub App granted access to it.',
        inputSchema: {},
        annotations: { readOnlyHint: true },
    }, hostedTool(async () => {
        const client = await repos()
        const reachable = await client.listRepos()
        const checked = await Promise.all(reachable.map(async (repo) => {
            const pkg = parsePackage(await client.readFile(repo.site, 'package.json', BASE_BRANCH))
            return isNeraSite(pkg) ? { site: repo.site, name: pkg.name ?? null, nera: neraRange(pkg), private: repo.private } : null
        }))
        const sites = checked.filter(Boolean)
        const text = sites.length
            ? `Found ${sites.length} Nera site(s): ${sites.map((s) => s.site).join(', ')}. Call get_site for one of them.`
            : `None of the ${reachable.length} repositories the Nera Static GitHub App can reach is a Nera site. Grant the App access to your site's repository in your GitHub settings.`
        return ok({ sites }, text)
    }))

    server.registerTool('get_site', {
        title: 'Describe a Nera site',
        description: 'Describes one Nera site in a GitHub repository: its configuration from config/app.yaml, the folders the build uses, its theme, its plugins, the list of its pages (Markdown files) and its draft. Changes are committed to the draft branch nera-draft and go live only with publish; `draft.ahead` says how many unpublished commits it holds. Call it before editing a site so you know which pages exist; then use read_page / write_page for pages and read_file / write_file for configuration, layouts and styles.',
        inputSchema: { site: hostedSiteInput },
        annotations: { readOnlyHint: true },
    }, hostedTool(async ({ site }) => {
        const target = await openSite(site)
        const { appConfig, appConfigError, folders, tree } = await siteModel(target)
        const pagesFolder = repoFolder(folders.pages, 'pages')
        const pages = tree.entries
            .filter((entry) => entry.type === 'blob' && entry.mode !== SYMLINK_MODE)
            .map((entry) => entry.path)
            .filter((file) => file.startsWith(`${pagesFolder}/`) && file.endsWith('.md'))
            .sort()
        const ahead = target.draft.exists && target.mainSha
            ? await target.client.aheadBy(target.site, target.mainSha, target.draft.sha)
            : 0
        const plugins = sitePlugins(target.pkg)
        const structured = {
            site: target.site,
            branch: target.branch,
            name: target.pkg.name ?? null,
            nera: neraRange(target.pkg),
            app: appConfig,
            appConfigError,
            folders,
            theme: appConfig.theme ? { name: String(appConfig.theme) } : null,
            plugins,
            pages,
            draft: { exists: target.draft.exists, ahead },
        }
        if (tree.truncated) structured.pagesTruncated = true
        const draftText = target.draft.exists
            ? ` Its draft (${DRAFT_BRANCH}) holds ${ahead} unpublished commit(s); publish puts them live.`
            : ' It has no unpublished changes.'
        const text = `Site "${target.site}" has ${pages.length} page(s) and ${plugins.length} plugin(s).${draftText}`
            + (tree.truncated ? ' The repository is too large for GitHub to list in full, so the page list may be incomplete.' : '')
            + (appConfigError ? ` Problem: config/app.yaml is invalid YAML: ${appConfigError}` : '')
        return ok(structured, text)
    }))

    server.registerTool('read_page', {
        title: 'Read a page',
        description: 'Reads one page of a Nera site in a GitHub repository (from the draft branch nera-draft when it exists, else from main): its frontmatter (the YAML block at the top: `layout`, `title`, `description`, …) as JSON and its Markdown body. Call get_site first for the list of pages. To change the page, pass the frontmatter and body back to write_page.',
        inputSchema: { site: hostedSiteInput, path: pageInput },
        annotations: { readOnlyHint: true },
    }, hostedTool(async ({ site, path: page }) => {
        const file = repoPath(page, 'page path')
        refuseSecrets(file, file)
        const target = await openSite(site)
        const { folders } = await siteModel(target)
        requirePagePath(file, folders)
        const found = await readAt(target, file, 'a page')
        if (!found) {
            throw new ToolError(`The page "${file}" does not exist on ${target.branch} of ${target.site}. Call get_site for the list of pages, or write_page to create it.`)
        }
        if (found.content === null) {
            throw new ToolError(`The page "${file}" is ${found.size} bytes, more than the ${MAX_READ_BYTES} bytes read_page returns.`)
        }
        const { frontmatter, body, error } = parsePage(found.content.toString('utf8'))
        const structured = { site: target.site, branch: target.branch, path: file, frontmatter, body }
        if (error) structured.frontmatterError = error
        const text = error
            ? `Read ${file}, but its frontmatter is invalid YAML: ${error} Fix it with write_page, passing the whole frontmatter.`
            : `Read ${file} (layout: ${frontmatter.layout ?? 'none — the build skips this page'}).`
        return ok(structured, text)
    }))

    server.registerTool('read_file', {
        title: 'Read a site file',
        description: 'Reads a text file of a Nera site in a GitHub repository (from the draft branch nera-draft when it exists, else from main): configuration (`config/app.yaml`, `config/<plugin>.yaml`), Pug templates (`theme/views/…`), styles and scripts (`assets/…`), or any other text file in the site. For pages use read_page instead.',
        inputSchema: { site: hostedSiteInput, path: fileInput },
        annotations: { readOnlyHint: true },
    }, hostedTool(async ({ site, path: input }) => {
        const file = repoPath(input, 'file path')
        refuseSecrets(file, file)
        const target = await openSite(site)
        const found = await readAt(target, file, 'a file')
        if (!found) {
            throw new ToolError(`The file "${file}" does not exist on ${target.branch} of ${target.site}. Call get_site to see the site's folders.`)
        }
        if (found.content === null) {
            throw new ToolError(`"${file}" is ${found.size} bytes, more than the ${MAX_READ_BYTES} bytes read_file returns.`)
        }
        if (found.content.includes(0)) {
            throw new ToolError(`"${file}" is a binary file (an image, a font, …); read_file only returns text.`)
        }
        const content = found.content.toString('utf8')
        return ok({ site: target.site, branch: target.branch, path: file, content }, content)
    }))
}
