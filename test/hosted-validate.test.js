import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { validate } from '@nera-static/nera'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NPM_REGISTRY, checkoutEnv, createCheckouts } from '../src/hosted/checkout.js'
import { createRunner } from '../src/runner.js'
import { connectHosted, fakeGitHub } from './fake-github.js'
import { SITE_PACKAGE, textOf, writeFiles } from './helpers.js'

const SITE = 'octo/site'
const SECRET = 'SERVER-SECRET-4711'
const THEME = '@nera-static/theme-blog'

/** A Nera site with one valid page and one whose layout is missing. */
const SITE_FILES = {
    'package.json': SITE_PACKAGE,
    'config/app.yaml': 'name: My site\nlang: en\n',
    'pages/index.md': '---\nlayout: pages/default.pug\ntitle: Home\n---\n# Welcome\n',
    'pages/broken.md': '---\nlayout: pages/missing.pug\ntitle: Broken\n---\nHello\n',
    'theme/views/pages/default.pug': 'p= meta.title\n',
}

/** The theme package's files: what `pages/default.pug` of SITE_FILES needs. */
const THEME_FILES = {
    'package.json': JSON.stringify({ name: THEME, version: '1.0.0' }),
    'views/pages/default.pug': 'p= meta.title\n',
}

let tmp
let checkoutsDir
let outside
let github
let registry
let session
let calls

beforeEach(async () => {
    tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nera-mcp-validate-')))
    checkoutsDir = path.join(tmp, 'checkouts')
    outside = path.join(tmp, 'outside')
    await fs.mkdir(checkoutsDir)
    // a file of "the server" that no validate result may show
    await writeFiles(outside, {
        'secret.yaml': `key: [${SECRET}\n`,
        'secret.md': `---\nlayout: [${SECRET}\n---\n`,
        'theme/views/pages/default.pug': 'p= meta.title\n',
    })
    calls = []
    github = fakeGitHub()
    github.addRepo(SITE, SITE_FILES)
    registry = fakeRegistry()
    await useTarball(SITE_FILES)
    session = await connectHosted(github, { checkouts: checkouts() })
})

afterEach(async () => {
    vi.unstubAllEnvs()
    await session.close()
    await fs.rm(tmp, { recursive: true, force: true })
})

/** Checkouts in `checkoutsDir` whose runner records every call and runs the real tar, and whose fetch is the fake registry. */
function checkouts(options = {}) {
    const real = createRunner()
    const runner = async (command, args, runOptions) => {
        calls.push({ command, args, cwd: runOptions.cwd, env: runOptions.env })
        if (command === 'tar') return real(command, args, runOptions)
        throw new Error(`${command} is not expected`)
    }
    return createCheckouts({ runner, fetch: registry.fetch, tmpdir: checkoutsDir, ...options })
}

/**
 * Packs `files` (plus symbolic links, path → target) into a gzipped tarball
 * with one top folder: `owner-name-sha/` as GitHub packs a repository,
 * `package/` as npm packs a package. Returns the folder it was packed from.
 */
async function pack(files, links = {}, topName = 'octo-site-abc1234') {
    const parent = await fs.mkdtemp(path.join(tmp, 'pack-'))
    const top = path.join(parent, topName)
    await writeFiles(top, files)
    for (const [link, target] of Object.entries(links)) {
        await fs.mkdir(path.dirname(path.join(top, link)), { recursive: true })
        await fs.symlink(target, path.join(top, link))
    }
    const archive = path.join(parent, 'archive.tgz')
    execFileSync('tar', ['-czf', archive, '-C', parent, topName])
    return { top, tarball: await fs.readFile(archive) }
}

/** Packs `files` and makes it the tarball the fake GitHub serves. */
async function useTarball(files, links) {
    const packed = await pack(files, links)
    github.repos.get(SITE).tarball = packed.tarball
    return packed.top
}

/**
 * A fake npm registry: `publish` adds a version of a package (its abbreviated
 * metadata and its tarball), `fetch` serves them and answers 404 otherwise,
 * `requests` records every call.
 */
function fakeRegistry() {
    const packuments = new Map()
    const tarballs = new Map()
    const requests = []
    return {
        requests,
        packuments,
        async publish(name, version, files = THEME_FILES, links = {}) {
            const tarballUrl = `${NPM_REGISTRY}${name}/-/${name.split('/').pop()}-${version}.tgz`
            tarballs.set(tarballUrl, (await pack(files, links, 'package')).tarball)
            const packument = packuments.get(name) ?? { name, 'dist-tags': {}, versions: {} }
            packument.versions[version] = { name, version, dist: { tarball: tarballUrl } }
            if (!version.includes('-')) packument['dist-tags'].latest = version
            packuments.set(name, packument)
            return tarballUrl
        },
        async fetch(url, options) {
            requests.push({ url, options })
            const name = decodeURIComponent(url.slice(NPM_REGISTRY.length))
            if (url.startsWith(NPM_REGISTRY) && packuments.has(name)) return Response.json(packuments.get(name))
            if (tarballs.has(url)) return new Response(tarballs.get(url))
            return new Response('not found', { status: 404 })
        },
    }
}

/** A site that uses THEME: no views of its own, `theme: blog`, and `package` as its package.json. */
function themedSite(pkg = { name: 'my-site', dependencies: { [THEME]: '^1.0.0' } }, extra = {}) {
    const files = { ...SITE_FILES, 'config/app.yaml': 'name: My site\ntheme: blog\n', 'package.json': JSON.stringify(pkg), ...extra }
    delete files['theme/views/pages/default.pug']
    return files
}

/** A v3 lockfile that pins THEME to `version`, from `resolved`. */
function lockfile(version, resolved = `${NPM_REGISTRY}${THEME}/-/theme-blog-${version}.tgz`) {
    return JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'my-site' }, [`node_modules/${THEME}`]: { version, resolved } } })
}

/** Expects an `isError` result whose text matches `pattern`. */
function expectError(result, pattern) {
    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(pattern)
}

/** Expects no checkout to be left behind. */
async function expectNoCheckout() {
    expect(await fs.readdir(checkoutsDir)).toEqual([])
}

const requestedUrls = () => registry.requests.map((request) => request.url)

describe('validate', () => {
    it('returns the records of a local validate of the same site unchanged, with counts', async () => {
        const top = await useTarball(SITE_FILES)
        const local = validate({ cwd: top })
        expect(local.some((record) => record.severity === 'error')).toBe(true)

        const result = await session.call('validate', { site: SITE })
        expect(result.isError).toBeFalsy()
        expect(result.structuredContent).toEqual({
            site: SITE,
            branch: 'main',
            ok: false,
            counts: { errors: local.filter((r) => r.severity === 'error').length, warnings: local.filter((r) => r.severity !== 'error').length },
            results: local,
        })
        expect(textOf(result)).toMatch(/"octo\/site" \(main\) has 1 error\(s\)/)
        // a site without a theme package downloads nothing from the registry
        expect(registry.requests).toEqual([])
        await expectNoCheckout()
    })

    it('checks the draft when there is one', async () => {
        const repo = github.repos.get(SITE)
        repo.refs.set('nera-draft', repo.refs.get('main'))
        const draft = github.pushFile(SITE, 'nera-draft', 'pages/new.md', '---\nlayout: pages/default.pug\n---\n')
        const result = await session.call('validate', { site: SITE })
        expect(result.structuredContent.branch).toBe('nera-draft')
        expect(github.requests.some((request) => request.path === `/repos/${SITE}/tarball/${draft}`)).toBe(true)
    })

    it('says a valid draft is ready to publish', async () => {
        const valid = { ...SITE_FILES }
        delete valid['pages/broken.md']
        await useTarball(valid)
        const repo = github.repos.get(SITE)
        repo.refs.set('nera-draft', repo.refs.get('main'))
        const result = await session.call('validate', { site: SITE })
        expect(result.structuredContent).toMatchObject({ ok: true, counts: { errors: 0, warnings: 0 }, results: [] })
        expect(textOf(result)).toMatch(/is valid\. Call publish/)
    })

    it('downloads the theme version the lockfile pins and validates like a local validate with that theme installed', async () => {
        const pinned = await registry.publish(THEME, '1.0.0')
        await registry.publish(THEME, '1.2.0', { ...THEME_FILES, 'views/pages/default.pug': 'p version 1.2.0\n' })
        const files = themedSite(undefined, { 'package-lock.json': lockfile('1.0.0') })
        const top = await useTarball(files)
        await writeFiles(path.join(top, 'node_modules', THEME), THEME_FILES)
        const local = validate({ cwd: top })
        // pages/index.md finds its layout in the theme; only pages/broken.md is reported
        expect(local.map((record) => record.file)).toEqual(['pages/broken.md'])

        const result = await session.call('validate', { site: SITE })
        expect(result.structuredContent.results).toEqual(local)
        expect(requestedUrls()).toEqual([`${NPM_REGISTRY}@nera-static%2ftheme-blog`, pinned])
        await expectNoCheckout()
    })

    it('without a lockfile, downloads the highest version in package.json\'s range, or the version of its tag', async () => {
        await registry.publish(THEME, '1.0.0')
        const highest = await registry.publish(THEME, '1.4.0')
        const next = await registry.publish(THEME, '2.0.0-beta.1')
        await registry.publish(THEME, '2.1.0')
        registry.packuments.get(THEME)['dist-tags'].next = '2.0.0-beta.1'

        await useTarball(themedSite())
        expect((await session.call('validate', { site: SITE })).structuredContent.results).not.toContainEqual(expect.objectContaining({ file: 'pages/index.md' }))
        expect(requestedUrls().at(-1)).toBe(highest)

        await useTarball(themedSite({ name: 'my-site', devDependencies: { [THEME]: 'next' } }))
        expect((await session.call('validate', { site: SITE })).isError).toBeFalsy()
        expect(requestedUrls().at(-1)).toBe(next)
    })

    it('downloads nothing for a theme the site does not depend on, and the validator says it is missing', async () => {
        await registry.publish(THEME, '1.0.0')
        await useTarball(themedSite({ name: 'my-site' }))
        const result = await session.call('validate', { site: SITE })
        expect(result.structuredContent.results).toContainEqual(expect.objectContaining({ rule: 'theme-unresolved' }))
        expect(registry.requests).toEqual([])
        await expectNoCheckout()
    })

    it('refuses a theme the site names outside the npm registry, before downloading anything', async () => {
        await registry.publish(THEME, '1.0.0')
        for (const [files, pattern] of [
            [themedSite(undefined, { 'package-lock.json': lockfile('1.0.0', 'git+ssh://git@github.com/acme/theme.git#abc') }), /The theme @nera-static\/theme-blog in package-lock\.json comes from "git\+ssh:.*", not from the npm registry/],
            [themedSite(undefined, { 'package-lock.json': lockfile('1.0.0', 'https://registry.npmjs.org.evil.example/theme.tgz') }), /comes from "https:\/\/registry\.npmjs\.org\.evil\.example/],
            [themedSite(undefined, { 'npm-shrinkwrap.json': lockfile('1.0.0', 'file:../outside/theme.tgz') }), /in npm-shrinkwrap\.json comes from "file:/],
            [themedSite(undefined, { 'package-lock.json': lockfile('git+ssh://git@github.com/acme/theme.git') }), /has the version "git\+ssh:.*", which is none/],
            [themedSite(undefined, { 'package-lock.json': '{ not json' }), /package-lock\.json is not valid JSON/],
            ...['git+ssh://git@github.com/acme/theme.git', 'github:acme/theme', 'https://evil.example/theme.tgz', 'file:../outside', 'npm:other@^1.0.0'].map((spec) => [
                themedSite({ name: 'my-site', dependencies: { [THEME]: spec } }),
                /The theme @nera-static\/theme-blog in package\.json \(dependencies\) is ".*", which is not a version range or tag of the npm registry/,
            ]),
        ]) {
            await useTarball(files)
            expectError(await session.call('validate', { site: SITE }), pattern)
        }
        expect(registry.requests).toEqual([])
        await expectNoCheckout()
    })

    it('fetches only the theme\'s entry and tarball, from the registry alone, never following a redirect', async () => {
        await registry.publish(THEME, '1.0.0')
        registry.packuments.get(THEME).versions['1.0.0'].dist.tarball = 'http://169.254.169.254/latest/meta-data/'
        await useTarball(themedSite())
        expectError(await session.call('validate', { site: SITE }), /names no download of @nera-static\/theme-blog@1\.0\.0 on https:\/\/registry\.npmjs\.org\//)
        expect(requestedUrls()).toEqual([`${NPM_REGISTRY}@nera-static%2ftheme-blog`])
        for (const request of registry.requests) expect(request.options.redirect).toBe('error')
        await expectNoCheckout()
    })

    it('reports a theme package or version the registry does not have', async () => {
        await useTarball(themedSite())
        expectError(await session.call('validate', { site: SITE }), /The theme package @nera-static\/theme-blog is not on the npm registry/)
        await registry.publish(THEME, '1.0.0')
        await useTarball(themedSite(undefined, { 'package-lock.json': lockfile('1.9.9') }))
        expectError(await session.call('validate', { site: SITE }), /has no version "1\.9\.9" on the npm registry/)
        await useTarball(themedSite({ name: 'my-site', dependencies: { [THEME]: '^3.0.0' } }))
        expectError(await session.call('validate', { site: SITE }), /has no version "\^3\.0\.0"/)
        await expectNoCheckout()
    })

    it('runs no npm and gives tar nothing of this process\'s env but PATH', async () => {
        vi.stubEnv('NERA_MCP_TOKEN_KEY', 'never-pass-this')
        await registry.publish(THEME, '1.0.0')
        await useTarball(themedSite())
        expect((await session.call('validate', { site: SITE })).isError).toBeFalsy()
        expect(calls.map((call) => call.command)).toEqual(['tar', 'tar'])
        for (const call of calls) {
            expect(call.env).toEqual(checkoutEnv())
            expect(Object.keys(call.env).sort()).toEqual(['NO_COLOR', 'PATH'])
            expect(call.cwd.startsWith(checkoutsDir)).toBe(true)
        }
        await expectNoCheckout()
    })

    it('deletes every symbolic link of the repository before the validator reads the checkout', async () => {
        const files = { ...SITE_FILES }
        delete files['config/app.yaml']
        await useTarball(files, {
            'config/app.yaml': path.join(outside, 'secret.yaml'),
            'pages/leak.md': path.join(outside, 'secret.md'),
            'theme/views/pages/leak.pug': '../../../../outside/secret.yaml',
        })
        const result = await session.call('validate', { site: SITE })
        expect(result.isError).toBeFalsy()
        expect(JSON.stringify(result)).not.toContain(SECRET)
        expect(result.structuredContent.results.map((r) => r.file)).not.toContain('pages/leak.md')
        await expectNoCheckout()
    })

    it('deletes the symbolic links of the theme package before validating', async () => {
        await registry.publish(THEME, '1.0.0', { 'package.json': THEME_FILES['package.json'] }, { views: path.join(outside, 'theme/views') })
        await useTarball(themedSite())
        const result = await session.call('validate', { site: SITE })
        expect(result.structuredContent.results).toContainEqual(expect.objectContaining({ rule: 'theme-unresolved' }))
        await expectNoCheckout()
    })

    it('refuses folders and themes in config/app.yaml that point outside the repository', async () => {
        for (const config of [
            'folders:\n  pages: ../../outside\n',
            `folders:\n  views: ${outside}\n`,
            'theme: ../outside/theme\n',
            `theme: ${outside}/theme\n`,
            'theme: "@acme/../../../outside"\n',
        ]) {
            await useTarball({ ...SITE_FILES, 'config/app.yaml': config })
            expectError(await session.call('validate', { site: SITE }), /points outside the repository|is neither a theme package .* nor a folder inside the repository/)
        }
        expect(registry.requests).toEqual([])
        await expectNoCheckout()
    })

    it('refuses a layout that leaves the repository, whether its target exists or not', async () => {
        const results = []
        // five levels up from theme/views is the test's folder, where outside/ is
        for (const layout of ['../../../../../outside/theme/views/pages/default.pug', '../../../../../outside/nothing.pug', `../../../../../../../..${outside}/secret.yaml`]) {
            await useTarball({ ...SITE_FILES, 'pages/leak.md': `---\nlayout: ${layout}\n---\n` })
            const result = await session.call('validate', { site: SITE })
            expectError(result, /The layout of pages\/leak\.md \(".*"\) points outside the repository/)
            results.push(textOf(result).replace(layout, '<layout>'))
        }
        // the same text for an existing and a missing target: no existence oracle
        expect(results[0]).toBe(results[1])
        expect(results.join()).not.toContain(SECRET)
        await expectNoCheckout()
    })

    it('refuses a Pug include or extends that leaves the repository, in the site\'s views and in the theme package', async () => {
        await writeFiles(outside, { 'server.pug': `include ${SECRET}\n` })
        for (const [files, pattern] of [
            // six levels up from theme/views/pages is the test's folder
            [{ 'theme/views/pages/default.pug': 'include ../../../../../../outside/server.pug\n' }, /line 1 of theme\/views\/pages\/default\.pug \("(?:\.\.\/){6}outside\/server\.pug"\) points outside/],
            [{ 'theme/views/pages/default.pug': 'extends ../layout\n', 'theme/views/layout.pug': 'p x\n  include:markdown-it /../../../../outside/server\n' }, /line 2 of theme\/views\/layout\.pug .* points outside/],
        ]) {
            await useTarball({ ...SITE_FILES, ...files })
            const result = await session.call('validate', { site: SITE })
            expectError(result, pattern)
            expect(JSON.stringify(result)).not.toContain(SECRET)
        }

        // an absolute target starts at the site's views, as in Pug: no escape
        await useTarball({ ...SITE_FILES, 'theme/views/pages/default.pug': `include ${outside}/server.pug\n` })
        const absolute = await session.call('validate', { site: SITE })
        expect(absolute.structuredContent.results).toContainEqual(expect.objectContaining({ rule: 'include-unresolved', file: 'theme/views/pages/default.pug' }))
        expect(JSON.stringify(absolute)).not.toContain(SECRET)

        // the downloaded theme package, whose template reaches out
        // (nine levels up from node_modules/@nera-static/theme-blog/views/pages)
        await registry.publish(THEME, '1.0.0', { ...THEME_FILES, 'views/pages/default.pug': 'include ../../../../../../../../../outside/server.pug\n' })
        await useTarball(themedSite())
        const themed = await session.call('validate', { site: SITE })
        expectError(themed, /line 1 of node_modules\/@nera-static\/theme-blog\/views\/pages\/default\.pug .* points outside/)
        expect(JSON.stringify(themed)).not.toContain(SECRET)
        await expectNoCheckout()
    })

    it('refuses a theme found in a node_modules folder above the checkout', async () => {
        await writeFiles(path.join(tmp, 'node_modules/@acme/theme'), {
            'package.json': JSON.stringify({ name: '@acme/theme' }),
            'views/pages/default.pug': 'p= meta.title\n',
        })
        await useTarball({ ...SITE_FILES, 'config/app.yaml': 'name: My site\ntheme: "@acme/theme"\n' })
        expectError(await session.call('validate', { site: SITE }), /The theme in config\/app\.yaml resolves to a folder outside the repository/)
        expect(registry.requests).toEqual([])
        await expectNoCheckout()
    })

    it('leaves no checkout behind when the registry cannot be reached, and prints nothing to stdout', async () => {
        const stdoutWrite = vi.spyOn(process.stdout, 'write')
        await session.close()
        session = await connectHosted(github, { checkouts: checkouts({ fetch: async () => { throw new Error('getaddrinfo ENOTFOUND registry.npmjs.org') } }) })
        await useTarball(themedSite())
        expectError(await session.call('validate', { site: SITE }), /Downloading the registry entry of @nera-static\/theme-blog from the npm registry failed \(getaddrinfo ENOTFOUND/)
        expect(stdoutWrite).not.toHaveBeenCalled()
        await expectNoCheckout()
    })

    it('leaves no checkout behind when the archive is not one', async () => {
        github.repos.get(SITE).tarball = Buffer.from('not gzip at all')
        expectError(await session.call('validate', { site: SITE }), /The repository octo\/site came as no readable archive/)
        expect(calls).toEqual([])
        await expectNoCheckout()
    })

    it('refuses an archive over the caps, packed or unpacked, the repository\'s and the theme\'s', async () => {
        await session.close()
        session = await connectHosted(github, { checkouts: checkouts({ maxUnpackedBytes: 1024 }) })
        expectError(await session.call('validate', { site: SITE }), /The repository octo\/site unpacks to more than the 1024 bytes/)

        await session.close()
        session = await connectHosted(github, { checkouts: checkouts({ maxTarballBytes: 10 }) })
        expectError(await session.call('validate', { site: SITE }), /larger than the 10 bytes a checkout may have/)
        expect(calls).toEqual([])

        await registry.publish(THEME, '1.0.0')
        await useTarball(themedSite())
        await session.close()
        session = await connectHosted(github, { checkouts: checkouts({ maxThemeBytes: 10 }) })
        expectError(await session.call('validate', { site: SITE }), /The theme package @nera-static\/theme-blog \(1\.0\.0\) is larger than the 10 bytes a checkout may download/)
        await expectNoCheckout()
    })

    it('runs one checkout per user at a time', async () => {
        await registry.publish(THEME, '1.0.0')
        await useTarball(themedSite())
        let release
        let started
        const fetchStarted = new Promise((resolve) => { started = resolve })
        const gate = new Promise((resolve) => { release = resolve })
        const slowRegistry = async (url, options) => {
            started()
            await gate
            return registry.fetch(url, options)
        }
        await session.close()
        session = await connectHosted(github, { checkouts: checkouts({ fetch: slowRegistry }) })
        const first = session.call('validate', { site: SITE })
        await fetchStarted
        expectError(await session.call('validate', { site: SITE }), /Another validate of yours is still running/)
        release()
        expect((await first).isError).toBeFalsy()
        await expectNoCheckout()
    })

    it('refuses a repository that is not a reachable Nera site, before downloading anything', async () => {
        expectError(await session.call('validate', { site: 'octo/other' }), /not one the Nera Static GitHub App can reach/)
        expect(github.requests.some((request) => request.path.includes('/tarball/'))).toBe(false)
    })

    it('is read-only', async () => {
        const { tools } = await session.client.listTools()
        expect(tools.find((tool) => tool.name === 'validate').annotations.readOnlyHint).toBe(true)
    })
})
