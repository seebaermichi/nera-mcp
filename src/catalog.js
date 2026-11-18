import { z } from 'zod'
import { ok, tool, ToolError } from './results.js'

export const REGISTRY_SEARCH = 'https://registry.npmjs.org/-/v1/search'
/** Every official package carries this keyword; not every one carries `nera-<kind>`. */
const OFFICIAL_KEYWORD = 'nera'
const OFFICIAL_SCOPE = '@nera-static/'
/** The most results one registry search returns. */
const SEARCH_SIZE = 250
const TIMEOUT_MS = 10000

/**
 * The three catalogs. `prefix` names the official packages of the kind,
 * `keyword` finds third-party ones, `usable` keeps only third-party names the
 * consuming tool reads back as the same package (a bare unscoped name would be
 * read as `@nera-static/<kind>-<name>`).
 */
export const KINDS = {
    starters: {
        title: 'starter kits',
        prefix: `${OFFICIAL_SCOPE}starter-`,
        keyword: 'nera-starter',
        exclude: new Set(),
        usable: (name) => name.startsWith('@') || /^nera-starter-[a-z0-9][a-z0-9._-]*$/.test(name),
        next: 'Pass `name` as `starter` to create_site.',
    },
    themes: {
        title: 'themes',
        prefix: `${OFFICIAL_SCOPE}theme-`,
        keyword: 'nera-theme',
        exclude: new Set(),
        usable: (name) => name.startsWith('@'),
        next: 'Pass `name` as `theme` to create_site.',
    },
    plugins: {
        title: 'plugins',
        prefix: `${OFFICIAL_SCOPE}plugin-`,
        keyword: 'nera-plugin',
        exclude: new Set([`${OFFICIAL_SCOPE}plugin-utils`]),
        usable: () => true,
        next: 'Pass `name` of an official plugin to add_plugin.',
    },
}

/**
 * A failure to reach or read the npm registry. The tools turn it into an
 * `isError` result, the resources into a resource error.
 */
export class CatalogError extends ToolError {
    constructor(message) {
        super(message)
        this.name = 'CatalogError'
    }
}

async function search(fetch, text) {
    const url = `${REGISTRY_SEARCH}?text=${encodeURIComponent(text)}&size=${SEARCH_SIZE}`
    let body
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        body = await response.json()
    } catch (error) {
        throw new CatalogError(`The npm registry could not be reached (${error.message}), so the catalog is not available. Check the network connection and try again, or use a name you already know (official ones are listed on https://nera.js.org).`)
    }
    if (!Array.isArray(body?.objects)) {
        throw new CatalogError('The npm registry answered with an unexpected search result, so the catalog is not available. Try again later.')
    }
    return body.objects.map((object) => object?.package).filter((pkg) => typeof pkg?.name === 'string')
}

function entry(kind, pkg, official) {
    return {
        name: official ? pkg.name.slice(kind.prefix.length) : pkg.name,
        package: pkg.name,
        version: typeof pkg.version === 'string' ? pkg.version : null,
        description: typeof pkg.description === 'string' ? pkg.description : '',
        official,
        npm: pkg.links?.npm ?? `https://www.npmjs.com/package/${pkg.name}`,
    }
}

/**
 * One catalog from the npm registry: the official `@nera-static/<kind>-*`
 * packages (keyword `nera`, which every official package carries, while only
 * some carry `nera-<kind>`), then third-party ones (keyword `nera-<kind>`),
 * each group sorted by package name and listed once.
 *
 * @param {typeof fetch} fetch
 * @param {keyof typeof KINDS} kindName
 * @returns {Promise<Array<{ name: string, package: string, version: string|null, description: string, official: boolean, npm: string }>>}
 * @throws {CatalogError} when the registry cannot be reached or answers oddly
 */
export async function loadCatalog(fetch, kindName) {
    const kind = KINDS[kindName]
    const [officialHits, keywordHits] = await Promise.all([
        search(fetch, `keywords:${OFFICIAL_KEYWORD}`),
        search(fetch, `keywords:${kind.keyword}`),
    ])
    const official = [...officialHits, ...keywordHits].filter((pkg) => pkg.name.startsWith(kind.prefix) && !kind.exclude.has(pkg.name))
    const thirdParty = keywordHits.filter((pkg) => !pkg.name.startsWith(OFFICIAL_SCOPE) && kind.usable(pkg.name))
    const byName = new Map()
    for (const [group, isOfficial] of [[official, true], [thirdParty, false]]) {
        const sorted = [...group].sort((a, b) => a.name.localeCompare(b.name))
        for (const pkg of sorted) {
            if (!byName.has(pkg.name)) byName.set(pkg.name, entry(kind, pkg, isOfficial))
        }
    }
    return [...byName.values()]
}

/**
 * Registers `list_starters`, `list_themes` and `list_plugins`.
 *
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @param {{ fetch: typeof fetch }} ctx
 */
export function registerCatalogTools(server, ctx) {
    const descriptions = {
        starters: 'Lists the Nera starter kits on npm: ready-to-edit sites with sample pages, a theme and plugins (e.g. `blog`, `business`, `portfolio`, `blank`). Call it before create_site when the user wants a site of a certain kind, and pass the chosen entry\'s `name` as `starter`.',
        themes: 'Lists the Nera themes on npm: the layouts and styles of a site, installable as a package. A starter already brings its theme; use this only for create_site without a starter, and pass the chosen entry\'s `name` as `theme`.',
        plugins: 'Lists the Nera plugins on npm: features such as navigation, tags, a sitemap, a feed, image resizing, code highlighting or a contact form. Call it when the user wants a feature the site lacks; official plugins (`official: true`) are installed with add_plugin by their `name`.',
    }
    for (const kindName of Object.keys(KINDS)) {
        const kind = KINDS[kindName]
        server.registerTool(`list_${kindName}`, {
            title: `List Nera ${kind.title}`,
            description: descriptions[kindName],
            inputSchema: {
                query: z.string().optional().describe('Only entries whose name or description contains this text (case-insensitive), e.g. `blog`.'),
            },
            annotations: { readOnlyHint: true, openWorldHint: true },
        }, tool(async ({ query }) => {
            const all = await loadCatalog(ctx.fetch, kindName)
            const needle = query?.toLowerCase()
            const items = needle
                ? all.filter((item) => `${item.package} ${item.description}`.toLowerCase().includes(needle))
                : all
            const text = items.length
                ? `Found ${items.length} ${kind.title}: ${items.map((item) => item.name).join(', ')}. ${kind.next}`
                : `No ${kind.title} found${query ? ` for "${query}"` : ''}.`
            return ok({ [kindName]: items }, text)
        }))
    }
}
