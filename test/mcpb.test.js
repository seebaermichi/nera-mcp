import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { validateManifest } from '@anthropic-ai/mcpb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import pkg from '../package.json' with { type: 'json' }
import {
    ICON, ROOT, STAGED, TEMPLATE, buildManifest, bundleName, firstSentence, serverCatalog,
} from '../scripts/build-mcpb.js'
import { BUNDLED, RUNTIME_ENV } from '../src/runtime.js'
import { connect, makeRoot } from './helpers.js'

let env
let template

beforeEach(async () => {
    env = await makeRoot()
    template = JSON.parse(await fs.readFile(TEMPLATE, 'utf8'))
    // validateManifest reports on console.log
    vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(async () => {
    vi.restoreAllMocks()
    await env.cleanup()
})

/** The tools and prompts of the server, listed by a client of its own. */
async function listedByServer() {
    const session = await connect(env.root)
    try {
        const { tools } = await session.client.listTools()
        const { prompts } = await session.client.listPrompts()
        return { tools, prompts }
    } finally {
        await session.close()
    }
}

/** Writes `manifest` and the icon into a fresh folder, as the bundle has them. */
async function extensionDir(manifest) {
    const dir = path.join(env.tmp, 'extension')
    await fs.mkdir(dir)
    await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest))
    await fs.copyFile(ICON, path.join(dir, 'icon.png'))
    return dir
}

describe('the manifest template', () => {
    it('leaves the version, tools and prompts to package.json and the server', () => {
        expect(template).not.toHaveProperty('version')
        expect(template).not.toHaveProperty('tools')
        expect(template).not.toHaveProperty('prompts')
    })

    it('asks for the root folder with a required directory picker and passes it as --root', () => {
        expect(template.user_config.root).toMatchObject({ type: 'directory', required: true })
        expect(template.server.mcp_config.args).toEqual(['${__dirname}/bin/nera-mcp.js', '--root', '${user_config.root}'])
    })

    it('starts the bin the package declares, on the bundled runtime', () => {
        expect(template.server.entry_point).toBe(pkg.bin['nera-mcp'])
        expect(existsSync(path.join(ROOT, template.server.entry_point))).toBe(true)
        expect(template.server.mcp_config.env).toEqual({ [RUNTIME_ENV]: BUNDLED })
    })

    it('requires the Node the package requires', () => {
        expect(template.compatibility.runtimes.node).toBe(pkg.engines.node)
    })

    it('stages files that exist', () => {
        // docs/ is downloaded by `npm run mcpb` before the build and is git-ignored
        for (const entry of STAGED.filter((name) => name !== 'docs')) {
            expect(existsSync(path.join(ROOT, entry)), entry).toBe(true)
        }
    })
})

describe('the generated manifest', () => {
    it('lists every tool and prompt the server registers, with the package version', async () => {
        const manifest = buildManifest({ template, pkg, catalog: await serverCatalog() })
        const server = await listedByServer()

        expect(manifest.version).toBe(pkg.version)
        expect(manifest.tools.map((tool) => tool.name)).toEqual(server.tools.map((tool) => tool.name))
        expect(manifest.prompts.map((prompt) => prompt.name)).toEqual(server.prompts.map((prompt) => prompt.name))
        expect(manifest.tools).toHaveLength(16)
        expect(manifest.prompts).toHaveLength(4)
        for (const [index, prompt] of manifest.prompts.entries()) {
            expect(prompt.description).toBe(server.prompts[index].description)
            expect(prompt.arguments).toEqual(server.prompts[index].arguments.map((argument) => argument.name))
            expect(prompt.text).toContain('list_sites')
        }
        for (const [index, tool] of manifest.tools.entries()) {
            expect(server.tools[index].description.startsWith(tool.description)).toBe(true)
        }
    })

    it('passes mcpb validate', async () => {
        const manifest = buildManifest({ template, pkg, catalog: await serverCatalog() })
        expect(manifest.repository.url).toBe('https://github.com/seebaermichi/nera-mcp.git')

        expect(validateManifest(await extensionDir(manifest))).toBe(true)
    })

    it('fails mcpb validate without a version (the validator does check)', async () => {
        const { version, ...manifest } = buildManifest({ template, pkg, catalog: await serverCatalog() })
        expect(version).toBe(pkg.version)

        expect(validateManifest(await extensionDir(manifest))).toBe(false)
    })
})

describe('firstSentence', () => {
    it('ends at the first full stop, not at e.g. or i.e.', () => {
        expect(firstSentence('Lists kits (e.g. `blog`, i.e. a starter). Call it first. More.')).toBe('Lists kits (e.g. `blog`, i.e. a starter).')
    })

    it('ends before a sentence that starts with code', () => {
        expect(firstSentence('Writes a page. `layout` is required.')).toBe('Writes a page.')
    })

    it('keeps a text with one sentence whole', () => {
        expect(firstSentence('Builds a site.')).toBe('Builds a site.')
    })
})

describe('bundleName', () => {
    it('names the bundle after the package version', () => {
        expect(bundleName({ version: '1.2.3' })).toBe('nera-mcp-1.2.3.mcpb')
    })
})
