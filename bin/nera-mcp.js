#!/usr/bin/env node
// The entry of @nera-static/mcp, in one of two modes:
//
//   nera-mcp --root <folder>   stdio, started by a local MCP client (L7a)
//   nera-mcp --http            the hosted server, behind a TLS proxy (L7b)
//
// In stdio mode stdout carries the MCP protocol (JSON-RPC) and nothing else,
// so every console method that would write there is routed to stderr before
// any other module loads, and the server is imported only after that. The
// hosted mode logs to stderr the same way.
import { parseArgs } from 'node:util'

for (const method of ['log', 'info', 'debug', 'dir', 'dirxml', 'table']) {
    console[method] = console.error
}

/** Where the hosted mode listens unless told otherwise: only this machine, for the proxy in front. */
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 8080

/** How long the hosted mode lets running requests finish after SIGTERM before it cuts them off. */
const SHUTDOWN_GRACE_MS = 10000

const USAGE = `Usage: nera-mcp --root <folder>
       nera-mcp --http [--port <port>] [--host <address>] [--trust-proxy <value>]

With --root, runs the Nera MCP server over stdio. An MCP client (Claude Code,
Claude Desktop, Cursor, Codex, …) starts it; it lets the assistant create, edit,
build, validate, preview and publish Nera sites inside <folder> and nowhere else.

With --http, runs the hosted server: an OAuth 2.1 authorization server that
signs users in through a GitHub App, in front of a Streamable HTTP endpoint at
/mcp. It is meant to run behind a TLS proxy and is configured by environment
variables (NERA_MCP_ISSUER, NERA_MCP_DB, NERA_MCP_TOKEN_KEY,
NERA_MCP_GITHUB_CLIENT_ID, NERA_MCP_GITHUB_CLIENT_SECRET). Needs Node 22.13+.

Options:
  --root <folder>        stdio: the folder the server may work in (required, must exist)
  --http                 run the hosted server instead of stdio
  --port <port>          hosted: the port to listen on (default ${DEFAULT_PORT}, 0 picks a free one)
  --host <address>       hosted: the address to listen on (default ${DEFAULT_HOST})
  --trust-proxy <value>  hosted: the proxies to trust for the client's address, a number
                         of hops (1) or addresses (loopback); default none
  --help                 show this help
  --version              show the version`

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
            http: { type: 'boolean' },
            port: { type: 'string' },
            host: { type: 'string' },
            'trust-proxy': { type: 'string' },
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

const HTTP_ONLY = ['port', 'host', 'trust-proxy']

if (options.http) {
    if (options.root !== undefined) {
        fail(`--root is for the stdio mode only: the hosted mode (--http) has no folder to work in.\n\n${USAGE}`)
    }
    await serveHttp()
} else {
    const stray = HTTP_ONLY.filter((name) => options[name] !== undefined)
    if (stray.length > 0) {
        fail(`${stray.map((name) => `--${name}`).join(', ')} only work together with --http.\n\n${USAGE}`)
    }
    if (!options.root) {
        fail(`--root <folder> is required: the folder the server may work in.\n\n${USAGE}`)
    }
    await serveStdio()
}

/** The local mode: one server for one client, over stdin and stdout. */
async function serveStdio() {
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
}

/**
 * The hosted mode: the OAuth server and `/mcp` on one HTTP port. Everything
 * secret comes from the environment; nothing logged here or by the app ever
 * carries a token, a key or the client secret.
 */
async function serveHttp() {
    const { HostedConfigError, hasNodeSqlite, parsePort, parseTrustProxy, readHostedConfig } = await import('../src/hosted/config.js')

    // before anything imports the store: on an older Node, `node:sqlite` would
    // fail with an error that does not say what to do
    if (!hasNodeSqlite(process.versions.node)) {
        fail(`the hosted mode (--http) needs Node 22.13 or later (for node:sqlite); this is Node ${process.versions.node}.`)
    }

    let config
    let port
    let trustProxy
    try {
        config = readHostedConfig(process.env)
        port = parsePort(options.port, DEFAULT_PORT)
        trustProxy = parseTrustProxy(options['trust-proxy'])
    } catch (error) {
        if (error instanceof HostedConfigError) fail(error.message)
        throw error
    }
    const host = options.host ?? DEFAULT_HOST

    const [{ createServer }, { createHostedApp, GITHUB_CALLBACK_PATH }, { createGitHubClient }, { createStore }] = await Promise.all([
        import('node:http'),
        import('../src/hosted/app.js'),
        import('../src/hosted/github.js'),
        import('../src/hosted/store.js'),
    ])

    const log = (message) => console.error(`nera-mcp: ${message}`)

    // the messages of these errors name a setting, never its value (the
    // issuer, a path or an address at most, none of them secret)
    let store
    let app
    try {
        const github = createGitHubClient({
            clientId: config.githubClientId,
            clientSecret: config.githubClientSecret,
            redirectUri: new URL(GITHUB_CALLBACK_PATH, config.issuer).href,
        })
        store = createStore({ file: config.db, key: config.tokenKey, log })
        app = createHostedApp({ issuer: config.issuer, store, github, log, trustProxy }).app
    } catch (error) {
        store?.close()
        fail(`cannot start the hosted mode: ${error.message}`)
    }

    const server = createServer(app)
    try {
        await new Promise((resolve, reject) => {
            server.once('error', reject)
            server.listen(port, host, resolve)
        })
    } catch (error) {
        store.close()
        fail(`cannot listen on ${host}:${port}: ${error.message}`)
    }

    let closing = false

    /**
     * Stops taking connections, lets running requests finish (for at most
     * SHUTDOWN_GRACE_MS), then closes the database and exits. A second signal
     * while that runs exits at once.
     */
    function shutdown() {
        if (closing) process.exit(0)
        closing = true
        const cutOff = setTimeout(() => server.closeAllConnections(), SHUTDOWN_GRACE_MS)
        cutOff.unref()
        server.close(() => {
            clearTimeout(cutOff)
            let code = 0
            try {
                store.close()
            } catch (error) {
                log(`closing the database failed: ${error.message}`)
                code = 1
            }
            process.exit(code)
        })
        server.closeIdleConnections()
    }

    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)

    const address = server.address()
    console.error(`nera-mcp ${pkg.version}: hosted mode for ${new URL(config.issuer).origin}, listening on ${address.address}:${address.port}`)
}
