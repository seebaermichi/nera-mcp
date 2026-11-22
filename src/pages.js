// The page and path rules both modes share (plan D4): how a page file splits
// into frontmatter and body, how new frontmatter is edited into an existing
// block, that a page names its `layout`, and which paths no tool reads or
// writes. Pure functions only — the local file tools (src/tools/files.js) and
// the hosted repo tools apply them to a file on disk and a file on GitHub alike.
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import yaml from 'yaml'
import { ToolError } from './results.js'

export const FENCE = '---'
/** Path segments no file tool reads or writes: git internals may hold credentials. */
export const FORBIDDEN_SEGMENTS = new Set(['.git'])
/** File names no file tool reads or writes: `.env` files and `.npmrc` (npm `_authToken`) hold tokens. */
export const SECRET_FILE = /^(\.env(\..*)?|\.npmrc)$/
/** Path segments write_file refuses: installed packages belong to npm. */
export const NO_WRITE_SEGMENTS = new Set(['node_modules'])

/**
 * Splits a page into its frontmatter YAML and its Markdown body, the way the
 * build reads it: a `---` first line opens the block, the next `---` line
 * closes it (no closing line: the rest is frontmatter).
 *
 * @param {string} raw the file's text
 * @returns {{ yamlText: string|null, body: string }} `yamlText` null when the page has no frontmatter
 */
export function splitPage(raw) {
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

/**
 * Parses frontmatter YAML into a document that keeps comments and quoting.
 *
 * @param {string|null} yamlText
 * @returns {{ doc: import('yaml').Document|null, error: string|null }}
 */
export function parseFrontmatter(yamlText) {
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
 * Reads a page's text the way read_page returns it: the frontmatter as JSON
 * (null when its YAML is invalid, with `error` saying why) and the body
 * without its leading blank lines.
 *
 * @param {string} raw the file's text
 * @returns {{ frontmatter: object|null, body: string, error: string|null }}
 */
export function parsePage(raw) {
    const { yamlText, body } = splitPage(raw)
    const { doc, error } = parseFrontmatter(yamlText)
    return { frontmatter: doc ? (doc.toJS() ?? {}) : null, body: body.replace(/^\n+/, ''), error }
}

/**
 * The frontmatter YAML for `frontmatter`, edited into the page's existing
 * frontmatter when it has one that parses: unchanged keys keep their comments,
 * quoting and order, a changed value keeps its quoting style, keys left out are
 * removed, new keys are appended. Nothing changed: the block stays byte for byte.
 *
 * @param {string|null} existingYaml the page's current frontmatter, null for none
 * @param {Record<string, unknown>} frontmatter
 * @returns {string}
 */
export function frontmatterText(existingYaml, frontmatter) {
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

/**
 * @param {string} text
 * @returns {string} `text`, ending in exactly the newline it had or one added
 */
export function withTrailingNewline(text) {
    return text.endsWith('\n') ? text : `${text}\n`
}

/**
 * Refuses frontmatter without `layout`: core never renders such a page.
 *
 * @param {Record<string, unknown>} frontmatter
 * @throws {ToolError}
 */
export function requireLayout(frontmatter) {
    if (typeof frontmatter.layout !== 'string' || frontmatter.layout.trim() === '') {
        throw new ToolError('The frontmatter has no `layout`. Nera only renders pages that name their layout — add e.g. `layout: pages/default.pug` (read an existing page with read_page to see which layout the site uses).')
    }
}

/**
 * The new text of a page written by write_page.
 *
 * @param {string|null} raw the page's current text, null for a new page
 * @param {Record<string, unknown>} frontmatter
 * @param {string} [body] the new Markdown body; undefined keeps the existing one
 * @returns {string}
 */
export function composePage(raw, frontmatter, body) {
    const existing = raw === null ? null : splitPage(raw)
    const head = `${FENCE}\n${frontmatterText(existing?.yamlText ?? null, frontmatter)}${FENCE}\n`
    return body === undefined
        ? head + (existing?.body ?? '')
        : `${head}\n${withTrailingNewline(body.replace(/^\n+/, ''))}`
}

/**
 * Refuses `input` when it, or the site-relative real path it resolved to (a
 * symbolic link may point into `.git/`), has a segment from `segments`.
 *
 * @param {string} input the path as the model gave it
 * @param {string} resolved the site-relative path it resolved to
 * @param {Set<string>} segments
 * @param {string} why completes "…, which <why>."
 * @throws {ToolError}
 */
export function refuseSegments(input, resolved, segments, why) {
    const hit = [input, resolved]
        .flatMap((candidate) => candidate.split(/[\\/]/))
        .find((segment) => segments.has(segment))
    if (hit) throw new ToolError(`"${input}" is inside ${hit}/, which ${why}.`)
}

/**
 * Refuses git internals and files that can hold secrets (`.env*`, `.npmrc`).
 *
 * @param {string} input the path as the model gave it
 * @param {string} resolved the site-relative path it resolved to
 * @throws {ToolError}
 */
export function refuseSecrets(input, resolved) {
    refuseSegments(input, resolved, FORBIDDEN_SEGMENTS, 'these tools never read or change')
    if ([input, resolved].some((candidate) => SECRET_FILE.test(path.basename(candidate)))) {
        throw new ToolError(`"${input}" can hold secrets (tokens, passwords); these tools never read or change it.`)
    }
}
