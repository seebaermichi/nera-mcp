import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import pkg from '../package.json' with { type: 'json' }
import { registerCatalogTools } from './catalog.js'
import { realRoot } from './paths.js'
import { createProcesses } from './processes.js'
import { registerPrompts } from './prompts.js'
import { registerResources } from './resources.js'
import { createRunner } from './runner.js'
import { registerCliTools } from './tools/cli.js'
import { registerFileTools } from './tools/files.js'
import { registerLongRunningTools } from './tools/long-running.js'
import { registerSiteTools } from './tools/sites.js'

/**
 * Builds the Nera MCP server for one root folder, with every tool registered
 * but no transport attached: the stdio bin connects a `StdioServerTransport`,
 * tests an in-memory one, the hosted mode (L7b) a Streamable HTTP one.
 *
 * @param {object} options
 * @param {string} options.root the folder the server may work in; every path a tool takes is checked against it
 * @param {ReturnType<typeof createRunner>} [options.runner] runs the `nera`, `npm` and `node` commands (injected so tests spawn nothing)
 * @param {typeof fetch} [options.fetch] fetches the npm registry catalogs (injected so tests stay offline)
 * @param {string} [options.docsFile] the bundled `llms-full.txt` (default: the package's `docs/`; injected so tests can point at a missing one)
 * @param {ReturnType<typeof createProcesses>} [options.processes] tracks the children that outlive a call (`preview`, `publish`); all are stopped when the server closes
 * @param {{ previewStartMs?: number, publishWaitMs?: number }} [options.timing] how long `preview` and `publish` wait (shortened in tests)
 * @returns {Promise<McpServer>}
 * @throws {import('./paths.js').PathError} when `root` does not exist or is not a folder
 */
export async function createServer({ root, runner = createRunner(), fetch = globalThis.fetch, docsFile, processes = createProcesses(), timing }) {
    const ctx = { root: await realRoot(root), runner, fetch, docsFile, processes, timing }
    const server = new McpServer(
        { name: pkg.name, version: pkg.version },
        {
            instructions: `Tools for Nera, a static site generator: a site is Markdown pages (pages/) rendered through Pug layouts into plain HTML. You work in ${ctx.root}. Start with list_sites; read get_site before editing a site. The prompts walk through whole tasks, the nera://docs/llms-full.txt resource holds the full documentation.`,
        },
    )
    registerSiteTools(server, ctx)
    registerFileTools(server, ctx)
    registerCliTools(server, ctx)
    registerLongRunningTools(server, ctx)
    registerCatalogTools(server, ctx)
    registerResources(server, ctx)
    registerPrompts(server)
    // Closing (server.close(), or the client hanging up) aborts every running
    // call, which stops the short commands through their signal; the
    // long-running children are stopped here.
    server.server.onclose = () => {
        processes.stopAll().catch((error) => console.error(`Stopping the preview and publish processes failed: ${error.message}`))
    }
    return server
}
