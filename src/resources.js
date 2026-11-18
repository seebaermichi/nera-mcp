import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import { KINDS, readCatalog } from './catalog.js'
import { PathError, resolveInRoot } from './paths.js'
import { ToolError } from './results.js'
import { findSites, resolveSite } from './tools/sites.js'

export const DOCS_URL = 'https://nera.js.org/llms-full.txt'
/** Where `scripts/fetch-docs.js` puts the docs at release (`prepack`). */
export const BUNDLED_DOCS = fileURLToPath(new URL('../docs/llms-full.txt', import.meta.url))
const AGENTS_FILE = 'AGENTS.md'

/**
 * Reads a resource, turning a user mistake (a path outside the root, a folder
 * that is no site, an unreachable registry) into an `InvalidParams` resource
 * error with our message. Resources have no `isError` result, so this is the
 * protocol's way to say what is wrong.
 */
function resource(read) {
    return async (...args) => {
        try {
            return await read(...args)
        } catch (error) {
            if (error instanceof ToolError || error instanceof PathError) {
                throw new McpError(ErrorCode.InvalidParams, error.message)
            }
            throw error
        }
    }
}

function text(uri, mimeType, body) {
    return { contents: [{ uri: uri.href, mimeType, text: body }] }
}

/**
 * The `AGENTS.md` URI of a site (`.` is the root itself, whose URI has no site
 * segment: a URL parser removes a `.` segment anyway).
 */
export function agentsUri(site) {
    return site === '.' ? `nera://site/${AGENTS_FILE}` : `nera://site/${site.split('/').map(encodeURIComponent).join('/')}/${AGENTS_FILE}`
}

/** The `{site}` variable of a resource URI, percent-decoded. */
function decodeSite(site) {
    try {
        return decodeURIComponent(String(site))
    } catch {
        throw new PathError(`The site "${site}" in the resource URI is not validly percent-encoded. Use the URI list_sites or the resource list gives.`)
    }
}

/**
 * Registers the docs, the three catalogs and each site's `AGENTS.md`.
 *
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @param {{ root: string, fetch: typeof fetch, docsFile?: string }} ctx
 */
export function registerResources(server, ctx) {
    const docsFile = ctx.docsFile ?? BUNDLED_DOCS

    server.registerResource('nera_docs', 'nera://docs/llms-full.txt', {
        title: 'Nera documentation',
        description: 'The complete Nera documentation and tutorials in one Markdown file (pages, layouts, configuration, plugins, themes, publishing), as published on nera.js.org for this release. Read it when a task needs more than the tool descriptions say.',
        mimeType: 'text/markdown',
    }, resource(async (uri) => {
        try {
            return text(uri, 'text/markdown', await fs.readFile(docsFile, 'utf8'))
        } catch (error) {
            if (error.code !== 'ENOENT') throw error
            return text(uri, 'text/markdown', `The Nera documentation is not bundled with this copy of the server (it is added when the package is released). Read it online: ${DOCS_URL}`)
        }
    }))

    for (const kindName of Object.keys(KINDS)) {
        server.registerResource(`nera_${kindName}`, `nera://catalog/${kindName}`, {
            title: `Nera ${KINDS[kindName].title}`,
            description: `The Nera ${KINDS[kindName].title} on npm as JSON, official ones first (the same list as the list_${kindName} tool).`,
            mimeType: 'application/json',
        }, resource(async (uri) => {
            const items = await readCatalog(ctx, kindName)
            return text(uri, 'application/json', JSON.stringify({ [kindName]: items }, null, 2))
        }))
    }

    const readAgents = resource(async (uri, { site = '.' } = {}) => {
        const resolved = await resolveSite(ctx, decodeSite(site))
        const file = await resolveInRoot(resolved.dir, AGENTS_FILE, { label: 'AGENTS.md' })
        try {
            return text(uri, 'text/markdown', await fs.readFile(file, 'utf8'))
        } catch (error) {
            if (error.code !== 'ENOENT') throw error
            throw new ToolError(`The site "${resolved.site}" has no ${AGENTS_FILE} (sites created before @nera-static/nera 1.6.0 lack it; running \`nera update\` in the site writes one). Call get_site instead.`)
        }
    })
    const listAgents = async () => {
        const sites = await findSites(ctx.root)
        return {
            resources: sites.map(({ site }) => ({
                uri: agentsUri(site),
                name: `${site} ${AGENTS_FILE}`,
                mimeType: 'text/markdown',
            })),
        }
    }
    const agentsMetadata = {
        title: 'A site\'s AGENTS.md',
        description: 'The AGENTS.md of a Nera site: how that site is built, which commands it runs and what to keep in mind when editing it. Read it before changing a site. `{site}` is the folder list_sites returns.',
        mimeType: 'text/markdown',
    }
    // A site below the root; the root itself has no site segment (see agentsUri).
    server.registerResource('site_agents', new ResourceTemplate(`nera://site/{+site}/${AGENTS_FILE}`, { list: listAgents }), agentsMetadata, readAgents)
    server.registerResource('root_site_agents', new ResourceTemplate(`nera://site/${AGENTS_FILE}`, { list: undefined }), {
        ...agentsMetadata,
        description: 'The AGENTS.md of the Nera site in the root folder itself, when the root is a site.',
    }, readAgents)
}
