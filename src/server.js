import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import pkg from '../package.json' with { type: 'json' }
import { realRoot } from './paths.js'
import { registerFileTools } from './tools/files.js'
import { registerSiteTools } from './tools/sites.js'

/**
 * Builds the Nera MCP server for one root folder, with every tool registered
 * but no transport attached: the stdio bin connects a `StdioServerTransport`,
 * tests an in-memory one, the hosted mode (L7b) a Streamable HTTP one.
 *
 * @param {object} options
 * @param {string} options.root the folder the server may work in; every path a tool takes is checked against it
 * @param {Function} [options.runner] runs the `nera` and `npm` commands (injected so tests spawn nothing)
 * @param {typeof fetch} [options.fetch] fetches the npm registry catalogs (injected so tests stay offline)
 * @returns {Promise<McpServer>}
 * @throws {import('./paths.js').PathError} when `root` does not exist or is not a folder
 */
export async function createServer({ root, runner, fetch = globalThis.fetch }) {
    const ctx = { root: await realRoot(root), runner, fetch }
    const server = new McpServer(
        { name: pkg.name, version: pkg.version },
        {
            instructions: `Tools for Nera, a static site generator: a site is Markdown pages (pages/) rendered through Pug layouts into plain HTML. You work in ${ctx.root}. Start with list_sites; read get_site before editing a site.`,
        },
    )
    registerSiteTools(server, ctx)
    registerFileTools(server, ctx)
    return server
}
