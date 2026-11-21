// The HTTP app of the hosted mode (L7b, plan D1/D4/D5): one Express app that
// is both the OAuth 2.1 authorization server and the protected MCP resource.
//
//   /.well-known/oauth-protected-resource/mcp   RFC 9728, names our issuer
//   /.well-known/oauth-authorization-server     RFC 8414 (S256 only, DCR)
//   /register /authorize /token /revoke         the SDK's `mcpAuthRouter`
//   POST /oauth/consent                         our consent page's form
//   GET  /oauth/github/callback                 GitHub's redirect back to us
//   /mcp                                        Streamable HTTP, bearer-guarded
//
// The issuer is configured, never taken from the request: behind a TLS proxy
// the request says `http://127.0.0.1:…`, while every URL we publish must be the
// public `https://` one. `/mcp` is stateless — each POST gets a fresh server
// and transport, bound to the caller's token through `req.auth`.
import express from 'express'
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js'
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CONSENT_PATH } from './consent.js'
import { createHostedServer } from './mcp.js'
import { createProvider } from './provider.js'

/** Where the MCP endpoint lives; the protected resource is `<issuer>/mcp`. */
export const MCP_PATH = '/mcp'

/** GitHub's redirect back to us; the GitHub App's callback URL is `<issuer>` + this. */
export const GITHUB_CALLBACK_PATH = '/oauth/github/callback'

/** The largest JSON-RPC request body `/mcp` accepts. */
const MCP_BODY_LIMIT = '1mb'

/** A JSON-RPC error without a request id, for requests the transport never sees. */
function jsonRpcError(res, status, code, message) {
    res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null })
}

/**
 * Checks the configured issuer: an origin only, since the SDK publishes the
 * endpoints and the authorization-server metadata at the root of it. The SDK
 * itself refuses a non-https issuer other than localhost.
 *
 * @param {string|URL} issuer
 * @returns {URL}
 */
function issuerUrl(issuer) {
    const url = new URL(issuer)
    if (url.pathname !== '/' || url.search || url.hash) {
        throw new Error(`The issuer must be an origin such as https://mcp.nera-pro.app, without a path, query or fragment (got ${url.href}).`)
    }
    return url
}

/**
 * Builds the hosted app. It does not listen: the bin (or a test) hands it to
 * an HTTP server.
 *
 * @param {object} options
 * @param {string|URL} options.issuer our public origin, e.g. `https://mcp.nera-pro.app`
 * @param {ReturnType<import('./store.js').createStore>} options.store
 * @param {ReturnType<import('./github.js').createGitHubClient>} options.github with `<issuer>/oauth/github/callback` as its redirect URI
 * @param {typeof fetch} [options.fetch] fetches the npm registry catalogs for the tools
 * @param {() => number} [options.now] the clock in milliseconds
 * @param {(message: string) => void} [options.log] where failures are reported (never with a token in them)
 * @param {boolean|number|string} [options.trustProxy] Express's `trust proxy`, so the rate limits see the client's address behind a proxy
 * @returns {{ app: import('express').Express, provider: ReturnType<typeof createProvider> }}
 */
export function createHostedApp({ issuer, store, github, fetch = globalThis.fetch, now, log = () => {}, trustProxy = false }) {
    const base = issuerUrl(issuer)
    const resource = new URL(MCP_PATH, base)
    const provider = createProvider({ store, github, now, log })

    const app = express()
    app.disable('x-powered-by')
    app.set('trust proxy', trustProxy)

    app.use(mcpAuthRouter({ provider, issuerUrl: base, resourceServerUrl: resource, resourceName: 'Nera' }))
    app.post(CONSENT_PATH, express.urlencoded({ extended: false }), (req, res) => provider.handleConsent(req, res))
    app.get(GITHUB_CALLBACK_PATH, (req, res) => provider.handleGitHubCallback(req, res))

    // Every method on /mcp passes the guard first; a token is accepted only
    // when it was issued for exactly this resource.
    app.use(MCP_PATH, requireBearerAuth({
        verifier: provider,
        resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resource),
        expectedResource: resource,
    }))
    app.post(MCP_PATH, express.json({ limit: MCP_BODY_LIMIT }), async (req, res) => {
        const server = createHostedServer({ fetch })
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
        // Both close calls are async; allSettled keeps a failed close from becoming an unhandled rejection.
        res.on('close', () => void Promise.allSettled([transport.close(), server.close()]))
        await server.connect(transport)
        await transport.handleRequest(req, res, req.body)
    })
    // Stateless: there is no session to stream to (GET) or to end (DELETE).
    app.all(MCP_PATH, (req, res) => {
        res.setHeader('Allow', 'POST')
        jsonRpcError(res, 405, -32000, 'Method not allowed: this server is stateless, send every request as a POST.')
    })

    // Last: a body a parser refused keeps its 4xx; anything else is a 500
    // without a stack trace in the response. `/mcp` answers in JSON-RPC, the
    // browser routes (consent, callback) in plain text.
    app.use((error, req, res, next) => {
        if (res.headersSent) {
            next(error)
            return
        }
        const clientError = error.expose && error.status >= 400 && error.status < 500
        if (!clientError) log(`${req.method} ${req.path} failed: ${error.message}`)
        const status = clientError ? error.status : 500
        const message = clientError ? error.message : 'Internal server error.'
        if (req.path === MCP_PATH) {
            const code = !clientError ? -32603 : error.type === 'entity.parse.failed' ? -32700 : -32600
            jsonRpcError(res, status, code, message)
            return
        }
        res.status(status).type('text/plain').send(message)
    })

    return { app, provider }
}
