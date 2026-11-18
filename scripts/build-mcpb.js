#!/usr/bin/env node
// Builds the Claude Desktop extension, `nera-mcp-<version>.mcpb`: a zip of
// the server (bin, src, docs), its production node_modules and npm itself,
// with a manifest.json made from mcpb/manifest.json, package.json and the
// tools and prompts the server really registers. Claude Desktop runs it on
// the Node it ships, which has no npm (see src/runtime.js). Run it through
// `npm run mcpb`, which downloads the docs first; the bundle is git-ignored
// and attached to the GitHub Release by publish.yml.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { packExtension } from '@anthropic-ai/mcpb'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { BUNDLED_DOCS } from '../src/resources.js'
import { npmCommand } from '../src/runner.js'
import { npmScripts } from '../src/runtime.js'
import { createServer } from '../src/server.js'

/** The repository root. */
export const ROOT = fileURLToPath(new URL('..', import.meta.url))
/** The manifest template: everything the server and package.json do not say. */
export const TEMPLATE = path.join(ROOT, 'mcpb', 'manifest.json')
/** The extension's icon (nera.js.org's apple-touch-icon). */
export const ICON = path.join(ROOT, 'mcpb', 'icon.png')
/** What the bundle takes from the repository, besides the manifest and icon. */
export const STAGED = ['bin', 'src', 'docs', 'package.json', 'package-lock.json', 'LICENSE', 'README.md']
/**
 * The machines Claude Desktop runs on. Native dependencies (rolldown,
 * lightningcss, the keyring) come as one optional package per platform, and
 * npm installs only the one it runs on, so the bundle collects all of them.
 */
export const TARGETS = [
    { os: 'darwin', cpu: 'arm64' },
    { os: 'darwin', cpu: 'x64' },
    { os: 'win32', cpu: 'x64' },
    { os: 'win32', cpu: 'arm64' },
]

/**
 * The first sentence of a tool description, for the extension's tool list
 * (the full description stays with the server, where the model reads it).
 * A sentence ends at a full stop followed by white space, except the one of
 * an `e.g.` or `i.e.`.
 *
 * @param {string} text
 * @returns {string}
 */
export function firstSentence(text) {
    const match = /^([\s\S]+?(?<!\b(?:e\.g|i\.e))\.)(?=\s)/.exec(text)
    return match ? match[1] : text
}

/**
 * The tools and prompts the server registers, read the way a client reads
 * them (over an in-memory transport, from a throwaway root), so the manifest
 * cannot drift from the server.
 *
 * @returns {Promise<{ tools: Array<{ name: string, description: string }>, prompts: Array<{ name: string, description: string, arguments: string[], text: string }> }>}
 */
export async function serverCatalog() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nera-mcpb-root-'))
    const server = await createServer({ root })
    const client = new Client({ name: 'build-mcpb', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    try {
        await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
        const { tools } = await client.listTools()
        const { prompts } = await client.listPrompts()
        return {
            tools: tools.map((tool) => ({ name: tool.name, description: firstSentence(tool.description) })),
            prompts: await Promise.all(prompts.map(async (prompt) => {
                // the text without arguments: each prompt then starts from list_sites
                const { messages } = await client.getPrompt({ name: prompt.name, arguments: {} })
                return {
                    name: prompt.name,
                    description: prompt.description,
                    arguments: (prompt.arguments || []).map((argument) => argument.name),
                    text: messages.map((message) => message.content.text).join('\n\n'),
                }
            })),
        }
    } finally {
        await client.close()
        await server.close()
        await fs.rm(root, { recursive: true, force: true })
    }
}

/**
 * The extension's manifest: the template, with the version and the package
 * facts from package.json and the tools and prompts from the server.
 *
 * @param {object} options
 * @param {object} options.template the parsed mcpb/manifest.json
 * @param {object} options.pkg the parsed package.json
 * @param {Awaited<ReturnType<typeof serverCatalog>>} options.catalog
 * @returns {object}
 */
export function buildManifest({ template, pkg, catalog }) {
    return {
        ...template,
        version: pkg.version,
        description: pkg.description,
        author: { name: pkg.author },
        repository: { type: pkg.repository.type, url: pkg.repository.url.replace(/^git\+/, '') },
        homepage: pkg.homepage,
        support: pkg.bugs.url,
        keywords: pkg.keywords,
        license: pkg.license,
        tools: catalog.tools,
        prompts: catalog.prompts,
    }
}

/**
 * The bundle's file name: `nera-mcp-<version>.mcpb`.
 *
 * @param {{ version: string }} pkg
 * @returns {string}
 */
export function bundleName(pkg) {
    return `nera-mcp-${pkg.version}.mcpb`
}

/**
 * Runs npm (the one running this build) in `cwd` and throws when it fails.
 *
 * @param {string[]} args
 * @param {string} cwd
 */
function npm(args, cwd) {
    const { file, prefix } = npmCommand()
    const result = spawnSync(file, [...prefix, ...args], { cwd, stdio: 'inherit' })
    if (result.status !== 0) {
        throw new Error(`npm ${args.join(' ')} failed in ${cwd} (${result.error?.message || `exit code ${result.status}`})`)
    }
}

/**
 * Installs the production dependencies from the lockfile into `stage` for
 * every target, merging each target's platform packages into one tree.
 *
 * @param {string} stage holds package.json and package-lock.json
 */
async function installProduction(stage) {
    const ci = (target) => ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', `--os=${target.os}`, `--cpu=${target.cpu}`]
    const [first, ...others] = TARGETS
    npm(ci(first), stage)
    for (const target of others) {
        const extra = await fs.mkdtemp(path.join(os.tmpdir(), `nera-mcpb-${target.os}-${target.cpu}-`))
        try {
            await fs.copyFile(path.join(stage, 'package.json'), path.join(extra, 'package.json'))
            await fs.copyFile(path.join(stage, 'package-lock.json'), path.join(extra, 'package-lock.json'))
            npm(ci(target), extra)
            // only what the first install lacks: the other platforms' packages
            await fs.cp(path.join(extra, 'node_modules'), path.join(stage, 'node_modules'), { recursive: true, force: false, errorOnExist: false })
        } finally {
            await fs.rm(extra, { recursive: true, force: true })
        }
    }
}

/**
 * Removes every `.bin` folder below `dir`. They hold symlinks to the
 * packages' executables, which a zip cannot carry and nothing in the
 * extension runs (children get node, npm and npx from the runtime shim).
 *
 * @param {string} dir a node_modules folder
 */
async function removeBinLinks(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const child = path.join(dir, entry.name)
        if (entry.name === '.bin') {
            await fs.rm(child, { recursive: true, force: true })
        } else {
            await removeBinLinks(child)
        }
    }
}

/**
 * Builds the bundle into the repository root.
 *
 * @returns {Promise<string>} the bundle's path
 */
export async function buildMcpb() {
    if (!existsSync(BUNDLED_DOCS)) {
        throw new Error(`${path.relative(ROOT, BUNDLED_DOCS)} is missing; run npm run mcpb, which downloads it first`)
    }
    const scripts = npmScripts()
    if (!scripts) {
        throw new Error('npm was not found next to the Node running this build; the bundle needs a copy of it')
    }
    const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'))
    const template = JSON.parse(await fs.readFile(TEMPLATE, 'utf8'))
    const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'nera-mcpb-'))
    try {
        for (const entry of STAGED) {
            await fs.cp(path.join(ROOT, entry), path.join(stage, entry), { recursive: true })
        }
        await installProduction(stage)
        // npm itself, for the runtime shim: the folder that holds bin/npm-cli.js
        await fs.cp(path.dirname(path.dirname(scripts.npmCli)), path.join(stage, 'node_modules', 'npm'), { recursive: true })
        await removeBinLinks(path.join(stage, 'node_modules'))
        await fs.copyFile(ICON, path.join(stage, 'icon.png'))
        const manifest = buildManifest({ template, pkg, catalog: await serverCatalog() })
        await fs.writeFile(path.join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 4)}\n`)
        const output = path.join(ROOT, bundleName(pkg))
        // packExtension runs `mcpb validate` on the manifest first
        if (!await packExtension({ extensionPath: stage, outputPath: output })) {
            throw new Error('mcpb validate or mcpb pack failed (see above)')
        }
        return output
    } finally {
        await fs.rm(stage, { recursive: true, force: true })
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        const output = await buildMcpb()
        console.error(`Built ${path.relative(process.cwd(), output)}`)
    } catch (error) {
        console.error(`Could not build the Desktop extension: ${error.message}`)
        process.exitCode = 1
    }
}
