import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fetchDocs } from '../scripts/fetch-docs.js'
import { DOCS_URL } from '../src/resources.js'
import { connect, makeRoot, SITE_PACKAGE, writeFiles } from './helpers.js'

let env
let mcp

const AGENTS = '# AGENTS.md\n\nThis is a Nera site.\n'

async function open(options = {}) {
    mcp = await connect(env.root, { docsFile: path.join(env.tmp, 'docs', 'llms-full.txt'), ...options })
}

beforeEach(async () => {
    env = await makeRoot()
    await writeFiles(env.site, { 'AGENTS.md': AGENTS })
})

afterEach(async () => {
    await mcp?.close()
    mcp = undefined
    await env.cleanup()
})

const read = (uri) => mcp.client.readResource({ uri })

describe('nera://docs/llms-full.txt', () => {
    it('serves the bundled docs', async () => {
        await writeFiles(env.tmp, { 'docs/llms-full.txt': '# Nera\n\nAll the docs.\n' })
        await open()
        const { contents } = await read('nera://docs/llms-full.txt')
        expect(contents).toEqual([{ uri: 'nera://docs/llms-full.txt', mimeType: 'text/markdown', text: '# Nera\n\nAll the docs.\n' }])
    })

    it('gives the online URL when the docs are not bundled (a checkout)', async () => {
        await open()
        const { contents } = await read('nera://docs/llms-full.txt')
        expect(contents[0].text).toContain(DOCS_URL)
        expect(contents[0].text).toMatch(/not bundled/)
    })
})

describe('nera://catalog/*', () => {
    it('serves each catalog as JSON from the injected fetch', async () => {
        const objects = [
            { package: { name: '@nera-static/starter-blog', version: '1.1.0', description: 'A blog' } },
            { package: { name: '@nera-static/theme-blog', version: '1.0.2', description: 'Blog theme' } },
            { package: { name: '@nera-static/plugin-feed', version: '1.0.0', description: 'Atom feed' } },
        ]
        await open({ fetch: async () => ({ ok: true, status: 200, json: async () => ({ objects }) }) })
        for (const [kind, name] of [['starters', 'blog'], ['themes', 'blog'], ['plugins', 'feed']]) {
            const { contents } = await read(`nera://catalog/${kind}`)
            expect(contents[0].mimeType).toBe('application/json')
            expect(JSON.parse(contents[0].text)[kind].map((item) => item.name)).toEqual([name])
        }
    })

    it('reports an unreachable registry as a resource error with our message', async () => {
        await open({ fetch: async () => { throw new Error('offline') } })
        await expect(read('nera://catalog/plugins')).rejects.toThrow(/npm registry could not be reached \(offline\)/)
    })
})

describe('nera://site/{site}/AGENTS.md', () => {
    it('lists the AGENTS.md of every site and reads one', async () => {
        await writeFiles(path.join(env.root, 'clients', 'shop'), { 'package.json': SITE_PACKAGE, 'AGENTS.md': '# Shop\n' })
        await open()
        const { resources } = await mcp.client.listResources()
        const agents = resources.filter((r) => r.uri.endsWith('/AGENTS.md')).map((r) => r.uri)
        expect(agents).toEqual(['nera://site/clients/shop/AGENTS.md', 'nera://site/site/AGENTS.md'])

        expect((await read('nera://site/site/AGENTS.md')).contents[0].text).toBe(AGENTS)
        expect((await read('nera://site/clients/shop/AGENTS.md')).contents[0].text).toBe('# Shop\n')
        expect((await read('nera://site/clients%2Fshop/AGENTS.md')).contents[0].text).toBe('# Shop\n')
    })

    it('lists the docs and the three catalogs as resources too', async () => {
        await open()
        const { resources } = await mcp.client.listResources()
        expect(resources.map((r) => r.uri)).toEqual(expect.arrayContaining([
            'nera://docs/llms-full.txt', 'nera://catalog/starters', 'nera://catalog/themes', 'nera://catalog/plugins',
        ]))
    })

    it('reads the root itself as nera://site/AGENTS.md (also spelled with a `.` segment)', async () => {
        await writeFiles(env.root, { 'package.json': SITE_PACKAGE, 'AGENTS.md': '# Root\n' })
        await open()
        const { resources } = await mcp.client.listResources()
        expect(resources.map((r) => r.uri)).toContain('nera://site/AGENTS.md')
        expect((await read('nera://site/AGENTS.md')).contents[0].text).toBe('# Root\n')
        expect((await read('nera://site/./AGENTS.md')).contents[0].text).toBe('# Root\n')
    })

    it('refuses the root when it is no site', async () => {
        await open()
        await expect(read('nera://site/AGENTS.md')).rejects.toThrow(/is not a Nera site/)
    })

    it('refuses an encoded `..` that leads out of the root', async () => {
        await writeFiles(env.outside, { 'package.json': SITE_PACKAGE, 'AGENTS.md': 'secret' })
        await open()
        await expect(read('nera://site/..%2Foutside/AGENTS.md')).rejects.toThrow(/contains "\.\."/)
    })

    it('refuses an absolute path outside the root', async () => {
        await writeFiles(env.outside, { 'package.json': SITE_PACKAGE, 'AGENTS.md': 'secret' })
        await open()
        await expect(read(`nera://site/${encodeURIComponent(env.outside)}/AGENTS.md`)).rejects.toThrow(/leads outside/)
    })

    it('refuses a site folder that is a symlink out of the root', async () => {
        await writeFiles(env.outside, { 'package.json': SITE_PACKAGE, 'AGENTS.md': 'secret' })
        await fs.symlink(env.outside, path.join(env.root, 'linked'))
        await open()
        await expect(read('nera://site/linked/AGENTS.md')).rejects.toThrow(/leads outside/)
    })

    it('refuses an AGENTS.md that is a symlink out of the site', async () => {
        await fs.rm(path.join(env.site, 'AGENTS.md'))
        await fs.symlink(path.join(env.outside, 'secret.txt'), path.join(env.site, 'AGENTS.md'))
        await open()
        await expect(read('nera://site/site/AGENTS.md')).rejects.toThrow(/leads outside/)
    })

    it('refuses badly percent-encoded sites', async () => {
        await open()
        await expect(read('nera://site/%E0%A4%A/AGENTS.md')).rejects.toThrow(/not validly percent-encoded/)
    })

    it('says how to get an AGENTS.md when the site has none', async () => {
        await fs.rm(path.join(env.site, 'AGENTS.md'))
        await open()
        await expect(read('nera://site/site/AGENTS.md')).rejects.toThrow(/has no AGENTS\.md.*nera update/)
    })
})

describe('prompts', () => {
    it('registers the four task prompts', async () => {
        await open()
        const { prompts } = await mcp.client.listPrompts()
        expect(prompts.map((p) => p.name).sort()).toEqual(['add_page', 'new_blog', 'new_business_website', 'put_site_online'])
        for (const prompt of prompts) expect(prompt.description.length).toBeGreaterThan(40)
    })

    it('names only tools that exist (preview and publish arrive with their step)', async () => {
        await open()
        const { tools } = await mcp.client.listTools()
        const known = new Set([...tools.map((t) => t.name), 'preview', 'publish'])
        const { prompts } = await mcp.client.listPrompts()
        for (const { name } of prompts) {
            const { messages } = await mcp.client.getPrompt({ name, arguments: {} })
            const text = messages[0].content.text
            const named = [...text.matchAll(/\b([a-z]+_[a-z_]+|validate|build|preview|publish)\b/g)].map((m) => m[1])
                .filter((word) => /^(list|create|get|read|write|delete|add)_/.test(word) || ['validate', 'build', 'preview', 'publish'].includes(word))
                .filter((word) => !['add_page', 'put_site_online'].includes(word))
            expect(named.length, name).toBeGreaterThan(2)
            for (const word of named) expect(known, `${name} names ${word}`).toContain(word)
        }
    })

    it('puts the arguments into the task', async () => {
        await open()
        const { messages } = await mcp.client.getPrompt({
            name: 'new_business_website',
            arguments: { business: 'a bakery in Hamburg', folder: 'my-bakery' },
        })
        expect(messages[0].role).toBe('user')
        expect(messages[0].content.text).toContain('The business: a bakery in Hamburg')
        expect(messages[0].content.text).toContain('`my-bakery`')
        const page = await mcp.client.getPrompt({ name: 'add_page', arguments: { site: 'site' } })
        expect(page.messages[0].content.text).toContain('get_site with site `site`')
    })
})

describe('scripts/fetch-docs.js', () => {
    const docs = 'x'.repeat(20000)

    it('writes the downloaded docs', async () => {
        const file = path.join(env.tmp, 'docs', 'llms-full.txt')
        const urls = []
        const bytes = await fetchDocs({ file, fetch: async (url) => { urls.push(url); return { ok: true, status: 200, text: async () => docs } } })
        expect(urls).toEqual([DOCS_URL])
        expect(bytes).toBe(20000)
        expect(await fs.readFile(file, 'utf8')).toBe(docs)
    })

    it('fails on an HTTP error or a page too small to be the docs, leaving no file', async () => {
        const file = path.join(env.tmp, 'docs', 'llms-full.txt')
        await expect(fetchDocs({ file, fetch: async () => ({ ok: false, status: 404, text: async () => '' }) })).rejects.toThrow(/HTTP 404/)
        await expect(fetchDocs({ file, fetch: async () => ({ ok: true, status: 200, text: async () => 'Not found' }) })).rejects.toThrow(/only 9 characters/)
        await expect(fs.access(file)).rejects.toThrow()
    })
})
