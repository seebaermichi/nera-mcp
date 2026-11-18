#!/usr/bin/env node
// Copies the Nera skill from the installed @nera-static/nera into skills/nera/,
// where the Claude Code plugin (the npm package root) carries it. The skill's
// single source is nera-cli/skills/nera/; the copy is git-ignored and made
// fresh on `prepack` and by `npm run skill`, so it always matches the
// @nera-static/nera version the lockfile installed.
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)

/** The skill as @nera-static/nera ships it. */
export const SKILL_SOURCE = path.join(path.dirname(require.resolve('@nera-static/nera/package.json')), 'skills', 'nera')
/** Where the plugin expects it: skills/<name>/SKILL.md below the plugin root. */
export const SKILL_TARGET = fileURLToPath(new URL('../skills/nera', import.meta.url))

/**
 * Replaces `to` with a copy of `from`, so a file the source dropped does not
 * linger in the copy.
 *
 * @param {object} [options]
 * @param {string} [options.from]
 * @param {string} [options.to]
 * @returns {Promise<void>}
 */
export async function syncSkill({ from = SKILL_SOURCE, to = SKILL_TARGET } = {}) {
    await fs.access(path.join(from, 'SKILL.md'))
    await fs.rm(to, { recursive: true, force: true })
    await fs.cp(from, to, { recursive: true })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        await syncSkill()
        console.error(`Copied the Nera skill into ${path.relative(process.cwd(), SKILL_TARGET)}`)
    } catch (error) {
        console.error(`Could not copy the Nera skill: ${error.message}. Run npm install, then npm pack / npm publish again.`)
        process.exitCode = 1
    }
}
