import { readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import pkg from '../package.json' with { type: 'json' }
import { ICON, ROOT, TEMPLATE } from '../scripts/build-mcpb.js'
import { SKILL_SOURCE, SKILL_TARGET, syncSkill } from '../scripts/sync-skill.js'
import { PLUGIN_MANIFEST, serverSpec, syncVersion } from '../scripts/sync-version.js'

const plugin = JSON.parse(readFileSync(PLUGIN_MANIFEST, 'utf8'))
const marketplace = JSON.parse(readFileSync(path.join(ROOT, '.claude-plugin', 'marketplace.json'), 'utf8'))
const mcpbTemplate = JSON.parse(readFileSync(TEMPLATE, 'utf8'))

let tmp

beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nera-mcp-plugin-'))
})

afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true })
})

/** Every file below `dir`, relative to it, with its content, sorted. */
async function tree(dir) {
    const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true })
    const files = entries.filter((entry) => entry.isFile())
        .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
        .sort()
    return Promise.all(files.map(async (file) => [file, await fs.readFile(path.join(dir, file), 'utf8')]))
}

describe('the plugin manifest', () => {
    it('carries the package version and starts the server at exactly that version', () => {
        expect(plugin.version).toBe(pkg.version)
        expect(plugin.mcpServers.nera).toEqual({
            command: 'npx',
            args: ['-y', `@nera-static/mcp@${pkg.version}`, '--root', '${user_config.root}'],
        })
    })

    it('asks for the sites folder on enable, as the Desktop extension does', () => {
        expect(plugin.userConfig.root).toEqual(mcpbTemplate.user_config.root)
        expect(plugin.userConfig.root).toMatchObject({ type: 'directory', required: true })
    })

    it('has the icon of the extension, by a path inside the plugin', () => {
        expect(plugin.icon).toMatch(/^\.\//)
        expect(path.resolve(ROOT, plugin.icon)).toBe(ICON)
    })

    it('is named nera', () => {
        expect(plugin.name).toBe('nera')
    })
})

describe('the marketplace', () => {
    it('lists the plugin once, installed from this npm package', () => {
        expect(marketplace.name).toBe('nera')
        expect(marketplace.plugins).toHaveLength(1)
        expect(marketplace.plugins[0]).toMatchObject({
            name: plugin.name,
            source: { source: 'npm', package: pkg.name },
        })
    })
})

describe('syncVersion', () => {
    it('sets the version and the npx pin, and leaves every other argument alone', async () => {
        const file = path.join(tmp, 'plugin.json')
        await fs.copyFile(PLUGIN_MANIFEST, file)

        const written = await syncVersion({ version: '9.8.7', file })

        const reread = JSON.parse(await fs.readFile(file, 'utf8'))
        expect(reread).toEqual(written)
        expect(reread.version).toBe('9.8.7')
        expect(reread.mcpServers.nera.args).toEqual(['-y', serverSpec('9.8.7'), '--root', '${user_config.root}'])
        expect({ ...reread, version: plugin.version, mcpServers: plugin.mcpServers }).toEqual(plugin)
    })

    it('writes the file in the form it is committed in', async () => {
        const file = path.join(tmp, 'plugin.json')
        await fs.copyFile(PLUGIN_MANIFEST, file)

        await syncVersion({ version: pkg.version, file })

        expect(await fs.readFile(file, 'utf8')).toBe(readFileSync(PLUGIN_MANIFEST, 'utf8'))
    })

    it('runs on npm version', () => {
        expect(pkg.scripts.version).toContain('node scripts/sync-version.js')
    })
})

describe('syncSkill', () => {
    it('copies the skill @nera-static/nera ships, recipes included', async () => {
        const to = path.join(tmp, 'skills', 'nera')

        await syncSkill({ to })

        const copied = await tree(to)
        expect(copied.map(([file]) => file)).toContain('SKILL.md')
        expect(copied.some(([file]) => file.startsWith(`recipes${path.sep}`))).toBe(true)
        expect(copied).toEqual(await tree(SKILL_SOURCE))
    })

    it('drops a file the source no longer has', async () => {
        const to = path.join(tmp, 'skills', 'nera')
        await fs.mkdir(to, { recursive: true })
        await fs.writeFile(path.join(to, 'stale.md'), 'gone upstream')

        await syncSkill({ to })

        expect((await tree(to)).map(([file]) => file)).not.toContain('stale.md')
    })

    it('fails without touching the copy when the source has no SKILL.md', async () => {
        const to = path.join(tmp, 'skills', 'nera')
        await fs.mkdir(to, { recursive: true })
        await fs.writeFile(path.join(to, 'SKILL.md'), 'kept')

        await expect(syncSkill({ from: path.join(tmp, 'missing'), to })).rejects.toThrow()

        expect(await fs.readFile(path.join(to, 'SKILL.md'), 'utf8')).toBe('kept')
    })

    it('targets skills/nera below the package root and runs on prepack', () => {
        expect(SKILL_TARGET).toBe(path.join(ROOT, 'skills', 'nera'))
        expect(pkg.scripts.prepack).toContain('node scripts/sync-skill.js')
    })
})

describe('the package, which is the plugin root', () => {
    it('ships the plugin manifest, its icon and the skill, and nothing internal', () => {
        expect(pkg.files).toEqual(expect.arrayContaining(['.claude-plugin/plugin.json', 'skills']))
        expect(pkg.files).toContain(path.relative(ROOT, path.resolve(ROOT, plugin.icon)).split(path.sep).join('/'))
        for (const internal of ['.claude', '.claude-plugin', '.mcp.json', 'plans', 'mcpb', 'scripts', 'test']) {
            expect(pkg.files, internal).not.toContain(internal)
        }
    })

    it('keeps the skill copy out of git', () => {
        expect(readFileSync(path.join(ROOT, '.gitignore'), 'utf8').split('\n')).toContain('/skills/')
    })
})
