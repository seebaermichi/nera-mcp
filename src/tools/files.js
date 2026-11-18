import fs from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import yaml from 'yaml'
import { z } from 'zod'
import { isInside, resolveInRoot } from '../paths.js'
import { ok, tool, ToolError } from '../results.js'
import { relativeTo, resolveSite, siteFolders, siteInput } from './sites.js'

/** Larger files are refused by read_file: a model cannot use them whole. */
const MAX_READ_BYTES = 1024 * 1024
const FENCE = '---'
/** Path segments no file tool reads or writes: git internals may hold credentials. */
const FORBIDDEN_SEGMENTS = new Set(['.git'])
/** File names no file tool reads or writes: `.env` files and `.npmrc` (npm `_authToken`) hold tokens. */
const SECRET_FILE = /^(\.env(\..*)?|\.npmrc)$/
/** Path segments write_file refuses: installed packages belong to npm. */
const NO_WRITE_SEGMENTS = new Set(['node_modules'])

const pageInput = z
    .string()
    .describe('The page file, relative to the site folder, inside its pages folder and ending in .md — e.g. `pages/about.md` or `pages/blog/first-post.md`. The page is published at the same path with .html (`/about.html`).')
const fileInput = z
    .string()
    .describe('The file, relative to the site folder — e.g. `config/app.yaml`, `theme/views/layouts/default.pug`, `assets/css/main.css`.')

/**
 * Splits a page into its frontmatter YAML and its Markdown body, the way the
 * build reads it: a `---` first line opens the block, the next `---` line
 * closes it (no closing line: the rest is frontmatter).
 *
 * @param {string} raw the file's text
 * @returns {{ yamlText: string|null, body: string }} `yamlText` null when the page has no frontmatter
 */
function splitPage(raw) {
    // markdown-it, which the build parses pages with, reads CRLF as LF.
    const lines = raw.replace(/\r\n/g, '\n').split('\n')
    if (lines[0] !== FENCE) return { yamlText: null, body: raw }
    const close = lines.indexOf(FENCE, 1)
    if (close === -1) return { yamlText: lines.slice(1).join('\n'), body: '' }
    return {
        yamlText: lines.slice(1, close).join('\n'),
        body: lines.slice(close + 1).join('\n'),
    }
}

/** Parses frontmatter YAML into a document that keeps comments and quoting. */
function parseFrontmatter(yamlText) {
    const doc = yaml.parseDocument(yamlText ?? '', { merge: true, uniqueKeys: false })
    if (doc.errors.length) {
        return { doc: null, error: doc.errors[0].message }
    }
    if (doc.contents !== null && !yaml.isMap(doc.contents)) {
        return { doc: null, error: 'The frontmatter is not a list of `key: value` lines.' }
    }
    return { doc, error: null }
}

/**
 * The frontmatter YAML for `frontmatter`, edited into the page's existing
 * frontmatter when it has one that parses: unchanged keys keep their comments,
 * quoting and order, a changed value keeps its quoting style, keys left out are
 * removed, new keys are appended. Nothing changed: the block stays byte for byte.
 */
function frontmatterText(existingYaml, frontmatter) {
    const { doc } = existingYaml === null ? { doc: null } : parseFrontmatter(existingYaml)
    if (!doc || doc.contents === null) {
        return new yaml.Document(frontmatter).toString({ flowCollectionPadding: false })
    }
    const current = doc.toJS() ?? {}
    let changed = false
    for (const key of Object.keys(current)) {
        if (!Object.hasOwn(frontmatter, key)) {
            doc.delete(key)
            changed = true
        }
    }
    for (const [key, value] of Object.entries(frontmatter)) {
        if (!isDeepStrictEqual(current[key], value)) {
            doc.set(key, value)
            changed = true
        }
    }
    if (!changed) return withTrailingNewline(existingYaml)
    return doc.toString({ flowCollectionPadding: false })
}

function withTrailingNewline(text) {
    return text.endsWith('\n') ? text : `${text}\n`
}

async function statOrNull(file) {
    try {
        return await fs.stat(file)
    } catch (error) {
        if (error.code === 'ENOENT') return null
        throw error
    }
}

async function readText(file, shown) {
    try {
        return await fs.readFile(file, 'utf8')
    } catch (error) {
        if (error.code === 'ENOENT') return null
        if (error.code === 'EISDIR') throw new ToolError(`"${shown}" is a folder, not a page.`)
        throw error
    }
}

/**
 * Refuses `input` when it, or the site-relative real path it resolved to (a
 * symbolic link may point into `.git/`), has a segment from `segments`.
 */
function refuseSegments(input, resolved, segments, why) {
    const hit = [input, resolved]
        .flatMap((candidate) => candidate.split(/[\\/]/))
        .find((segment) => segments.has(segment))
    if (hit) throw new ToolError(`"${input}" is inside ${hit}/, which ${why}.`)
}

function refuseSecrets(input, resolved) {
    refuseSegments(input, resolved, FORBIDDEN_SEGMENTS, 'these tools never read or change')
    if ([input, resolved].some((candidate) => SECRET_FILE.test(path.basename(candidate)))) {
        throw new ToolError(`"${input}" can hold secrets (tokens, passwords); these tools never read or change it.`)
    }
}

/**
 * Resolves a page argument: inside the site, inside its pages folder, a `.md`
 * file.
 */
async function resolvePage(ctx, site, page) {
    const resolved = await resolveSite(ctx, site)
    const { pagesDir } = await siteFolders(resolved.dir)
    const file = await resolveInRoot(resolved.dir, page, { label: 'page path' })
    const pagesFolder = relativeTo(resolved.dir, pagesDir)
    if (file === pagesDir || !isInside(pagesDir, file)) {
        throw new ToolError(`"${page}" is not inside the site's pages folder (${pagesFolder}/). Give a path like ${pagesFolder}/about.md; for other files use read_file / write_file.`)
    }
    if (path.extname(file) !== '.md') {
        throw new ToolError(`"${page}" does not end in .md. Pages are Markdown files, e.g. ${pagesFolder}/about.md.`)
    }
    return { ...resolved, file, path: relativeTo(resolved.dir, file) }
}

/**
 * Resolves a file argument inside the site, refusing git internals and `.env`
 * files — by the name given and by the real path a symbolic link leads to.
 */
async function resolveFile(ctx, site, input) {
    const resolved = await resolveSite(ctx, site)
    const file = await resolveInRoot(resolved.dir, input, { label: 'file path' })
    if (file === resolved.dir) {
        throw new ToolError('Give a file inside the site, not the site folder itself.')
    }
    const relative = relativeTo(resolved.dir, file)
    refuseSecrets(input, relative)
    return { ...resolved, file, path: relative }
}

/**
 * Registers the page tools (`read_page`, `write_page`, `delete_page`) and the
 * file tools (`read_file`, `write_file`).
 *
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @param {{ root: string }} ctx
 */
export function registerFileTools(server, ctx) {
    server.registerTool('read_page', {
        title: 'Read a page',
        description: 'Reads one page of a Nera site: its frontmatter (the YAML block at the top: `layout`, `title`, `description`, …) as JSON and its Markdown body. Call get_site first for the list of pages. To change the page, pass the frontmatter and body back to write_page.',
        inputSchema: { site: siteInput, path: pageInput },
        annotations: { readOnlyHint: true },
    }, tool(async ({ site, path: page }) => {
        const target = await resolvePage(ctx, site, page)
        const raw = await readText(target.file, target.path)
        if (raw === null) {
            throw new ToolError(`The page "${target.path}" does not exist. Call get_site for the list of pages, or write_page to create it.`)
        }
        const { yamlText, body } = splitPage(raw)
        const { doc, error } = parseFrontmatter(yamlText)
        const frontmatter = doc ? (doc.toJS() ?? {}) : null
        const structured = { site: target.site, path: target.path, frontmatter, body: body.replace(/^\n+/, '') }
        if (error) structured.frontmatterError = error
        const text = error
            ? `Read ${target.path}, but its frontmatter is invalid YAML: ${error} Fix it with write_page, passing the whole frontmatter.`
            : `Read ${target.path} (layout: ${frontmatter.layout ?? 'none — the build skips this page'}).`
        return ok(structured, text)
    }))

    server.registerTool('write_page', {
        title: 'Create or update a page',
        description: 'Creates a page of a Nera site, or replaces an existing one. `frontmatter` becomes the YAML block at the top of the file and must contain `layout` (the Pug layout under the theme\'s views folder that renders the page, e.g. `pages/default.pug` — read an existing page to see which layouts the site uses); `title` and `description` are usual too. Keys you leave out are removed; comments and quoting of unchanged keys are kept. `body` is the Markdown content; leave it out to keep the existing body. Afterwards call validate, then build or preview.',
        inputSchema: {
            site: siteInput,
            path: pageInput,
            frontmatter: z.record(z.string(), z.unknown()).describe('The page\'s frontmatter as a JSON object; must contain `layout`.'),
            body: z.string().optional().describe('The page\'s Markdown content, without the frontmatter. Leave out to keep the existing body.'),
        },
    }, tool(async ({ site, path: page, frontmatter, body }) => {
        if (typeof frontmatter.layout !== 'string' || frontmatter.layout.trim() === '') {
            throw new ToolError('The frontmatter has no `layout`. Nera only renders pages that name their layout — add e.g. `layout: pages/default.pug` (read an existing page with read_page to see which layout the site uses).')
        }
        const target = await resolvePage(ctx, site, page)
        const raw = await readText(target.file, target.path)
        const existing = raw === null ? null : splitPage(raw)
        const head = `${FENCE}\n${frontmatterText(existing?.yamlText ?? null, frontmatter)}${FENCE}\n`
        const content = body === undefined
            ? head + (existing?.body ?? '')
            : `${head}\n${withTrailingNewline(body.replace(/^\n+/, ''))}`
        await fs.mkdir(path.dirname(target.file), { recursive: true })
        await fs.writeFile(target.file, content)
        const created = raw === null
        return ok(
            { site: target.site, path: target.path, created },
            `${created ? 'Created' : 'Updated'} ${target.path}. Call validate to check it, then build or preview.`,
        )
    }))

    server.registerTool('delete_page', {
        title: 'Delete a page',
        description: 'Deletes one page (a Markdown file in the pages folder) of a Nera site. Links to it from other pages or the navigation are not changed — check them with validate afterwards.',
        inputSchema: { site: siteInput, path: pageInput },
        annotations: { destructiveHint: true },
    }, tool(async ({ site, path: page }) => {
        const target = await resolvePage(ctx, site, page)
        try {
            await fs.unlink(target.file)
        } catch (error) {
            if (error.code === 'ENOENT') {
                throw new ToolError(`The page "${target.path}" does not exist. Call get_site for the list of pages.`)
            }
            throw error
        }
        return ok({ site: target.site, path: target.path, deleted: true }, `Deleted ${target.path}.`)
    }))

    server.registerTool('read_file', {
        title: 'Read a site file',
        description: 'Reads a text file of a Nera site: configuration (`config/app.yaml`, `config/<plugin>.yaml`), Pug templates (`theme/views/…`), styles and scripts (`assets/…`), or any other text file in the site. For pages use read_page instead.',
        inputSchema: { site: siteInput, path: fileInput },
        annotations: { readOnlyHint: true },
    }, tool(async ({ site, path: input }) => {
        const target = await resolveFile(ctx, site, input)
        const stat = await statOrNull(target.file)
        if (stat === null) {
            throw new ToolError(`The file "${target.path}" does not exist in site "${target.site}". Call get_site to see the site's folders.`)
        }
        if (stat.isDirectory()) {
            throw new ToolError(`"${target.path}" is a folder, not a file.`)
        }
        if (stat.size > MAX_READ_BYTES) {
            throw new ToolError(`"${target.path}" is ${stat.size} bytes, more than the ${MAX_READ_BYTES} bytes read_file returns.`)
        }
        const buffer = await fs.readFile(target.file)
        if (buffer.includes(0)) {
            throw new ToolError(`"${target.path}" is a binary file (an image, a font, …); read_file only returns text.`)
        }
        const content = buffer.toString('utf8')
        return ok({ site: target.site, path: target.path, content }, content)
    }))

    server.registerTool('write_file', {
        title: 'Create or update a site file',
        description: 'Creates or replaces a text file of a Nera site: configuration (`config/app.yaml`, `config/<plugin>.yaml`), Pug templates (`theme/views/…`), styles and scripts (`assets/…`). Missing folders are created. Pages (Markdown in the pages folder) go through write_page instead; the output folder (`public/`) is rebuilt on every build, so nothing is written there. Afterwards call validate.',
        inputSchema: {
            site: siteInput,
            path: fileInput,
            content: z.string().describe('The complete new text of the file.'),
        },
    }, tool(async ({ site, path: input, content }) => {
        const target = await resolveFile(ctx, site, input)
        refuseSegments(input, target.path, NO_WRITE_SEGMENTS, 'npm manages; add plugins with add_plugin')
        const { pagesDir, distDir } = await siteFolders(target.dir)
        if (isInside(distDir, target.file)) {
            throw new ToolError(`"${target.path}" is in the output folder (${relativeTo(target.dir, distDir)}/), which every build deletes and recreates. Change the page, template or asset it is built from instead.`)
        }
        if (isInside(pagesDir, target.file) && path.extname(target.file) === '.md') {
            throw new ToolError(`"${target.path}" is a page. Use write_page, which checks the frontmatter.`)
        }
        const stat = await statOrNull(target.file)
        if (stat?.isDirectory()) {
            throw new ToolError(`"${target.path}" is a folder, not a file.`)
        }
        const created = stat === null
        await fs.mkdir(path.dirname(target.file), { recursive: true })
        await fs.writeFile(target.file, content)
        return ok(
            { site: target.site, path: target.path, created },
            `${created ? 'Created' : 'Updated'} ${target.path} in site "${target.site}". Call validate to check the site.`,
        )
    }))
}
