#!/usr/bin/env node
// The stdio entry of @nera-static/mcp: `npx -y @nera-static/mcp --root <folder>`.
// stdout carries the MCP protocol (JSON-RPC) and nothing else, so every
// console method that would write there is routed to stderr before any other
// module loads, and the server is imported only after that.
import { parseArgs } from 'node:util'

for (const method of ['log', 'info', 'debug', 'dir', 'dirxml', 'table']) {
    console[method] = console.error
}

const USAGE = `Usage: nera-mcp --root <folder>

Runs the Nera MCP server over stdio. An MCP client (Claude Code, Claude Desktop,
Cursor, Codex, …) starts it; it lets the assistant create, edit, build, validate,
preview and publish Nera sites inside <folder> and nowhere else.

Options:
  --root <folder>  the folder the server may work in (required, must exist)
  --help           show this help
  --version        show the version`

/**
 * Prints `message` to stderr and exits with code 1.
 *
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
    console.error(`nera-mcp: ${message}`)
    process.exit(1)
}

let options
try {
    ({ values: options } = parseArgs({
        options: {
            root: { type: 'string' },
            help: { type: 'boolean' },
            version: { type: 'boolean' },
        },
        strict: true,
        allowPositionals: false,
    }))
} catch (error) {
    fail(`${error.message}\n\n${USAGE}`)
}

// --help and --version start no server, so they may use stdout
if (options.help) {
    process.stdout.write(`${USAGE}\n`)
    process.exit(0)
}

const { default: pkg } = await import('../package.json', { with: { type: 'json' } })

if (options.version) {
    process.stdout.write(`${pkg.version}\n`)
    process.exit(0)
}

if (!options.root) {
    fail(`--root <folder> is required: the folder the server may work in.\n\n${USAGE}`)
}

// the server and the Nera packages it loads come last: only the server needs them
const [{ StdioServerTransport }, { createServer }, { createProcesses }, { PathError }, { setupRuntime }] = await Promise.all([
    import('@modelcontextprotocol/sdk/server/stdio.js'),
    import('../src/server.js'),
    import('../src/processes.js'),
    import('../src/paths.js'),
    import('../src/runtime.js'),
])

// the Desktop extension sets NERA_MCP_RUNTIME=bundled: its Node has no npm and
// nothing on the PATH, so children get a shim folder for node, npm and npx;
// the folder goes when this process exits, however it exits
const runtime = setupRuntime()
if (runtime) {
    process.on('exit', runtime.remove)
    console.error(`nera-mcp: bundled runtime, node${runtime.npm ? ', npm and npx' : ' (no npm found)'} for children in ${runtime.dir}`)
}

const processes = createProcesses()
let server
try {
    server = await createServer({ root: options.root, processes })
} catch (error) {
    if (error instanceof PathError) fail(error.message)
    throw error
}

let closing = false

/**
 * Stops the preview and publish children (they run in their own process
 * group, so they would outlive this process otherwise), closes the server
 * and exits. A second signal while that runs exits at once.
 *
 * @param {number} code
 */
async function shutdown(code) {
    if (closing) process.exit(code)
    closing = true
    try {
        // before server.close(): its onclose handler would start the same stop
        // without anyone waiting for it
        await processes.stopAll()
        await server.close()
    } catch (error) {
        console.error(`nera-mcp: shutting down failed: ${error.message}`)
        code = 1
    }
    process.exit(code)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
// the client hung up: stdin ends, or stdout can no longer be written
process.stdin.on('end', () => shutdown(0))
process.stdout.on('error', () => shutdown(0))

await server.connect(new StdioServerTransport())
console.error(`nera-mcp ${pkg.version}: serving Nera sites under ${options.root} over stdio`)
