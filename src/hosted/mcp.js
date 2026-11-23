// The MCP server of the hosted mode (L7b, plan D3/D5). It has no folder to
// work in: the catalogs of starters, themes and plugins need none, and the
// site tools work on the signed-in user's GitHub repositories through the
// repository client (src/hosted/repo.js). The app (src/hosted/app.js) builds
// one per `/mcp` request, bound to the user its bearer token belongs to.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import pkg from '../../package.json' with { type: 'json' }
import { registerCatalogTools } from '../catalog.js'
import { sharedCheckouts } from './checkout.js'
import { createRepoClient } from './repo.js'
import { registerHostedPublishTools } from './tools/publish.js'
import { registerHostedReadTools } from './tools/read.js'
import { registerHostedValidateTool } from './tools/validate.js'
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
 * @param {ReturnType<typeof import('./checkout.js').createCheckouts>} [options.checkouts] the temporary checkouts of `validate`; the process-wide ones by default, since this server lives for one request only
 * @param {(ms: number) => Promise<void>} [options.sleep] the pause between `publish`'s lookups of the deploy run (injected so tests do not wait)
 * @returns {McpServer}
 */
export function createHostedServer({
    fetch = globalThis.fetch,
    userId,
    githubToken,
    createRepo = (token) => createRepoClient({ token }),
    checkouts = sharedCheckouts,
    sleep,
} = {}) {
    const server = new McpServer(
        { name: pkg.name, version: pkg.version },
        {
            instructions: 'Tools for Nera, a static site generator: a site is Markdown pages rendered through Pug layouts into plain HTML. This hosted server works on your Nera sites in GitHub repositories: list_sites finds them, get_site describes one, read_page and read_file read its files, write_page, write_file and delete_page change them as one commit each on the draft branch nera-draft, which goes live only with publish, validate checks the draft, publish merges the draft into main so the site\'s GitHub Actions workflow builds and deploys it once, and preview shows the live address and how the last deploy went. It also lists the Nera starter kits, themes and plugins. The full documentation is at https://nera.js.org/llms-full.txt.',
        },
    )
    registerCatalogTools(server, { fetch })
    if (userId && githubToken) {
        // The token is fetched per tool call, so a refreshed one is used and a
        // lost sign-in becomes that call's error, not the request's.
        const repos = async () => createRepo(await githubToken(userId))
        registerHostedReadTools(server, { repos })
        registerHostedWriteTools(server, { repos })
        registerHostedValidateTool(server, { repos, userId, checkouts })
        registerHostedPublishTools(server, { repos, sleep })
    }
    return server
}
