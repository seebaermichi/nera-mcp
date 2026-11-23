// The temporary checkout of the hosted `validate` (L7b, plan D1/D6). The
// hosted server builds nothing and runs no npm: it downloads a site's tarball
// from GitHub, unpacks it with the system `tar` into a fresh folder, deletes
// every symbolic link (and anything else that is not a plain file or folder),
// refuses a config that points the validator outside the checkout, downloads
// the one theme package `config/app.yaml` names from the npm registry (nothing
// else: the validator needs node_modules only to find the theme), refuses a
// layout or Pug include/extends that leaves the checkout, hands the folder to
// the caller and removes it again, whatever happened. Each user runs one
// checkout at a time. No code of the site or the theme runs: nothing is
// installed, and the validator reads files, it imports none.
import fssync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { gunzip as gunzipCallback } from 'node:zlib'
import { computeFolders, defaultSettings, makeLayeredResolver, resolveEntry, resolveSiteModel } from '@nera-static/core'
import semver from 'semver'
import yaml from 'yaml'
import { ToolError } from '../results.js'
import { createRunner } from '../runner.js'
import { failureText } from '../tools/cli.js'
import { readLimited } from './repo.js'

const gunzip = promisify(gunzipCallback)

/** The default cap on each unpacked archive; the site's download has its own (`downloadTarball`). */
export const MAX_UNPACKED_BYTES = 200 * 1024 * 1024
/** The default cap on the theme package's download. */
export const MAX_THEME_BYTES = 20 * 1024 * 1024
/** The cap on the theme's registry metadata (a theme's is a few kilobytes). */
const MAX_PACKUMENT_BYTES = 5 * 1024 * 1024
/** A theme package as `theme:` names it: a bare name (`blog`) or an npm package (`@scope/name`). */
const THEME_PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
/** The lockfiles that may pin the theme's version. */
const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json']
/** The only host the checkout downloads a package from. */
export const NPM_REGISTRY = 'https://registry.npmjs.org/'
/** The package.json fields that name the site's theme package, in the order they are searched. */
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies']
/** The frontmatter fence exactly as `@nera-static/validate` (src/frontmatter.js) reads it. */
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/
/** A Pug `include`/`include:filter`/`extends` line exactly as `@nera-static/validate` (src/pug-refs.js) reads it. */
const PUG_REFERENCE = /^\s*(?:include(?::[^\s]+)?|extends)\s+(.+?)\s*$/

/**
 * The environment of every child of a checkout: the PATH of this process (to
 * find `tar`), nothing else — no token, no `NERA_MCP_*` setting reaches tar.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {Record<string, string>}
 */
export function checkoutEnv(env = process.env) {
    const stripped = { NO_COLOR: '1' }
    if (env.PATH !== undefined) stripped.PATH = env.PATH
    return stripped
}

/**
 * Deletes, below `dir`, every entry that is neither a plain file nor a folder:
 * symbolic links first of all (one could point the validator at a file of the
 * server), but also FIFOs, sockets and devices.
 *
 * @param {string} dir
 * @returns {Promise<number>} how many entries were deleted
 */
export async function removeLinks(dir) {
    let removed = 0
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
            removed += await removeLinks(full)
        } else if (!entry.isFile()) {
            await fs.rm(full, { force: true })
            removed += 1
        }
    }
    return removed
}

/** Whether `target` is `dir` or inside it, both resolved. */
function isInside(dir, target) {
    const relative = path.relative(dir, target)
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/**
 * The npm package of a `theme:` that names one, the way core resolves it: a
 * bare name is `@nera-static/theme-<name>`, a scoped name is used verbatim.
 * Mirrors core's `packageName` (src/theme.js), which core does not export;
 * core's unscoped `a/b` case is left out because `THEME_PACKAGE` refuses it.
 */
function themePackageName(spec) {
    return spec.startsWith('@') ? spec : `@nera-static/theme-${spec}`
}

/**
 * Refuses a site whose `config/app.yaml` sends the validator outside the
 * checkout: a `folders.<key>` that resolves outside it, a local `theme:` path
 * that does, or a theme package name that is none. An app.yaml that does not
 * parse is left to the validator, which reports it (and then uses the default
 * folders, all inside).
 *
 * @param {string} dir the checkout
 * @returns {Promise<string|null>} the theme's npm package when `theme:` names one, else null
 * @throws {ToolError}
 */
export async function refuseEscapes(dir) {
    let appConfig
    try {
        const text = await fs.readFile(path.join(dir, defaultSettings.folders.config, 'app.yaml'), 'utf8')
        appConfig = yaml.parse(text)
    } catch {
        return null
    }
    if (!appConfig || typeof appConfig !== 'object' || Array.isArray(appConfig)) return null
    for (const [key, folder] of Object.entries(computeFolders(appConfig, { cwd: dir }))) {
        if (typeof folder !== 'string' || !isInside(dir, path.resolve(dir, folder))) {
            throw new ToolError(`folders.${key} in config/app.yaml ("${folder}") points outside the repository. The hosted validate reads only files inside the repository; give the folder relative to it, e.g. ./${key}.`)
        }
    }
    const theme = appConfig.theme
    if (theme === undefined || theme === null || theme === '') return null
    const spec = String(theme)
    if (spec.startsWith('.')) {
        if (isInside(dir, path.resolve(dir, spec))) return null
    } else if (THEME_PACKAGE.test(spec)) {
        return themePackageName(spec)
    }
    throw new ToolError(`theme in config/app.yaml ("${spec}") is neither a theme package (e.g. blog or @nera-static/theme-blog) nor a folder inside the repository (e.g. ./themes/mine).`)
}

/** Reads a JSON file of the checkout; a file that does not parse is a tool error. */
async function readJson(dir, name) {
    const text = await fs.readFile(path.join(dir, name), 'utf8')
    try {
        return JSON.parse(text)
    } catch {
        throw new ToolError(`${name} is not valid JSON, so the hosted validate cannot find the version of the site's theme. Fix ${name} and call validate again.`)
    }
}

/**
 * Which version of the theme package `name` the site installs: the one its
 * lockfile pins (`packages["node_modules/<name>"]`, which must come from
 * `NPM_REGISTRY`), else the range or tag its package.json names. A site that
 * depends on no such package gets none: the validator then reports the theme
 * as not installed, as the build would fail on it.
 *
 * @param {string} dir the checkout
 * @param {string} name the theme's npm package
 * @returns {Promise<{ version: string } | { spec: string } | null>}
 * @throws {ToolError} for a pin outside the registry or a spec that is no range or tag
 */
export async function themeRequest(dir, name) {
    const files = await fs.readdir(dir)
    for (const lockfile of LOCKFILES.filter((file) => files.includes(file))) {
        const entry = (await readJson(dir, lockfile))?.packages?.[`node_modules/${name}`]
        if (!entry || typeof entry !== 'object') continue
        if (!String(entry.resolved ?? '').startsWith(NPM_REGISTRY)) {
            throw new ToolError(`The theme ${name} in ${lockfile} comes from "${entry.resolved ?? 'nowhere'}", not from the npm registry. The hosted validate downloads themes from ${NPM_REGISTRY} only; install the theme from npm (npm install ${name}) and commit ${lockfile}.`)
        }
        if (!semver.valid(entry.version)) {
            throw new ToolError(`The theme ${name} in ${lockfile} has the version "${entry.version}", which is none. Regenerate ${lockfile} with npm install and call validate again.`)
        }
        return { version: entry.version }
    }
    if (!files.includes('package.json')) return null
    const manifest = await readJson(dir, 'package.json')
    for (const field of DEPENDENCY_FIELDS) {
        const spec = manifest?.[field]?.[name]
        if (spec === undefined) continue
        if (typeof spec !== 'string' || (!semver.validRange(spec) && !/^[\w.-]+$/.test(spec))) {
            throw new ToolError(`The theme ${name} in package.json (${field}) is "${spec}", which is not a version range or tag of the npm registry. The hosted validate downloads themes from ${NPM_REGISTRY} only: give a range such as ^1.2.0, or validate this site locally with nera validate.`)
        }
        return { spec }
    }
    return null
}

/**
 * The version a registry `packument` has for `request`: the pinned version,
 * the highest version in the range, or the version of the dist-tag.
 *
 * @returns {string|null}
 */
function pickVersion(packument, request) {
    const versions = Object.keys(packument?.versions ?? {})
    if ('version' in request) return versions.includes(request.version) ? request.version : null
    // npm reads a spec as a range when it is one, else as a dist-tag
    const range = semver.validRange(request.spec)
    if (range) return semver.maxSatisfying(versions, range)
    const tagged = packument?.['dist-tags']?.[request.spec]
    return typeof tagged === 'string' && versions.includes(tagged) ? tagged : null
}

/** The tool error for a view path that leaves the checkout; it never says whether the target exists. */
function viewEscape(where, value) {
    return new ToolError(`${where} ("${value}") points outside the repository. The hosted validate reads only files inside the repository; give the path relative to the views folder (a layout) or to the including file (an include).`)
}

/** Every `.md` file below `dir`, like the validator's walk (a missing folder has none). */
async function markdownFiles(dir) {
    let entries
    try {
        entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
        return []
    }
    const found = []
    for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) found.push(...await markdownFiles(full))
        else if (entry.name.endsWith('.md')) found.push(full)
    }
    return found
}

/**
 * Follows the include/extends graph of `file` the way the validator does
 * (`collectIncludeFindings`) and refuses the first target that resolves
 * outside `dir`, before the validator would test whether it exists or read it.
 */
async function refuseIncludeEscapes(file, roots, dir, visited) {
    if (visited.has(file)) return
    visited.add(file)
    let source
    try {
        source = await fs.readFile(file, 'utf8')
    } catch {
        return
    }
    const resolve = makeLayeredResolver(roots)
    const lines = source.split(/\r?\n/)
    for (const [index, line] of lines.entries()) {
        const match = line.match(PUG_REFERENCE)
        if (!match) continue
        const target = match[1]
        // Pug appends .pug to an extensionless target before resolving it.
        const resolved = resolve(path.extname(target) ? target : `${target}.pug`, file, { basedir: roots[0] })
        if (!isInside(dir, resolved)) {
            throw viewEscape(`The include/extends target on line ${index + 1} of ${path.relative(dir, file)}`, target)
        }
        if (path.extname(resolved) === '.pug' && fssync.existsSync(resolved)) {
            await refuseIncludeEscapes(resolved, roots, dir, visited)
        }
    }
}

/**
 * Refuses, before the validator runs, every path it would look up outside the
 * checkout: a view root (the theme) found outside it, e.g. in a node_modules
 * folder above it; a page's `layout:` that leaves it below any view root; and
 * a Pug include/extends, in any template the validator reaches from a layout,
 * that leaves it. Without this the validator's verdict on such a path tells
 * whether a file of the server exists, and the include lines of a server
 * template appear in its messages. The lasting fix is a root jail in
 * `validateSite` (the `[nera-validate]` issue 01a2050a-60cb-7274-84dc-ce7f845ffca8);
 * until then this mirrors the validator's own lookups through core's resolver.
 *
 * @param {string} dir the checkout, after the install
 * @throws {ToolError}
 */
export async function refuseViewEscapes(dir) {
    const model = resolveSiteModel({ cwd: dir })
    if (!model.roots.every((root) => isInside(dir, root))) {
        throw new ToolError('The theme in config/app.yaml resolves to a folder outside the repository. The hosted validate reads only the themes the site installs itself; add the theme to the dependencies in package.json.')
    }
    const visited = new Set()
    for (const page of await markdownFiles(path.resolve(dir, model.folders.pages))) {
        const fence = (await fs.readFile(page, 'utf8')).match(FRONTMATTER)
        if (!fence) continue
        let meta
        try {
            meta = yaml.parse(fence[1])
        } catch {
            continue // the validator reports it and skips the page
        }
        if (!meta || typeof meta !== 'object' || !meta.layout) continue
        const layout = String(meta.layout)
        if (!model.roots.every((root) => isInside(dir, path.join(root, layout)))) {
            throw viewEscape(`The layout of ${path.relative(dir, page)}`, layout)
        }
        const entry = resolveEntry(layout, model.roots)
        if (fssync.existsSync(entry)) await refuseIncludeEscapes(entry, model.roots, dir, visited)
    }
}

/**
 * Creates the checkouts of one server process. The hosted server is built per
 * request, so the instance that keeps "one checkout per user" must outlive it:
 * `createHostedServer` uses `sharedCheckouts` unless a test passes its own.
 *
 * @param {object} [options]
 * @param {ReturnType<typeof createRunner>} [options.runner] runs `tar` (injected so tests stay offline)
 * @param {typeof fetch} [options.fetch] downloads the theme package from the npm registry (injected so tests stay offline)
 * @param {string} [options.tmpdir] where checkouts are made
 * @param {number} [options.maxTarballBytes] the cap on the site's download (`downloadTarball`'s default when absent)
 * @param {number} [options.maxThemeBytes] the cap on the theme package's download
 * @param {number} [options.maxUnpackedBytes] the cap on each unpacked archive
 */
export function createCheckouts({
    runner = createRunner(),
    fetch = globalThis.fetch,
    tmpdir = os.tmpdir(),
    maxTarballBytes,
    maxThemeBytes = MAX_THEME_BYTES,
    maxUnpackedBytes = MAX_UNPACKED_BYTES,
} = {}) {
    /** The users with a checkout in progress. */
    const busy = new Set()

    /** Unpacks the gzipped `tarball` into `target`, without its top folder (GitHub's `owner-name-sha/`, npm's `package/`). */
    async function unpack(tarball, dir, target, what, signal) {
        let tar
        try {
            tar = await gunzip(tarball, { maxOutputLength: maxUnpackedBytes })
        } catch (error) {
            if (error.code === 'ERR_BUFFER_TOO_LARGE') {
                throw new ToolError(`${what} unpacks to more than the ${maxUnpackedBytes} bytes a checkout may have, so the hosted validate cannot check it.`)
            }
            throw new ToolError(`${what} came as no readable archive (${error.message}). Try validate again.`)
        }
        const archive = path.join(dir, 'archive.tar')
        await fs.writeFile(archive, tar)
        const result = await runner('tar', ['-xf', archive, '-C', target, '--strip-components=1'], { cwd: dir, signal, env: checkoutEnv() })
        if (result.code !== 0) throw new ToolError(`Unpacking ${what} failed: ${failureText(result)}`)
        await fs.rm(archive)
    }

    /**
     * GETs `url` from the npm registry, never following a redirect to another
     * host, and returns at most `maxBytes` of its body; null for a 404.
     */
    async function fromRegistry(url, { maxBytes, accept, what, signal }) {
        let response
        try {
            response = await fetch(url, { headers: { accept }, redirect: 'error', signal })
        } catch (error) {
            throw new ToolError(`Downloading ${what} from the npm registry failed (${error.message}). Try validate again.`)
        }
        if (response.status === 404) return null
        if (!response.ok) throw new ToolError(`The npm registry answered ${response.status} for ${what}. Try validate again.`)
        return readLimited(response, maxBytes, () => new ToolError(`${what} is larger than the ${maxBytes} bytes a checkout may download, so the hosted validate cannot check this site.`))
    }

    /**
     * Downloads the theme package `name` from the registry into the
     * checkout's `node_modules/<name>`: the version `themeRequest` names, no
     * dependency of it, nothing from another host.
     */
    async function addTheme(dir, siteDir, name, signal) {
        const request = await themeRequest(siteDir, name)
        if (!request) return
        const what = `The theme package ${name}`
        const metadata = await fromRegistry(`${NPM_REGISTRY}${name.replace('/', '%2f')}`, {
            maxBytes: MAX_PACKUMENT_BYTES, accept: 'application/vnd.npm.install-v1+json', what: `the registry entry of ${name}`, signal,
        })
        if (!metadata) throw new ToolError(`${what} is not on the npm registry. Publish it, or keep the theme in the repository (theme: ./themes/<name> in config/app.yaml).`)
        let packument
        try {
            packument = JSON.parse(metadata.toString('utf8'))
        } catch {
            throw new ToolError(`The npm registry sent no readable entry for ${name}. Try validate again.`)
        }
        const version = pickVersion(packument, request)
        const wanted = 'version' in request ? request.version : request.spec
        if (!version) throw new ToolError(`${what} has no version "${wanted}" on the npm registry. Install an existing version (npm install ${name}) and commit package.json and the lockfile.`)
        const tarballUrl = packument.versions[version]?.dist?.tarball
        if (typeof tarballUrl !== 'string' || !tarballUrl.startsWith(NPM_REGISTRY)) {
            throw new ToolError(`The npm registry names no download of ${name}@${version} on ${NPM_REGISTRY}, so the hosted validate cannot fetch it.`)
        }
        const tarball = await fromRegistry(tarballUrl, { maxBytes: maxThemeBytes, accept: 'application/octet-stream', what: `${what} (${version})`, signal })
        if (!tarball) throw new ToolError(`The npm registry has no download of ${name}@${version}. Try validate again.`)
        const target = path.join(siteDir, 'node_modules', ...name.split('/'))
        await fs.rm(target, { recursive: true, force: true })
        await fs.mkdir(target, { recursive: true })
        await unpack(tarball, dir, target, `${what} (${version})`, signal)
    }

    return {
        /**
         * Checks out `ref` of `site` into a temporary folder, calls `use` with
         * it and deletes the folder afterwards, also when anything failed.
         *
         * @template T
         * @param {string} userId the signed-in user; one checkout each at a time
         * @param {object} source
         * @param {ReturnType<typeof import('./repo.js').createRepoClient>} source.client the user's repository client
         * @param {string} source.site `owner/name`
         * @param {string} source.ref the commit to check out
         * @param {AbortSignal} [source.signal] stops the downloads and `tar` when the client cancels
         * @param {(dir: string) => T|Promise<T>} use gets the checkout's folder
         * @returns {Promise<T>}
         */
        async withCheckout(userId, { client, site, ref, signal }, use) {
            if (busy.has(userId)) {
                throw new ToolError('Another validate of yours is still running. Wait for its result, then call validate again.')
            }
            busy.add(userId)
            let dir = null
            try {
                // undefined keeps downloadTarball's own default cap
                const tarball = await client.downloadTarball(site, ref, { maxBytes: maxTarballBytes })
                dir = await fs.mkdtemp(path.join(tmpdir, 'nera-mcp-checkout-'))
                const siteDir = path.join(dir, 'site')
                await fs.mkdir(siteDir)
                await unpack(tarball, dir, siteDir, `The repository ${site}`, signal)
                await removeLinks(siteDir)
                const theme = await refuseEscapes(siteDir)
                if (theme) {
                    await addTheme(dir, siteDir, theme, signal)
                    await removeLinks(siteDir)
                }
                await refuseViewEscapes(siteDir)
                return await use(siteDir)
            } finally {
                if (dir) await fs.rm(dir, { recursive: true, force: true })
                busy.delete(userId)
            }
        },
    }
}

/** The checkouts of this server process. */
export const sharedCheckouts = createCheckouts()
