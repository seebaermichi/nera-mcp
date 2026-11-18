import { z } from 'zod'
import { freePort } from '../processes.js'
import { ok, tool, ToolError } from '../results.js'
import { failureText } from './cli.js'
import { resolveSite, siteInput } from './sites.js'

/** How long `preview` waits for `nera dev` to build the site and print its URL. */
export const PREVIEW_START_MS = 2 * 60 * 1000
/** How long one `publish` call waits for news (a sign-in step, the end) before it reports the run as still going. */
export const PUBLISH_WAIT_MS = 30 * 1000
/** The publish targets `nera publish --target` knows. */
const PUBLISH_TARGETS = ['github-pages', 'netlify']
/** How much of the CLI's last progress line a status carries. */
const PROGRESS_MAX = 300

/** Terminal colour codes (ESC [ … m), in case a child ignores NO_COLOR. Built from a string so the source holds no control character. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g')
/** The address Vite prints once it listens: `➜  Local:   http://localhost:3000/`. */
const LOCAL_URL = /Local:\s+(https?:\/\/[^\s]+)/

/**
 * The lines of `nera publish` that ask the user to do something in the
 * browser, and the lines that say it is done. Only these fixed shapes are
 * read: the GitHub user code and verification page (the code is what the
 * user types; it is not a credential — the device code and the tokens never
 * appear in the CLI's output), the GitHub App installation page, and the
 * Netlify authorization page.
 */
const ACTIONS = [
    {
        kind: 'github_sign_in',
        match: /To sign in to GitHub, enter the code ([A-Z0-9]{4,8}-[A-Z0-9]{4,8}) at (https:\/\/github\.com\/\S+)/,
        action: ([, code, url]) => ({ kind: 'github_sign_in', code, url }),
        done: /^Signed in as /,
    },
    {
        kind: 'github_app_install',
        match: /Install it at (https:\/\/github\.com\/apps\/\S+)/,
        action: ([, url]) => ({ kind: 'github_app_install', url }),
        done: /^Nera Static is installed on /,
    },
    {
        kind: 'netlify_sign_in',
        match: /To sign in to Netlify, open (https:\/\/app\.netlify\.com\/\S+) and choose "Authorize"/,
        action: ([, url]) => ({ kind: 'netlify_sign_in', url }),
        done: /^Signed in to Netlify/,
    },
]

const INSTRUCTIONS = {
    github_sign_in: ({ code, url }) => `Ask the user to open ${url} and enter the code ${code}, then call publish again.`,
    github_app_install: ({ url }) => `Ask the user to open ${url} and install the Nera Static app on their GitHub account, then call publish again.`,
    netlify_sign_in: ({ url }) => `Ask the user to open ${url} and choose "Authorize", then call publish again.`,
}

function lines(text) {
    return text.replace(ANSI, '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
}

/**
 * What a running `nera publish` waits for: the last browser step it asked
 * for that it has not reported done since, or null.
 *
 * @param {string} stderr the CLI's log (`--json` mode logs to stderr)
 * @returns {{ kind: string, code?: string, url: string }|null}
 */
export function pendingAction(stderr) {
    let pending = null
    for (const line of lines(stderr)) {
        for (const known of ACTIONS) {
            const found = line.match(known.match)
            if (found) pending = known.action(found)
            else if (pending?.kind === known.kind && known.done.test(line)) pending = null
        }
    }
    return pending
}

function lastProgress(stderr) {
    const last = lines(stderr).at(-1) ?? ''
    return last.length > PROGRESS_MAX ? `${last.slice(0, PROGRESS_MAX)}…` : last
}

/**
 * The local address `nera dev` serves on, once Vite has printed it.
 *
 * @param {string} stdout
 * @returns {string|null}
 */
export function previewUrl(stdout) {
    return stdout.replace(ANSI, '').match(LOCAL_URL)?.[1] ?? null
}

function publishArgs({ target, repo, domain, private: isPrivate }) {
    const args = ['publish', '--yes', '--json']
    if (target !== undefined) args.push(`--target=${target}`)
    if (repo !== undefined) args.push(`--repo=${repo}`)
    if (domain !== undefined) args.push(`--domain=${domain}`)
    if (isPrivate) args.push('--private')
    return args
}

/**
 * The tool result for a `nera publish` child: its JSON object once it has
 * exited (and the record is dropped, so the next call publishes again), else
 * where it stands.
 */
function publishStatus(ctx, site, run) {
    if (!run.exited) {
        const action = pendingAction(run.stderr)
        if (action) {
            return ok(
                { site, state: 'action_required', action },
                `Publishing "${site}" waits for the user. ${INSTRUCTIONS[action.kind](action)}`,
            )
        }
        return ok(
            { site, state: 'running', progress: lastProgress(run.stderr) },
            `Publishing "${site}" is still running (${lastProgress(run.stderr) || 'starting'}). Call publish again to follow it; the deploy can take a few minutes.`,
        )
    }

    ctx.processes.forget(run.key)
    let result
    try {
        result = JSON.parse(run.stdout)
    } catch {
        throw new ToolError(`Publishing "${site}" stopped without a result: ${failureText(run)}`)
    }
    if (!result.ok) {
        const hint = result.deploy?.hint ? ` ${result.deploy.hint}` : ''
        throw new ToolError(`Publishing "${site}" failed: ${result.error}.${hint}\n${JSON.stringify(result)}`)
    }
    return ok(
        { site, state: 'published', result },
        result.url ? `"${site}" is live at ${result.url}.` : `Publishing "${site}" finished.`,
    )
}

/**
 * Registers `preview` and `publish`, the two tools whose command outlives the
 * call: they start a tracked child (`ctx.processes`) and later calls read it.
 *
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @param {{ root: string, processes: ReturnType<typeof import('../processes.js').createProcesses>, timing?: { previewStartMs?: number, publishWaitMs?: number } }} ctx
 */
export function registerLongRunningTools(server, ctx) {
    const previewStartMs = ctx.timing?.previewStartMs ?? PREVIEW_START_MS
    const publishWaitMs = ctx.timing?.publishWaitMs ?? PUBLISH_WAIT_MS

    server.registerTool('preview', {
        title: 'Preview a Nera site',
        description: 'Builds a Nera site and serves it on this computer (`nera dev`), rebuilding whenever a page, template or setting changes, and returns the local address (e.g. http://localhost:3000/) for the user to open in a browser. Calling it again for the same site returns the running server\'s address; edits show up there by themselves. Pass `stop: true` to stop it. The server stops when this MCP server closes. If it fails, call validate to find the cause.',
        inputSchema: {
            site: siteInput,
            stop: z.boolean().optional().describe('Stop the site\'s running preview instead of starting one. Default false.'),
        },
    }, tool(async ({ site, stop = false }) => {
        const resolved = await resolveSite(ctx, site)
        const key = `preview:${resolved.dir}`
        if (stop) {
            const stopped = await ctx.processes.stop(key)
            return ok(
                { site: resolved.site, stopped },
                stopped ? `Stopped the preview of "${resolved.site}".` : `No preview of "${resolved.site}" was running.`,
            )
        }

        let run = ctx.processes.get(key)
        let reused = Boolean(run && !run.exited)
        if (!reused) {
            ctx.processes.forget(key)
            const port = await freePort()
            // a call for the same site may have started one while this one looked for a port
            run = ctx.processes.get(key)
            reused = Boolean(run)
            // BROWSER=none: Vite would open a browser on this computer otherwise
            run ??= ctx.processes.start(key, 'nera', ['dev', '--port', String(port)], { cwd: resolved.dir, env: { BROWSER: 'none' } })
        }
        await run.waitFor((r) => r.exited || previewUrl(r.stdout) !== null, previewStartMs)

        const url = previewUrl(run.stdout)
        if (run.exited) {
            ctx.processes.forget(key)
            throw new ToolError(`The preview of "${resolved.site}" stopped: ${failureText(run)}\nCall validate to find the cause, fix it, then call preview again.`)
        }
        if (!url) {
            await ctx.processes.stop(key)
            throw new ToolError(`The preview of "${resolved.site}" printed no address within ${previewStartMs / 1000} s and was stopped.${run.stderr.trim() ? ` Its log: ${failureText(run)}` : ''}`)
        }
        return ok(
            { site: resolved.site, url, reused },
            `${reused ? 'The preview is running' : 'Started the preview'} at ${url}. Give the user this address; it updates by itself when files change.`,
        )
    }))

    server.registerTool('publish', {
        title: 'Publish a Nera site',
        description: 'Puts a Nera site online (`nera publish`): signs in to GitHub, pushes the site to a GitHub repository and lets GitHub Actions build and deploy it to GitHub Pages (the default) or Netlify, then returns the live address. It runs in the background: the first call starts it and usually returns `action_required` with a sign-in code and a web address the user must open (GitHub sign-in, installing the Nera Static app, or Netlify authorization). Show the user exactly that, then call publish again with the same site — each call reports the current state (`action_required`, `running`) until it returns `published` with the live URL, or an error. `target`, `repo`, `domain` and `private` apply when a run starts; a call while one runs only reports on it. Run build first so you know the site builds.',
        inputSchema: {
            site: siteInput,
            target: z.enum(PUBLISH_TARGETS).optional().describe('Where to host the site: `github-pages` (free, the default) or `netlify`. Leave out to keep the host the site was published to before.'),
            repo: z.string().regex(/^[A-Za-z0-9._-]+$/, 'A repository name: letters, digits, `.`, `-`, `_`').optional().describe('The GitHub repository name to create or use (default: the site folder\'s name).'),
            domain: z.string().optional().describe('A custom domain the user owns, e.g. `www.example.com`.'),
            private: z.boolean().optional().describe('Make a new repository private (GitHub Pages then needs a paid GitHub plan). Default false.'),
        },
    }, tool(async ({ site, ...options }) => {
        const resolved = await resolveSite(ctx, site)
        const key = `publish:${resolved.dir}`
        let run = ctx.processes.get(key)
        if (!run) {
            run = ctx.processes.start(key, 'nera', publishArgs(options), { cwd: resolved.dir })
        }
        const before = pendingAction(run.stderr)
        await run.waitFor((r) => {
            if (r.exited) return true
            const now = pendingAction(r.stderr)
            return now !== null && now.kind !== before?.kind
        }, publishWaitMs)
        return publishStatus(ctx, resolved.site, run)
    }))
}
