#!/usr/bin/env node
// Writes the package version into .claude-plugin/plugin.json: its `version`
// and the version npx starts the server at, so the plugin never runs a server
// of another release. Runs on the `version` lifecycle (npm version), which
// bumps package.json first.
import fs from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import pkg from '../package.json' with { type: 'json' }

/** The plugin manifest. */
export const PLUGIN_MANIFEST = fileURLToPath(new URL('../.claude-plugin/plugin.json', import.meta.url))

/**
 * The npx package spec of the server at `version`.
 *
 * @param {string} version
 * @returns {string}
 */
export function serverSpec(version) {
    return `${pkg.name}@${version}`
}

/**
 * Sets the plugin's version and every pinned server spec in its MCP servers
 * to `version`.
 *
 * @param {object} [options]
 * @param {string} [options.version] defaults to package.json's, read fresh (npm version has just changed it)
 * @param {string} [options.file]
 * @returns {Promise<object>} the manifest as written
 */
export async function syncVersion({ version, file = PLUGIN_MANIFEST } = {}) {
    const target = version ?? JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')).version
    const manifest = JSON.parse(await fs.readFile(file, 'utf8'))
    const pinned = new RegExp(`^${pkg.name.replace(/[/.]/g, '\\$&')}@`)
    manifest.version = target
    for (const server of Object.values(manifest.mcpServers ?? {})) {
        server.args = server.args.map((arg) => (pinned.test(arg) ? serverSpec(target) : arg))
    }
    await fs.writeFile(file, `${JSON.stringify(manifest, null, 4)}\n`)
    return manifest
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const { version } = await syncVersion()
    console.error(`Set .claude-plugin/plugin.json to ${serverSpec(version)}`)
}
