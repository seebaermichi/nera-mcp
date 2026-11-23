// The hosted `validate` (L7b, plan D1/D6): the validator of `nera validate`
// over a temporary checkout of the site's draft (or of `main` when there is
// none), made by src/hosted/checkout.js and deleted afterwards. The records
// come back exactly as `validate({ cwd })` of `@nera-static/nera` returns
// them, like the local tool's. There is no hosted `build`: it would run the
// site's local plugins, which is user code, on the server.
import { hasErrors, validate as neraValidate } from '@nera-static/nera'
import { ok } from '../../results.js'
import { countBySeverity } from '../../tools/cli.js'
import { DRAFT_BRANCH } from '../repo.js'
import { createSiteAccess, hostedSiteInput, hostedTool } from './read.js'

/**
 * Registers the hosted `validate`.
 *
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @param {object} ctx
 * @param {() => Promise<ReturnType<import('../repo.js').createRepoClient>>} ctx.repos the signed-in user's repository client
 * @param {string} ctx.userId the signed-in user, whose checkouts run one at a time
 * @param {ReturnType<typeof import('../checkout.js').createCheckouts>} ctx.checkouts
 * @param {typeof neraValidate} [ctx.validate] the validator (`@nera-static/nera`'s)
 */
export function registerHostedValidateTool(server, { repos, userId, checkouts, validate = neraValidate }) {
    const { openSite } = createSiteAccess(repos)

    server.registerTool('validate', {
        title: 'Validate a Nera site',
        description: `Checks a Nera site in a GitHub repository the way the build will read it, on the draft branch ${DRAFT_BRANCH} when it exists (your unpublished changes), else on main: config/app.yaml and page frontmatter parse, every page has a \`layout\` that exists, every Pug include resolves, the theme is found. Returns one record per finding (\`file\`, \`line\`, \`severity\` error|warning, \`rule\`, \`message\` with the fix). Call it after write_page, write_file or delete_page; fix every error, then call publish. It takes a few seconds: the repository is downloaded for the check, plus the theme package when config/app.yaml names one (nothing is installed or run).`,
        inputSchema: { site: hostedSiteInput },
        annotations: { readOnlyHint: true },
    }, hostedTool(async ({ site }, { signal }) => {
        const target = await openSite(site)
        const results = await checkouts.withCheckout(
            userId,
            { client: target.client, site: target.site, ref: target.ref, signal },
            (dir) => validate({ cwd: dir }),
        )
        const counts = countBySeverity(results)
        const text = results.length
            ? `"${target.site}" (${target.branch}) has ${counts.errors} error(s) and ${counts.warnings} warning(s); each message says how to fix it.`
            : `"${target.site}" (${target.branch}) is valid.${target.draft.exists ? ' Call publish to put the draft live.' : ''}`
        return ok({ site: target.site, branch: target.branch, ok: !hasErrors(results), counts, results }, text)
    }))
}
