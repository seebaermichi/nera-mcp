import { CatalogError, listCatalog } from '@nera-static/nera'
import { z } from 'zod'
import { ok, tool, ToolError } from './results.js'

/**
 * The three catalogs, as the tools and resources present them. The registry
 * search itself is the CLI's `listCatalog` (ROADMAP principle 4).
 */
export const KINDS = {
    starters: {
        title: 'starter kits',
        next: 'Pass `name` as `starter` to create_site.',
    },
    themes: {
        title: 'themes',
        next: 'Pass `name` as `theme` to create_site.',
    },
    plugins: {
        title: 'plugins',
        next: 'Pass `name` of an official plugin to add_plugin.',
    },
}

/**
 * One catalog, from the CLI's `listCatalog`: official packages first, then
 * third-party ones. Starters fall back to the official starters bundled with
 * the CLI when the registry cannot be reached.
 *
 * The CLI's `CatalogError` extends `Error`, not our `ToolError`, so it is
 * rethrown as a `ToolError`: the tools turn that into an `isError` result, the
 * resources into an `InvalidParams` error, both with the CLI's message.
 *
 * @param {{ fetch: typeof fetch }} ctx
 * @param {keyof typeof KINDS} kindName
 * @returns {Promise<Array<{ name: string, package: string, version: string|null, description: string, official: boolean, npm: string }>>}
 * @throws {ToolError} when the registry cannot be reached or answers oddly (themes, plugins)
 */
export async function readCatalog(ctx, kindName) {
    try {
        return await listCatalog(kindName, { fetch: ctx.fetch })
    } catch (error) {
        if (error instanceof CatalogError) throw new ToolError(error.message)
        throw error
    }
}

/**
 * Registers `list_starters`, `list_themes` and `list_plugins`.
 *
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @param {{ fetch: typeof fetch }} ctx
 */
export function registerCatalogTools(server, ctx) {
    const descriptions = {
        starters: 'Lists the Nera starter kits on npm: ready-to-edit sites with sample pages, a theme and plugins (e.g. `blog`, `business`, `portfolio`, `blank`). Call it before create_site when the user wants a site of a certain kind, and pass the chosen entry\'s `name` as `starter`. Without a network connection it lists the official starters only.',
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
            const all = await readCatalog(ctx, kindName)
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
