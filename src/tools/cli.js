import fs from 'node:fs/promises'
import path from 'node:path'
import { hasErrors, validate } from '@nera-static/nera'
import { z } from 'zod'
import { resolveInRoot } from '../paths.js'
import { ok, tool, ToolError } from '../results.js'
import { childEnv } from '../runner.js'
import { relativeTo, resolveSite, siteFolders, siteInput } from './sites.js'

const PLUGIN_SCOPE = '@nera-static/'
const PLUGIN_NAME = /^[a-z0-9][a-z0-9-]*$/
const NOT_PLUGINS = new Set(['utils'])
/** A folder name `nera new` accepts, or `.` for the root itself. */
const SITE_FOLDER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
/** A theme or starter package: a bare name (`blog`) or an npm package (`@scope/name`, `nera-starter-x`). */
const PACKAGE_SPEC = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
/** A starter on GitHub: `github:owner/repo` or `https://github.com/owner/repo`, each with an optional `#ref`. */
const GITHUB_STARTER = /^(?:github:|https:\/\/github\.com\/)[\w.-]+\/[\w.-]+(?:#[\w./-]+)?$/
/** A starter folder: a path starting with `.` or `/`, checked against the root. */
const LOCAL_STARTER = /^[./]/
/** How much of a command's log a tool result carries (its end). */
const LOG_TAIL = 4000

function tail(text) {
    const trimmed = text.trim()
    return trimmed.length > LOG_TAIL ? `…${trimmed.slice(-LOG_TAIL)}` : trimmed
}

/**
 * The command's own error text (its stderr, else its stdout), for a failure message.
 *
 * @param {{ code: number|null, stdout: string, stderr: string }} run
 * @returns {string}
 */
export function failureText(run) {
    return tail(run.stderr) || tail(run.stdout) || `exit code ${run.code}`
}

/**
 * How many of the validator's records are errors and how many warnings.
 *
 * @param {Array<{severity: string}>} results
 * @returns {{ errors: number, warnings: number }}
 */
export function countBySeverity(results) {
    const errors = results.filter((r) => r.severity === 'error').length
    return { errors, warnings: results.length - errors }
}

/**
 * The `starter` for `createSite`: a package name as given, or a local starter
 * folder checked against the root and passed relative to it (`createSite`
 * runs with the root as its `cwd`).
 */
async function starterArg(ctx, starter) {
    if (PACKAGE_SPEC.test(starter) || GITHUB_STARTER.test(starter)) {
        return starter
    }
    if (LOCAL_STARTER.test(starter)) {
        const real = await resolveInRoot(ctx.root, starter, { label: 'starter folder' })
        return `./${relativeTo(ctx.root, real)}`
    }
    throw new ToolError(`Invalid starter "${starter}". Use a starter name from list_starters (e.g. \`blog\`), a package name (\`@nera-static/starter-blog\`), a GitHub repository (\`github:owner/repo\`) or a starter folder inside the root (\`./my-starter\`).`)
}

/**
 * The npm package of an `add_plugin` spec, in the same forms the CLI's
 * addPlugin takes: `@nera-static/plugin-<name>`, `plugin-<name>` or just
 * `<name>`; anything else (another scope, a version, a path, a URL) is
 * refused.
 */
function pluginPackage(spec) {
    const name = spec.replace(new RegExp(`^(${PLUGIN_SCOPE}plugin-|plugin-)`), '')
    if (!PLUGIN_NAME.test(name) || NOT_PLUGINS.has(name)) {
        throw new ToolError(`"${spec}" is not a Nera plugin. Pass an official plugin as \`@nera-static/plugin-<name>\`, \`plugin-<name>\` or just \`<name>\` (e.g. \`sitemap\`); call list_plugins for the catalog.`)
    }
    return { name, pkg: `${PLUGIN_SCOPE}plugin-${name}` }
}

/**
 * Registers `create_site`, `build`, `validate` and `add_plugin`.
 *
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @param {{ root: string, runner: ReturnType<typeof import('../runner.js').createRunner>, createSite: typeof import('@nera-static/nera').createSite, addPlugin: typeof import('@nera-static/nera').addPlugin }} ctx `create_site` installs through `createSite`, `add_plugin` through `addPlugin`, `build` through `runner`
 */
export function registerCliTools(server, ctx) {
    server.registerTool('create_site', {
        title: 'Create a Nera site',
        description: 'Creates a new Nera static site in a new folder of the root folder (like `nera new`), installs its packages and returns the folder to pass as `site` to every other tool. Pick a starter from list_starters (`blank`, `blog`, `business`, `portfolio`) to begin with sample pages and a theme, or a theme from list_themes; with neither you get a minimal site. This can take a minute (npm install). A starter\'s suggested first steps come back as `firstSteps`. Afterwards call get_site, then edit pages with write_page.',
        inputSchema: {
            name: z.string().describe('The new folder, created directly in the root: letters, digits, `.`, `-`, `_` (e.g. `my-bakery`). `.` creates the site in the root itself, which must then be empty.'),
            starter: z.string().optional().describe('A starter kit from list_starters, e.g. `blog` or `@nera-static/starter-business`. Leave out for a minimal site.'),
            theme: z.string().optional().describe('A theme from list_themes, e.g. `blog` or `@nera-static/theme-business`, when no starter is given (a starter brings its own theme).'),
            title: z.string().optional().describe('The site\'s name as visitors see it (written to config/app.yaml).'),
            lang: z.string().optional().describe('The site\'s language code, e.g. `en` or `de`.'),
        },
    }, tool(async ({ name, starter, theme, title, lang }, { signal }) => {
        const inRoot = name === '.' || name === './'
        if (!inRoot && !SITE_FOLDER.test(name)) {
            throw new ToolError(`Invalid site folder "${name}". Use one folder name made of letters, digits, \`.\`, \`-\` and \`_\`, starting with a letter or digit (e.g. \`my-site\`), or \`.\` for the root itself.`)
        }
        const target = await resolveInRoot(ctx.root, inRoot ? '.' : name, { label: 'site folder' })
        if (!inRoot && await exists(target)) {
            throw new ToolError(`"${name}" already exists in ${ctx.root}. Choose another name, or call list_sites to work on an existing site.`)
        }
        if (theme !== undefined && !PACKAGE_SPEC.test(theme)) {
            throw new ToolError(`Invalid theme "${theme}". Use a theme name from list_themes (e.g. \`blog\`) or a package name (\`@nera-static/theme-blog\`).`)
        }

        const spec = starter === undefined ? undefined : await starterArg(ctx, starter)

        // Every progress line is collected for the result and npm install's
        // output goes to stderr (createSite's default): stdout belongs to the
        // protocol. `env` is a child's (the shim first under the bundled
        // runtime) and reaches createSite's own children; the call's signal
        // stops them.
        const site = relativeTo(ctx.root, target)
        const lines = []
        let created
        try {
            created = await ctx.createSite(inRoot ? '.' : name, {
                cwd: ctx.root, starter: spec, theme, name: title, lang,
                install: true, signal, env: childEnv(), log: (line) => lines.push(line),
            })
        } catch (error) {
            // A failed install keeps the written site (npm install can be
            // rerun there); after anything else, an abort included,
            // createSite has removed a new folder again.
            if (!signal.aborted && typeof error.code === 'number' && await exists(path.join(target, 'package.json'))) {
                throw new ToolError(`The files of the site "${site}" are written, but installing its packages failed: ${error.message}\nnpm's own output is in the server's log. Fix what npm reports (often the network connection), then run \`npm install\` in that folder, or call create_site again with another name.`)
            }
            throw new ToolError(`Creating the site failed: ${error.message}`)
        }
        const firstSteps = created.firstSteps ?? null
        return ok(
            { site, log: tail(lines.join('\n')), firstSteps },
            firstSteps
                ? `Created the Nera site "${site}". Its starter suggests first steps (in firstSteps); follow them, starting with get_site with site "${site}".`
                : `Created the Nera site "${site}". Call get_site with site "${site}" to see its pages, then edit them with write_page.`,
        )
    }))

    server.registerTool('build', {
        title: 'Build a Nera site',
        description: 'Builds a Nera site (`nera build`): renders its Markdown pages through their layouts into plain HTML in its output folder (`public/`), which is what gets published. With `check: true` it then checks the built HTML for accessibility, privacy and legal problems and returns those findings. Call validate first to catch broken layouts and YAML; call preview to look at the result in a browser.',
        inputSchema: {
            site: siteInput,
            check: z.boolean().optional().describe('Also check the built HTML (accessibility, privacy, legal hints). Default false.'),
        },
    }, tool(async ({ site, check = false }, { signal }) => {
        const resolved = await resolveSite(ctx, site)
        const args = ['build', '--json', ...(check ? ['--check'] : [])]
        const run = await ctx.runner('nera', args, { cwd: resolved.dir, signal })
        let parsed
        try {
            parsed = JSON.parse(run.stdout)
        } catch {
            throw new ToolError(`The build of "${resolved.site}" gave no result: ${failureText(run)}`)
        }
        if (parsed.error) {
            throw new ToolError(`The build of "${resolved.site}" failed: ${parsed.error}. Call validate to find the cause.${run.stderr.trim() ? `\nBuild log:\n${tail(run.stderr)}` : ''}`)
        }
        const results = parsed.results ?? []
        const { errors, warnings } = countBySeverity(results)
        const text = check
            ? `Built "${resolved.site}"; the output check found ${errors} error(s) and ${warnings} warning(s).`
            : `Built "${resolved.site}" into its output folder. Call preview to look at it.`
        return ok({ site: resolved.site, ok: parsed.ok, results }, text)
    }))

    server.registerTool('validate', {
        title: 'Validate a Nera site',
        description: 'Checks a Nera site before building it, the way the build will read it: config/app.yaml and page frontmatter parse, every page has a `layout` that exists, every Pug include resolves, the theme is found. Returns one record per finding (`file`, `line`, `severity` error|warning, `rule`, `message` with the fix). Call it after editing pages, templates or configuration; fix every error, then build.',
        inputSchema: { site: siteInput },
        annotations: { readOnlyHint: true },
    }, tool(async ({ site }) => {
        const resolved = await resolveSite(ctx, site)
        const results = validate({ cwd: resolved.dir })
        const { errors, warnings } = countBySeverity(results)
        const text = results.length
            ? `"${resolved.site}" has ${errors} error(s) and ${warnings} warning(s); each message says how to fix it.`
            : `"${resolved.site}" is valid. Call build or preview next.`
        return ok({ site: resolved.site, ok: !hasErrors(results), results }, text)
    }))

    server.registerTool('add_plugin', {
        title: 'Add a Nera plugin',
        description: 'Installs an official Nera plugin into a site (npm install), copies its default configuration to `config/<name>.yaml` when the site has none, and copies its Pug templates to `views/vendor/plugin-<name>/` when it ships any. Call list_plugins for the catalog. Afterwards read the plugin\'s config with read_file and include its templates in a layout with write_file, then validate.',
        inputSchema: {
            site: siteInput,
            plugin: z.string().describe('The plugin, as `@nera-static/plugin-<name>`, `plugin-<name>` or just `<name>` (e.g. `sitemap`, `tags`).'),
        },
    }, tool(async ({ site, plugin }, { signal }) => {
        const { name, pkg } = pluginPackage(plugin)
        const resolved = await resolveSite(ctx, site)
        // addPlugin writes `<folders.config>/<name>.yaml` without checking
        // where it leads, so a config folder or file that is a symbolic link
        // out of the site is refused here, before npm runs.
        const { model } = await siteFolders(resolved.dir)
        await resolveInRoot(resolved.dir, path.join(model.folders.config, `${name}.yaml`), { label: 'plugin config file' })

        // As for create_site: every progress line is collected for the
        // result, npm's and the template script's output goes to stderr
        // (addPlugin's default), `env` is a child's and the call's signal
        // stops the running child.
        const lines = []
        let added
        try {
            added = await ctx.addPlugin(pkg, { cwd: resolved.dir, signal, env: childEnv(), log: (line) => lines.push(line) })
        } catch (error) {
            // A command that ran and failed (npm install, the template
            // script) carries its exit code; its own output is not captured.
            const childFailed = !signal.aborted && typeof error.cause?.code === 'number'
            throw new ToolError(childFailed ? `${error.message}\nThe command's own output is in the server's log. Fix what it reports (for npm often the network connection), then call add_plugin again.` : error.message)
        }

        const { config, templates } = added
        const steps = [
            config.status === 'copied' ? `its configuration is in ${config.file}` : null,
            config.status === 'kept' ? `the site's own ${config.file} was kept` : null,
            templates === 'published' ? 'its templates are in the site\'s views/vendor folder' : null,
        ].filter(Boolean)
        return ok(
            { site: resolved.site, plugin: added.plugin, config, templates, log: tail(lines.join('\n')) },
            `Installed ${added.plugin} in "${resolved.site}"${steps.length ? `; ${steps.join(', ')}` : ''}. Then call validate.`,
        )
    }))
}

async function exists(target) {
    try {
        await fs.lstat(target)
        return true
    } catch {
        return false
    }
}
