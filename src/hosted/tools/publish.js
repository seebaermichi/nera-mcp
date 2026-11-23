// `publish` and `preview` of the hosted mode (L7b, plan D1/D2). The write
// tools collect their commits on the draft branch `nera-draft`; `publish`
// merges it into `main` in one push, so the site's deploy workflow
// (`.github/workflows/deploy.yml`, which triggers on pushes to `main` only)
// builds and deploys once per batch, and deletes the draft. A draft without
// unpublished commits, or no draft at all, pushes nothing, so no deploy is
// started for nothing. The build itself runs in the site's own Actions run;
// both tools only report it, with the address the site is served at.
import { z } from 'zod'
import { ok, ToolError } from '../../results.js'
import { GitHubError } from '../github.js'
import { BASE_BRANCH, DRAFT_BRANCH } from '../repo.js'
import { createSiteAccess, hostedSiteInput, hostedTool } from './read.js'

/**
 * The deploy workflow's file name in `.github/workflows/`: the one `nera
 * publish` commits (`renderDeployWorkflow` of `@nera-static/nera`).
 */
export const DEPLOY_WORKFLOW = 'deploy.yml'
/** How often `publish` looks for the deploy run of its push, which GitHub starts a few seconds later. */
export const RUN_LOOKUPS = 5
/** The pause between two lookups. */
export const RUN_LOOKUP_MS = 2000

const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * The `origin` of `config/app.yaml` when it is an http(s) address.
 *
 * @param {object} appConfig
 * @returns {string|null}
 */
function originOf(appConfig) {
    if (typeof appConfig.origin !== 'string') return null
    try {
        const url = new URL(appConfig.origin)
        return url.protocol === 'https:' || url.protocol === 'http:' ? appConfig.origin : null
    } catch {
        return null
    }
}

/**
 * Runs a lookup that only adds information (the deploy run, the address):
 * GitHub refusing it (a missing permission such as Pages or Actions read, an
 * outage) must not turn a publish that happened into an error, so it yields
 * null instead. The site lookup itself is never wrapped, so a lost sign-in
 * still fails the call before anything is pushed.
 */
async function lookup(fn) {
    try {
        return await fn()
    } catch (error) {
        if (error instanceof GitHubError) return null
        throw error
    }
}

/** One sentence on a deploy run, for the result's text. */
function runText(run) {
    if (!run) return `No run of .github/workflows/${DEPLOY_WORKFLOW} on ${BASE_BRANCH} was found.`
    const state = run.status === 'completed' ? `finished: ${run.conclusion}` : run.status.replace('_', ' ')
    return `The deploy run is ${state} (${run.url}).`
}

/**
 * Registers `publish` and `preview`.
 *
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @param {object} ctx
 * @param {() => Promise<ReturnType<import('../repo.js').createRepoClient>>} ctx.repos the signed-in user's repository client
 * @param {(ms: number) => Promise<void>} [ctx.sleep] the pause between run lookups (injected so tests do not wait)
 */
export function registerHostedPublishTools(server, { repos, sleep = sleepFor }) {
    const { openSite, appConfigAt } = createSiteAccess(repos)

    /** The address the site is served at: GitHub Pages', else `origin` in config/app.yaml on main. */
    async function siteUrl(target) {
        const pages = await lookup(() => target.client.pagesUrl(target.site))
        if (pages) return pages
        const config = await lookup(() => appConfigAt(target, BASE_BRANCH))
        return config ? originOf(config.appConfig) : null
    }

    /** The deploy run of the push of `sha`, looked for a few times while GitHub starts it. */
    async function runFor(target, sha) {
        for (let attempt = 1; attempt <= RUN_LOOKUPS; attempt += 1) {
            const run = await lookup(() => target.client.latestRun(target.site, DEPLOY_WORKFLOW, { sha }))
            if (run) return run
            if (attempt < RUN_LOOKUPS) await sleep(RUN_LOOKUP_MS)
        }
        return null
    }

    /** The draft's unpublished commits: 0 without a draft. */
    async function draftAhead(target) {
        if (!target.draft.exists) return 0
        if (!target.mainSha) {
            throw new ToolError(`The repository "${target.site}" has a draft but no ${BASE_BRANCH} branch to publish it to. Create ${BASE_BRANCH} on GitHub first.`)
        }
        return target.client.aheadBy(target.site, target.mainSha, target.draft.sha)
    }

    /** The result of a publish that pushed nothing. */
    async function nothingPublished(target, reason) {
        const run = await lookup(() => target.client.latestRun(target.site, DEPLOY_WORKFLOW))
        const url = await siteUrl(target)
        return ok(
            { site: target.site, published: false, commits: 0, commit: null, run, url },
            `${reason} Nothing was pushed to ${BASE_BRANCH}, so no deploy was started. ${runText(run)}${url ? ` The site is at ${url}.` : ''}`,
        )
    }

    server.registerTool('publish', {
        title: 'Publish the draft',
        description: `Puts a Nera site's unpublished changes live. Every write_page, write_file and delete_page commits to the draft branch ${DRAFT_BRANCH} of the site's GitHub repository; publish merges that draft into ${BASE_BRANCH} in one push and deletes it. The push starts the site's deploy workflow (.github/workflows/${DEPLOY_WORKFLOW}, GitHub Actions), which builds the site and deploys it to GitHub Pages or Netlify, once for all changes since the last publish. Call validate first and fix its errors. Returns the merge commit, the deploy run (status and address; it takes a minute or two) and the address the site is served at; call preview later to see whether the run succeeded. Without unpublished changes nothing is pushed and only the latest run is reported.`,
        inputSchema: {
            site: hostedSiteInput,
            message: z.string().optional().describe(`The merge commit's message, used only when ${BASE_BRANCH} changed since the draft began (otherwise the draft's own commits go onto ${BASE_BRANCH} as they are). Defaults to "Publish the changes from ${DRAFT_BRANCH}".`),
        },
    }, hostedTool(async ({ site, message }) => {
        const target = await openSite(site)
        if (!target.draft.exists) return nothingPublished(target, `"${target.site}" has no unpublished changes.`)
        const ahead = await draftAhead(target)
        if (ahead === 0) {
            await target.client.deleteDraft(target.site)
            return nothingPublished(target, `The draft of "${target.site}" held no unpublished commits, so it was deleted.`)
        }
        const merged = await target.client.mergeDraft(target.site, message?.trim() || `Publish the changes from ${DRAFT_BRANCH}`)
        // null: another call published the draft in the meantime.
        if (!merged) return nothingPublished(target, `The draft of "${target.site}" was published by another call in the meantime.`)
        const run = await runFor(target, merged.sha)
        const url = await siteUrl(target)
        const runSentence = run
            ? runText(run)
            : `GitHub has not started the deploy run yet; call preview in a minute to see it. If none appears, the repository has no .github/workflows/${DEPLOY_WORKFLOW} — \`nera publish\` sets it up once.`
        return ok(
            { site: target.site, published: true, commits: ahead, commit: merged.sha, fastForward: merged.fastForward, run, url },
            `Published ${ahead} commit(s) of "${target.site}" to ${BASE_BRANCH} (${merged.sha.slice(0, 7)}) and deleted the draft. ${runSentence}${url ? ` Once it succeeds, the site is live at ${url}.` : ''}`,
        )
    }))

    server.registerTool('preview', {
        title: 'Show the live site',
        description: `Shows where a Nera site in a GitHub repository is live and how its last deploy went: the address it is served at (GitHub Pages, else \`origin\` in config/app.yaml), the latest run of its deploy workflow (.github/workflows/${DEPLOY_WORKFLOW}: status, conclusion, address) and how many changes wait unpublished on the draft branch ${DRAFT_BRANCH}. Call it after publish to see whether the deploy succeeded; unpublished changes are not visible at the address until publish.`,
        inputSchema: { site: hostedSiteInput },
        annotations: { readOnlyHint: true },
    }, hostedTool(async ({ site }) => {
        const target = await openSite(site)
        const ahead = await draftAhead(target)
        const run = await lookup(() => target.client.latestRun(target.site, DEPLOY_WORKFLOW))
        const url = await siteUrl(target)
        const where = url
            ? `"${target.site}" is served at ${url}.`
            : `No address found for "${target.site}": GitHub Pages is not set up for it and config/app.yaml has no origin.`
        const draft = ahead
            ? ` ${ahead} unpublished commit(s) wait on ${DRAFT_BRANCH}; call publish to put them live.`
            : ' It has no unpublished changes.'
        return ok(
            { site: target.site, url, run, draft: { exists: target.draft.exists, ahead } },
            `${where} ${runText(run)}${draft}`,
        )
    }))
}
