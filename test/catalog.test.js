import { BUNDLED_STARTERS } from '@nera-static/nera'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { connect, makeRoot, textOf } from './helpers.js'

const REGISTRY_SEARCH = 'https://registry.npmjs.org/-/v1/search'

let env
let mcp
let requests
let answer

/** A registry search hit, shaped like `objects[].package` of /-/v1/search. */
const hit = (name, description = `${name} description`) => ({
    package: {
        name,
        version: '1.0.0',
        description,
        links: { npm: `https://www.npmjs.com/package/${name}` },
    },
    score: { final: 1 },
})

/** What `keywords:<keyword>` returns. */
const REGISTRY = {
    nera: [
        hit('@nera-static/nera'),
        hit('@nera-static/plugin-utils'),
        hit('@nera-static/plugin-tags', 'Tag clouds and tag pages'),
        hit('@nera-static/plugin-sitemap', 'sitemap.xml and robots.txt'),
        hit('@nera-static/starter-blog', 'A ready-to-edit blog'),
        hit('@nera-static/starter-blank'),
        hit('@nera-static/theme-blog'),
        hit('nera-cli'),
    ],
    'nera-plugin': [
        hit('@nera-static/plugin-sitemap', 'sitemap.xml and robots.txt'),
        hit('@nera-static/plugin-utils'),
        hit('@nera-static/plugin-new', 'An official plugin without the `nera` keyword'),
        hit('nera-plugin-emoji', 'Emoji shortcodes'),
    ],
    'nera-starter': [
        hit('@nera-static/starter-blog', 'A ready-to-edit blog'),
        hit('@acme/nera-starter-shop', 'A shop'),
        hit('nera-starter-docs', 'Documentation site'),
        hit('cool-site', 'Not readable as a starter name'),
    ],
    'nera-theme': [
        hit('@nera-static/theme-blog'),
        hit('@acme/theme-dark'),
        hit('nera-theme-unscoped'),
    ],
}

async function fakeFetch(url) {
    requests.push(url)
    return answer(url)
}

function registryAnswer(url) {
    const text = new URL(url).searchParams.get('text')
    const keyword = text.replace(/^keywords:/, '')
    return { ok: true, status: 200, json: async () => ({ objects: REGISTRY[keyword] ?? [], total: 0 }) }
}

beforeEach(async () => {
    env = await makeRoot()
    requests = []
    answer = registryAnswer
    mcp = await connect(env.root, { fetch: fakeFetch })
})

afterEach(async () => {
    await mcp.close()
    await env.cleanup()
})

describe('list_plugins', () => {
    it('lists official plugins by bare name first (also those only the kind keyword finds), then third-party ones, without plugin-utils', async () => {
        const result = await mcp.call('list_plugins')
        expect(result.isError).toBeUndefined()
        expect(result.structuredContent.plugins).toEqual([
            expect.objectContaining({ name: 'new', package: '@nera-static/plugin-new', official: true }),
            {
                name: 'sitemap',
                package: '@nera-static/plugin-sitemap',
                version: '1.0.0',
                description: 'sitemap.xml and robots.txt',
                official: true,
                npm: 'https://www.npmjs.com/package/@nera-static/plugin-sitemap',
            },
            expect.objectContaining({ name: 'tags', package: '@nera-static/plugin-tags', official: true }),
            expect.objectContaining({ name: 'nera-plugin-emoji', package: 'nera-plugin-emoji', official: false }),
        ])
        expect(textOf(result)).toMatch(/add_plugin/)
    })

    it('asks the registry by keyword only (no network beyond the injected fetch)', async () => {
        await mcp.call('list_plugins')
        expect(requests.sort()).toEqual([
            `${REGISTRY_SEARCH}?text=keywords%3Anera&size=250`,
            `${REGISTRY_SEARCH}?text=keywords%3Anera-plugin&size=250`,
        ])
    })

    it('filters by query against name and description', async () => {
        const result = await mcp.call('list_plugins', { query: 'ROBOTS' })
        expect(result.structuredContent.plugins.map((p) => p.name)).toEqual(['sitemap'])
        const none = await mcp.call('list_plugins', { query: 'nothing-like-this' })
        expect(none.structuredContent.plugins).toEqual([])
        expect(textOf(none)).toMatch(/No plugins found for "nothing-like-this"/)
    })
})

describe('list_starters', () => {
    it('keeps only third-party starters create_site reads back as the same package', async () => {
        const result = await mcp.call('list_starters')
        expect(result.structuredContent.starters.map((s) => s.name)).toEqual([
            'blank', 'blog', '@acme/nera-starter-shop', 'nera-starter-docs',
        ])
        expect(textOf(result)).toMatch(/create_site/)
    })
})

describe('list_themes', () => {
    it('lists official themes and scoped third-party themes only', async () => {
        const result = await mcp.call('list_themes')
        expect(result.structuredContent.themes.map((t) => [t.name, t.official])).toEqual([
            ['blog', true],
            ['@acme/theme-dark', false],
        ])
    })
})

describe('registry failures', () => {
    it('lists the official starters bundled with the CLI when the registry cannot be reached', async () => {
        answer = async () => { throw new Error('getaddrinfo ENOTFOUND registry.npmjs.org') }
        const result = await mcp.call('list_starters')
        expect(result.isError).toBeUndefined()
        expect(BUNDLED_STARTERS.length).toBeGreaterThan(0)
        expect(result.structuredContent.starters).toEqual(BUNDLED_STARTERS.map(({ name, package: pkg }) => expect.objectContaining({
            name,
            package: pkg,
            version: null,
            official: true,
        })))
        expect(textOf(result)).toMatch(/create_site/)
    })

    it('reports an unreachable registry as an isError result for themes and plugins', async () => {
        answer = async () => { throw new Error('getaddrinfo ENOTFOUND registry.npmjs.org') }
        for (const name of ['list_themes', 'list_plugins']) {
            const result = await mcp.call(name)
            expect(result.isError).toBe(true)
            expect(textOf(result)).toMatch(/npm registry could not be reached \(getaddrinfo ENOTFOUND/)
        }
    })

    it('reports an HTTP error as an isError result', async () => {
        answer = async () => ({ ok: false, status: 503, json: async () => ({}) })
        const result = await mcp.call('list_themes')
        expect(result.isError).toBe(true)
        expect(textOf(result)).toMatch(/HTTP 503/)
    })

    it('reports an unexpected answer as an isError result', async () => {
        answer = async () => ({ ok: true, status: 200, json: async () => ({ results: [] }) })
        const result = await mcp.call('list_plugins')
        expect(result.isError).toBe(true)
        expect(textOf(result)).toMatch(/unexpected search result/)
    })
})
