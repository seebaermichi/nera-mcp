// The bundled runtime of the Claude Desktop extension: Claude Desktop runs the
// server on the Node it ships, which comes without npm and puts nothing on the
// PATH. Every child (`createSite`'s `npm pack` and `npm install`, `nera dev`
// → Vite's `#!/usr/bin/env node` scripts, npm's lifecycle scripts) looks
// `node`, `npm` and `npx` up on the PATH, so under `NERA_MCP_RUNTIME=bundled`
// the bin writes a shim folder for the three and every child gets it first on
// its PATH (`childEnv` in `src/runner.js`).
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)

/** The environment variable that switches the bundled runtime on. */
export const RUNTIME_ENV = 'NERA_MCP_RUNTIME'
/** Its one value that does; any other leaves children as they were. */
export const BUNDLED = 'bundled'

/**
 * The `npm` package folder this server can load itself: the one the
 * Desktop extension bundles in its `node_modules`, or null when there is none
 * (an ordinary install from npm brings none). Only `node_modules` folders
 * count, not Node's legacy global folders (`~/.node_modules`, `$PREFIX/lib/node`).
 *
 * @returns {string|null}
 */
export function ownNpm() {
    const folders = (require.resolve.paths('npm') || []).filter((folder) => path.basename(folder) === 'node_modules')
    const found = folders.find((folder) => existsSync(path.join(folder, 'npm', 'bin', 'npm-cli.js')))
    return found ? path.join(found, 'npm') : null
}

/**
 * Where npm's two entry scripts are: in the server's own `node_modules/npm`
 * first (the bundled one), else next to the Node binary, where every Node
 * installer puts npm (`lib/node_modules/npm` on POSIX, `node_modules/npm` on
 * Windows). Null when neither has it.
 *
 * @param {string} [execPath] the Node binary
 * @param {string|null} [own] the server's own npm package folder
 * @returns {{ npmCli: string, npxCli: string }|null}
 */
export function npmScripts(execPath = process.execPath, own = ownNpm()) {
    const bin = path.dirname(execPath)
    const folders = [
        own,
        path.join(bin, '..', 'lib', 'node_modules', 'npm'),
        path.join(bin, 'node_modules', 'npm'),
    ].filter(Boolean)
    const folder = folders.find((candidate) => existsSync(path.join(candidate, 'bin', 'npm-cli.js')))
    if (!folder) return null
    return {
        npmCli: path.join(folder, 'bin', 'npm-cli.js'),
        npxCli: path.join(folder, 'bin', 'npx-cli.js'),
    }
}

/**
 * Quotes a path for a POSIX `sh` script: in single quotes, where nothing is
 * expanded, with each `'` closed, escaped and reopened.
 *
 * @param {string} value
 * @returns {string}
 */
function shQuote(value) {
    return `'${value.replaceAll('\'', '\'\\\'\'')}'`
}

/**
 * Quotes a path for a Windows `.cmd` script: in double quotes (a Windows path
 * cannot contain one), with `%` doubled so cmd does not expand it as a
 * variable.
 *
 * @param {string} value
 * @returns {string}
 */
function cmdQuote(value) {
    return `"${value.replaceAll('%', '%%')}"`
}

/**
 * The shim scripts for a platform: file name → content. Each one runs its
 * target with the Node binary and passes every argument on unchanged (`"$@"`
 * in `sh`, `%*` in `cmd`). `npm` and `npx` are left out when no npm was found.
 *
 * @param {object} options
 * @param {string} options.execPath the Node binary the children run on
 * @param {{ npmCli: string, npxCli: string }|null} options.npm
 * @param {NodeJS.Platform} options.platform
 * @returns {Record<string, string>}
 */
export function shimScripts({ execPath, npm, platform }) {
    const targets = { node: [execPath] }
    if (npm) {
        targets.npm = [execPath, npm.npmCli]
        targets.npx = [execPath, npm.npxCli]
    }
    const scripts = {}
    for (const [name, command] of Object.entries(targets)) {
        if (platform === 'win32') {
            scripts[`${name}.cmd`] = `@echo off\r\n${command.map(cmdQuote).join(' ')} %*\r\n`
        } else {
            scripts[name] = `#!/bin/sh\nexec ${command.map(shQuote).join(' ')} "$@"\n`
        }
    }
    return scripts
}

/**
 * Writes the shim folder: a fresh temp folder (never inside a site or the
 * root) holding the scripts of `shimScripts`, executable on POSIX.
 *
 * @param {object} [options]
 * @param {string} [options.execPath]
 * @param {{ npmCli: string, npxCli: string }|null} [options.npm]
 * @param {NodeJS.Platform} [options.platform]
 * @param {string} [options.parent] the folder the shim folder is created in
 * @returns {{ dir: string, npm: boolean, remove: () => void }} `remove` deletes the folder, and may be called more than once
 */
export function writeShim({
    execPath = process.execPath,
    npm = npmScripts(execPath),
    platform = process.platform,
    parent = os.tmpdir(),
} = {}) {
    const dir = mkdtempSync(path.join(parent, 'nera-mcp-runtime-'))
    for (const [name, content] of Object.entries(shimScripts({ execPath, npm, platform }))) {
        writeFileSync(path.join(dir, name), content, { mode: 0o755 })
    }
    return {
        dir,
        npm: Boolean(npm),
        remove: () => rmSync(dir, { recursive: true, force: true }),
    }
}

/**
 * The name of the PATH variable in `env`. On Windows the name is
 * case-insensitive and is usually `Path`; an env object spread from
 * `process.env` keeps that spelling, so it is looked up rather than assumed.
 *
 * @param {Record<string, string|undefined>} env
 * @param {NodeJS.Platform} platform
 * @returns {string}
 */
export function pathKey(env, platform = process.platform) {
    if (platform !== 'win32') return 'PATH'
    return Object.keys(env).find((key) => key.toUpperCase() === 'PATH') || 'Path'
}

/**
 * A copy of `env` with `dir` first on its PATH. On Windows every spelling of
 * the variable is folded into one, so the child does not get two that
 * disagree.
 *
 * @param {Record<string, string|undefined>} env
 * @param {string} dir
 * @param {NodeJS.Platform} [platform]
 * @returns {Record<string, string|undefined>}
 */
export function withPathPrefix(env, dir, platform = process.platform) {
    const key = pathKey(env, platform)
    const delimiter = platform === 'win32' ? ';' : ':'
    const result = { ...env }
    if (platform === 'win32') {
        for (const name of Object.keys(result)) {
            if (name.toUpperCase() === 'PATH') delete result[name]
        }
    }
    result[key] = env[key] ? `${dir}${delimiter}${env[key]}` : dir
    return result
}

/** @type {string|null} */
let activeDir = null

/**
 * Makes `dir` the shim folder every child is spawned with (`spawnOptions`);
 * null switches that off again.
 *
 * @param {string|null} dir
 */
export function activateShim(dir) {
    activeDir = dir
}

/**
 * The shim folder in use, or null when children get the PATH unchanged.
 *
 * @returns {string|null}
 */
export function activeShim() {
    return activeDir
}

/**
 * What the bin calls at start: under `NERA_MCP_RUNTIME=bundled` it writes the
 * shim folder and activates it; otherwise it does nothing. The env it reads is
 * never changed: the shim reaches every child through `childEnv`, also the
 * ones `createSite` starts in-process (it takes that env).
 *
 * @param {object} [options]
 * @param {Record<string, string|undefined>} [options.env] read for the switch only
 * @param {Parameters<typeof writeShim>[0]} [options.shim] passed to `writeShim` (tests)
 * @returns {ReturnType<typeof writeShim>|null} the shim, whose `remove` the bin calls on exit
 */
export function setupRuntime({ env = process.env, shim } = {}) {
    if (env[RUNTIME_ENV] !== BUNDLED) return null
    const written = writeShim(shim)
    activateShim(written.dir)
    return written
}
