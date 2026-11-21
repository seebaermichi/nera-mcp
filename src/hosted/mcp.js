// The MCP server of the hosted mode (L7b, plan D5). It has no folder to work
// in, so it registers only the transport-agnostic tools that need none: the
// catalogs of starters, themes and plugins. The site tools, which work on the
// user's GitHub repository, come with a later issue. The app
// (src/hosted/app.js) builds one per `/mcp` request.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import pkg from '../../package.json' with { type: 'json' }
import { registerCatalogTools } from '../catalog.js'

/**
 * Builds the hosted MCP server, with no transport attached.
 *
 * @param {object} [options]
 * @param {typeof fetch} [options.fetch] fetches the npm registry catalogs (injected so tests stay offline)
 * @returns {McpServer}
 */
export function createHostedServer({ fetch = globalThis.fetch } = {}) {
    const server = new McpServer(
        { name: pkg.name, version: pkg.version },
        {
            instructions: 'Tools for Nera, a static site generator: a site is Markdown pages rendered through Pug layouts into plain HTML. This hosted server lists the Nera starter kits, themes and plugins for now; the full documentation is at https://nera.js.org/llms-full.txt.',
        },
    )
    registerCatalogTools(server, { fetch })
    return server
}
