// The MCP server of the hosted mode (L7b, plan D3/D5). It has no folder to
// work in: the catalogs of starters, themes and plugins need none, and the
// site tools work on the signed-in user's GitHub repositories through the
// repository client (src/hosted/repo.js). The app (src/hosted/app.js) builds
// one per `/mcp` request, bound to the user its bearer token belongs to.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import pkg from '../../package.json' with { type: 'json' }
import { registerCatalogTools } from '../catalog.js'
import { createRepoClient } from './repo.js'
import { registerHostedReadTools } from './tools/read.js'
import { registerHostedWriteTools } from './tools/write.js'

/**
 * Builds the hosted MCP server, with no transport attached. Without a user
 * (`userId` and `githubToken`) it offers the catalog tools only.
 *
 * @param {object} [options]
 * @param {typeof fetch} [options.fetch] fetches the npm registry catalogs (injected so tests stay offline)
 * @param {string} [options.userId] the signed-in user, from the bearer token's `extra`
 * @param {(userId: string) => Promise<string>} [options.githubToken] the user's GitHub token (`provider.githubToken`); throws `SignInRequiredError` when the sign-in is gone
 * @param {(token: string) => ReturnType<typeof createRepoClient>} [options.createRepo] builds the repository client (injected so tests talk to a fake GitHub)
 * @returns {McpServer}
 */
export function createHostedServer({
    fetch = globalThis.fetch,
    userId,
    githubToken,
    createRepo = (token) => createRepoClient({ token }),
} = {}) {
    const server = new McpServer(
        { name: pkg.name, version: pkg.version },
        {
            instructions: 'Tools for Nera, a static site generator: a site is Markdown pages rendered through Pug layouts into plain HTML. This hosted server works on your Nera sites in GitHub repositories: list_sites finds them, get_site describes one, read_page and read_file read its files, write_page, write_file and delete_page change them as one commit each on the draft branch nera-draft, which goes live only with publish. It also lists the Nera starter kits, themes and plugins. The full documentation is at https://nera.js.org/llms-full.txt.',
        },
    )
    registerCatalogTools(server, { fetch })
    if (userId && githubToken) {
        // The token is fetched per tool call, so a refreshed one is used and a
        // lost sign-in becomes that call's error, not the request's.
        const repos = async () => createRepo(await githubToken(userId))
        registerHostedReadTools(server, { repos })
        registerHostedWriteTools(server, { repos })
    }
    return server
}
