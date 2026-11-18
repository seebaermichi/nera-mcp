import fs from 'node:fs/promises'
import path from 'node:path'
import { resolveSiteModel } from '@nera-static/core'
import { z } from 'zod'
import { isInside, resolveInRoot } from '../paths.js'
import { ok, tool, ToolError } from '../results.js'

const CLI_PACKAGE = '@nera-static/nera'
const PLUGIN_PREFIX = '@nera-static/plugin-'
const NOT_PLUGINS = new Set(['@nera-static/plugin-utils'])
/** How deep `list_sites` looks below the root (the root itself is depth 0). */
const MAX_SITE_DEPTH = 3
const SKIPPED_FOLDERS = new Set(['node_modules', 'public'])

export const siteInput = z
    .string()
    .describe('The site folder, relative to the root folder this server works in (`.` for the root itself), as list_sites returns it.')

/**
 * Reads a folder's `package.json`, or null when it has none or it is not JSON.
 *
 * @param {string} dir
 * @returns {Promise<object|null>}
 */
async function readPackage(dir) {
    try {
        return JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'))
    } catch {
        return null
    }
}

function allDependencies(pkg) {
    return { ...pkg?.devDependencies, ...pkg?.dependencies }
}

function isNeraSite(pkg) {
    return Boolean(allDependencies(pkg)[CLI_PACKAGE])
}

/**
 * The site-relative spelling of a path inside the root: forward slashes, `.`
 * for the root itself.
 */
export function relativeTo(base, target) {
    return path.relative(base, target).split(path.sep).join('/') || '.'
}

/**
 * Resolves a `site` argument to a Nera site inside the root: the folder must
 * stay inside the root and its `package.json` must depend on `@nera-static/nera`.
 *
 * @param {{ root: string }} ctx
 * @param {string} site path relative to the root
 * @returns {Promise<{ dir: string, site: string, pkg: object }>} its real path, its normalised name and its package.json
 * @throws {ToolError|import('../paths.js').PathError}
 */
export async function resolveSite(ctx, site) {
    const dir = await resolveInRoot(ctx.root, site, { label: 'site' })
    const pkg = await readPackage(dir)
    if (!isNeraSite(pkg)) {
        throw new ToolError(`"${site}" is not a Nera site: it has no package.json that depends on ${CLI_PACKAGE}. Call list_sites to see the sites under the root, or create_site to make one.`)
    }
    return { dir, site: relativeTo(ctx.root, dir), pkg }
}

/**
 * The site's model as the build sees it (`@nera-static/core`'s
 * `resolveSiteModel`), plus the real paths of its pages and output folders,
 * each checked to stay inside the site.
 *
 * @param {string} dir the site's real path
 */
export async function siteFolders(dir) {
    const model = resolveSiteModel({ cwd: dir })
    const pagesDir = await resolveInRoot(dir, model.folders.pages, { label: 'pages folder (folders.pages in config/app.yaml)' })
    const distDir = await resolveInRoot(dir, model.folders.dist, { label: 'output folder (folders.dist in config/app.yaml)' })
    return { model, pagesDir, distDir }
}

/**
 * Every `.md` file below `pagesDir`, site-relative and sorted. Symbolic links
 * are not followed, so the listing never leaves the site.
 */
async function listPages(dir, pagesDir) {
    let entries
    try {
        entries = await fs.readdir(pagesDir, { recursive: true, withFileTypes: true })
    } catch {
        return []
    }
    return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
        .map((entry) => path.join(entry.parentPath, entry.name))
        .filter((file) => isInside(pagesDir, file))
        .map((file) => relativeTo(dir, file))
        .sort()
}

/**
 * Finds the Nera sites at or below `root`, up to `MAX_SITE_DEPTH` levels,
 * without descending into a site, `node_modules`, `public` or hidden folders
 * or following symbolic links.
 */
async function findSites(root) {
    const found = []
    async function visit(dir, depth) {
        const pkg = await readPackage(dir)
        if (isNeraSite(pkg)) {
            found.push({
                site: relativeTo(root, dir),
                name: pkg.name ?? null,
                nera: allDependencies(pkg)[CLI_PACKAGE],
            })
            return
        }
        if (depth >= MAX_SITE_DEPTH) return
        let entries
        try {
            entries = await fs.readdir(dir, { withFileTypes: true })
        } catch {
            return
        }
        for (const entry of entries) {
            if (!entry.isDirectory() || entry.name.startsWith('.') || SKIPPED_FOLDERS.has(entry.name)) continue
            await visit(path.join(dir, entry.name), depth + 1)
        }
    }
    await visit(root, 0)
    return found.sort((a, b) => a.site.localeCompare(b.site))
}

/**
 * Registers `list_sites` and `get_site`.
 *
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @param {{ root: string }} ctx
 */
export function registerSiteTools(server, ctx) {
    server.registerTool('list_sites', {
        title: 'List Nera sites',
        description: 'Lists the Nera static sites in the folder this server works in. A Nera site is a folder whose package.json depends on @nera-static/nera; its pages are Markdown files in pages/, rendered through Pug layouts into plain HTML. Call this first to find the `site` value every other tool takes; if it returns no sites, call create_site.',
        inputSchema: {},
        annotations: { readOnlyHint: true },
    }, tool(async () => {
        const sites = await findSites(ctx.root)
        const text = sites.length
            ? `Found ${sites.length} Nera site(s): ${sites.map((s) => s.site).join(', ')}. Call get_site for one of them.`
            : 'No Nera site in this folder yet. Call create_site to make one.'
        return ok({ root: ctx.root, sites }, text)
    }))

    server.registerTool('get_site', {
        title: 'Describe a Nera site',
        description: 'Describes one Nera site: its configuration from config/app.yaml, the folders the build uses, its theme, its installed plugins and the list of its pages (Markdown files). Call it before editing a site so you know which pages exist; then use read_page / write_page for pages and read_file / write_file for configuration, layouts and styles.',
        inputSchema: { site: siteInput },
        annotations: { readOnlyHint: true },
    }, tool(async ({ site }) => {
        const resolved = await resolveSite(ctx, site)
        const { model, pagesDir } = await siteFolders(resolved.dir)
        const plugins = Object.keys(allDependencies(resolved.pkg))
            .filter((name) => name.startsWith(PLUGIN_PREFIX) && !NOT_PLUGINS.has(name))
            .sort()
        const pages = await listPages(resolved.dir, pagesDir)
        const structured = {
            site: resolved.site,
            name: resolved.pkg.name ?? null,
            nera: allDependencies(resolved.pkg)[CLI_PACKAGE],
            app: model.appConfig,
            appConfigError: model.appConfigError,
            folders: model.folders,
            theme: model.theme ? { name: model.theme.name, package: model.theme.package } : null,
            themeError: model.themeError,
            plugins,
            pages,
        }
        const problems = [model.appConfigError, model.themeError].filter(Boolean)
        const text = `Site "${resolved.site}" has ${pages.length} page(s) and ${plugins.length} plugin(s).`
            + (problems.length ? ` Problems: ${problems.join(' ')}` : '')
        return ok(structured, text)
    }))
}
