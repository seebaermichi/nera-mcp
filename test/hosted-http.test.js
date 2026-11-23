import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHostedApp, GITHUB_CALLBACK_PATH, MCP_PATH } from '../src/hosted/app.js'
import { CONSENT_COOKIE, CONSENT_PATH } from '../src/hosted/consent.js'
import { createGitHubClient } from '../src/hosted/github.js'
import { createRepoClient } from '../src/hosted/repo.js'
import { createStore, TTL } from '../src/hosted/store.js'
import { API, fakeGitHub } from './fake-github.js'
import { SITE_PACKAGE } from './helpers.js'

const KEY = Buffer.alloc(32, 7).toString('base64')
const CLIENT_REDIRECT = 'https://claude.ai/api/mcp/auth_callback'
const GITHUB_WEB = 'https://github.example'

/** A fake GitHub behind the injected fetch: the token endpoint and `/user`. */
function fakeGitHubFetch() {
    let issued = 0
    return async (url) => {
        const href = String(url)
        if (href === `${GITHUB_WEB}/login/oauth/access_token`) {
            issued += 1
            return Response.json({ access_token: `ghu_access${issued}`, expires_in: 28800, refresh_token: `ghr_refresh${issued}`, refresh_token_expires_in: 15897600 })
        }
        if (href === 'https://api.github.example/user') return Response.json({ id: 4242, login: 'octo' })
        return new Response('not found', { status: 404 })
    }
}

/** A PKCE verifier and its S256 challenge. */
function pkce() {
    const verifier = randomBytes(32).toString('base64url')
    return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

let clock
let store
let server
let issuer
let logs
let repos

beforeEach(async () => {
    clock = Date.now()
    const now = () => clock
    server = createServer()
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    issuer = `http://127.0.0.1:${server.address().port}`
    store = createStore({ file: ':memory:', key: KEY, now })
    const github = createGitHubClient({
        clientId: 'Iv1.nera',
        clientSecret: 'app-secret',
        redirectUri: `${issuer}${GITHUB_CALLBACK_PATH}`,
        fetch: fakeGitHubFetch(),
        webUrl: GITHUB_WEB,
        apiUrl: 'https://api.github.example',
        now,
    })
    logs = []
    // the repositories of the first sign-in's user, whose token is ghu_access1
    repos = fakeGitHub({ token: 'ghu_access1' })
    repos.addRepo('octo/site', { 'package.json': SITE_PACKAGE })
    const { app } = createHostedApp({
        issuer,
        store,
        github,
        fetch: async () => new Response('offline', { status: 503 }),
        createRepo: (token) => createRepoClient({ token, fetch: repos.fetch, apiUrl: API }),
        now,
        log: (line) => logs.push(line),
    })
    server.on('request', app)
})

afterEach(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    store.close()
})

const url = (path) => `${issuer}${path}`

/** POSTs a urlencoded form without following redirects. */
function postForm(path, fields, headers = {}) {
    return fetch(url(path), {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
        body: new URLSearchParams(fields),
    })
}

/** Registers a public client the way claude.ai does (RFC 7591). */
async function register() {
    const response = await fetch(url('/register'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            client_name: 'Claude',
            redirect_uris: [CLIENT_REDIRECT],
            token_endpoint_auth_method: 'none',
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
        }),
    })
    expect(response.status).toBe(201)
    return response.json()
}

/** Our `/authorize` URL for a client; `resource: null` leaves the parameter out. */
function authorizeUrl(clientId, challenge, resource = url(MCP_PATH)) {
    const query = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: CLIENT_REDIRECT,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: 'client-state',
        ...(resource === null ? {} : { resource }),
    })
    return url(`/authorize?${query}`)
}

/**
 * Runs `/authorize` → consent page → Approve, in one browser. Returns what the
 * browser holds and where GitHub would be opened.
 */
async function approveInBrowser(clientId, challenge, resource) {
    const page = await fetch(authorizeUrl(clientId, challenge, resource), { redirect: 'manual' })
    expect(page.status).toBe(200)
    const html = await page.text()
    const field = (name) => new RegExp(`name="${name}" value="([^"]*)"`).exec(html)[1]
    const cookieToken = new RegExp(`^${CONSENT_COOKIE}=([^;]*);`).exec(page.headers.get('set-cookie'))[1]
    const cookie = `${CONSENT_COOKIE}=${cookieToken}`
    const approved = await postForm(CONSENT_PATH, { state: field('state'), csrf_token: field('csrf_token'), decision: 'approve' }, { Cookie: cookie })
    expect(approved.status).toBe(302)
    const toGitHub = new URL(approved.headers.get('location'))
    expect(toGitHub.origin + toGitHub.pathname).toBe(`${GITHUB_WEB}/login/oauth/authorize`)
    return { cookie, githubState: toGitHub.searchParams.get('state') }
}

/** GitHub's redirect back to our callback, from the browser with `cookie`. */
function githubCallback(githubState, cookie) {
    const query = new URLSearchParams({ code: 'github-code', state: githubState })
    return fetch(url(`${GITHUB_CALLBACK_PATH}?${query}`), { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} })
}

/** The whole browser part of the flow, ending with our code. */
async function signIn(resource) {
    const client = await register()
    const { verifier, challenge } = pkce()
    const { cookie, githubState } = await approveInBrowser(client.client_id, challenge, resource)
    const back = await githubCallback(githubState, cookie)
    expect(back.status).toBe(302)
    const location = new URL(back.headers.get('location'))
    return { client, verifier, location, code: location.searchParams.get('code') }
}

/** Exchanges a code at `/token`; `resource: null` leaves the parameter out. */
function exchangeCode(client, code, verifier, resource = url(MCP_PATH)) {
    return postForm('/token', {
        grant_type: 'authorization_code',
        client_id: client.client_id,
        code,
        code_verifier: verifier,
        redirect_uri: CLIENT_REDIRECT,
        ...(resource === null ? {} : { resource }),
    })
}

/** Signs in and returns our token pair. */
async function tokens() {
    const { client, verifier, code } = await signIn()
    const response = await exchangeCode(client, code, verifier)
    expect(response.status).toBe(200)
    return { client, ...(await response.json()) }
}

/** Connects an SDK client to `/mcp` with `token`. */
async function connectClient(token) {
    const client = new Client({ name: 'test', version: '1.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(url(MCP_PATH)), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }))
    return client
}

/** A JSON-RPC `initialize` POST to `/mcp`, the client's first request. */
function initialize(headers = {}) {
    return fetch(url(MCP_PATH), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } } }),
    })
}

describe('metadata', () => {
    it('serves the RFC 9728 document for /mcp, naming our issuer', async () => {
        const response = await fetch(url('/.well-known/oauth-protected-resource/mcp'))
        expect(response.status).toBe(200)
        const metadata = await response.json()
        expect(metadata.resource).toBe(url(MCP_PATH))
        expect(metadata.authorization_servers).toEqual([`${issuer}/`])
    })

    it('serves the RFC 8414 document: S256 only, DCR, our endpoints', async () => {
        const metadata = await (await fetch(url('/.well-known/oauth-authorization-server'))).json()
        expect(metadata).toMatchObject({
            issuer: `${issuer}/`,
            authorization_endpoint: url('/authorize'),
            token_endpoint: url('/token'),
            registration_endpoint: url('/register'),
            revocation_endpoint: url('/revoke'),
            code_challenge_methods_supported: ['S256'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
        })
    })

    it('takes every published URL from the configured issuer, never from the Host header', async () => {
        const forwarded = { Host: 'attacker.example', 'X-Forwarded-Host': 'attacker.example', 'X-Forwarded-Proto': 'https' }
        const resource = await (await fetch(url('/.well-known/oauth-protected-resource/mcp'), { headers: forwarded })).json()
        const server = await (await fetch(url('/.well-known/oauth-authorization-server'), { headers: forwarded })).json()
        expect(JSON.stringify([resource, server])).not.toContain('attacker')
        const unauthorized = await initialize(forwarded)
        expect(unauthorized.headers.get('www-authenticate')).toContain(`resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp"`)
    })

    it('refuses an issuer with a path, query or fragment', () => {
        for (const bad of ['https://mcp.example/base', 'https://mcp.example/?a=1', 'https://mcp.example/#x']) {
            expect(() => createHostedApp({ issuer: bad, store, github: {} })).toThrow(/must be an origin/)
        }
    })
})

describe('registration and sign-in', () => {
    it('persists a client registered via DCR', async () => {
        const client = await register()
        expect(client.client_id).toBeTruthy()
        expect(store.getClient(client.client_id)).toMatchObject({ client_name: 'Claude', redirect_uris: [CLIENT_REDIRECT] })
    })

    it('runs authorize → consent → GitHub → callback and returns our code with the client\'s state', async () => {
        const { location, code } = await signIn()
        expect(location.origin + location.pathname).toBe(CLIENT_REDIRECT)
        expect(location.searchParams.get('state')).toBe('client-state')
        expect(code).toMatch(/.{20,}/)
        expect(store.getGithubUser('4242')).toMatchObject({ login: 'octo', accessToken: 'ghu_access1' })
    })

    it('needs the consent cookie on the GitHub callback: a callback from another browser is refused', async () => {
        const client = await register()
        const { githubState } = await approveInBrowser(client.client_id, pkce().challenge)
        const back = await githubCallback(githubState, `${CONSENT_COOKIE}=someone-else`)
        expect(back.status).toBe(400)
        expect(back.headers.get('location')).toBeNull()
        expect(await back.text()).toContain('expired or was already used')
    })

    it('binds a sign-in without a resource to /mcp: its token is accepted there', async () => {
        const { client, verifier, code } = await signIn(null)
        const response = await exchangeCode(client, code, verifier, null)
        expect(response.status).toBe(200)
        const { access_token: token } = await response.json()
        const mcp = await initialize({ Authorization: `Bearer ${token}` })
        expect(mcp.status).toBe(200)
    })

    it('sends a foreign resource back to the client as invalid_target, never to the consent page', async () => {
        const client = await register()
        const response = await fetch(authorizeUrl(client.client_id, pkce().challenge, 'https://other.example/mcp'), { redirect: 'manual' })
        expect(response.status).toBe(302)
        expect(response.headers.get('set-cookie')).toBeNull()
        const location = new URL(response.headers.get('location'))
        expect(location.origin + location.pathname).toBe(CLIENT_REDIRECT)
        expect(location.searchParams.get('error')).toBe('invalid_target')
        expect(location.searchParams.get('state')).toBe('client-state')
    })

    it('refuses a consent POST whose form token is not this browser\'s cookie', async () => {
        const response = await postForm(CONSENT_PATH, { state: 'any', csrf_token: 'forged', decision: 'approve' }, { Cookie: `${CONSENT_COOKIE}=victim` })
        expect(response.status).toBe(403)
    })
})

describe('/token', () => {
    it('exchanges the code only with the right PKCE verifier, and only once', async () => {
        const { client, verifier, code } = await signIn()
        const wrong = await exchangeCode(client, code, pkce().verifier)
        expect(wrong.status).toBe(400)
        expect((await wrong.json()).error).toBe('invalid_grant')

        const right = await exchangeCode(client, code, verifier)
        expect(right.status).toBe(200)
        expect(await right.json()).toMatchObject({ token_type: 'Bearer', expires_in: TTL.access })

        const again = await exchangeCode(client, code, verifier)
        expect(again.status).toBe(400)
        expect((await again.json()).error).toBe('invalid_grant')
    })

    it('revokes the tokens of a code\'s first use when the code is sent again', async () => {
        const { client, verifier, code } = await signIn()
        const first = await (await exchangeCode(client, code, verifier)).json()
        const again = await exchangeCode(client, code, verifier)
        expect(again.status).toBe(400)
        expect((await again.json()).error).toBe('invalid_grant')
        expect((await initialize({ Authorization: `Bearer ${first.access_token}` })).status).toBe(401)
        const refreshed = await postForm('/token', { grant_type: 'refresh_token', client_id: client.client_id, refresh_token: first.refresh_token })
        expect(refreshed.status).toBe(400)
    })

    it('revokes the current pair when an already rotated refresh token is sent again', async () => {
        const { client, refresh_token: first } = await tokens()
        const refresh = (token) => postForm('/token', { grant_type: 'refresh_token', client_id: client.client_id, refresh_token: token })
        const current = await (await refresh(first)).json()
        expect((await initialize({ Authorization: `Bearer ${current.access_token}` })).status).toBe(200)
        expect((await refresh(first)).status).toBe(400)
        expect((await initialize({ Authorization: `Bearer ${current.access_token}` })).status).toBe(401)
        expect((await refresh(current.refresh_token)).status).toBe(400)
    })

    it('rotates the refresh token and refuses the old one', async () => {
        const { client, refresh_token: first } = await tokens()
        const refresh = (token) => postForm('/token', { grant_type: 'refresh_token', client_id: client.client_id, refresh_token: token })
        const rotated = await refresh(first)
        expect(rotated.status).toBe(200)
        const next = await rotated.json()
        expect(next.refresh_token).not.toBe(first)

        const reused = await refresh(first)
        expect(reused.status).toBe(400)
        expect((await reused.json()).error).toBe('invalid_grant')
    })
})

describe('/mcp', () => {
    it('serves MCP with a valid token: an SDK client lists the catalog and site tools', async () => {
        const { access_token: token } = await tokens()
        const client = await connectClient(token)
        const { tools } = await client.listTools()
        expect(tools.map((tool) => tool.name).sort()).toEqual(['delete_page', 'get_site', 'list_plugins', 'list_sites', 'list_starters', 'list_themes', 'preview', 'publish', 'read_file', 'read_page', 'validate', 'write_file', 'write_page'])
        await client.close()
    })

    it('runs the site tools as the signed-in user, with their GitHub token', async () => {
        const { access_token: token } = await tokens()
        const client = await connectClient(token)
        const result = await client.callTool({ name: 'list_sites', arguments: {} })
        expect(result.isError).toBeFalsy()
        expect(result.structuredContent.sites.map((site) => site.site)).toEqual(['octo/site'])
        expect(repos.requests.every((request) => request.headers.Authorization === 'Bearer ghu_access1')).toBe(true)
        expect(JSON.stringify(result)).not.toContain('ghu_access1')
        await client.close()
    })

    it('answers a site tool with a reconnect message when the GitHub sign-in is gone', async () => {
        const { access_token: token } = await tokens()
        // the GitHub user (id 4242 at the fake) now holds a token that expired with no refresh token left
        const past = Math.floor(clock / 1000) - 60
        store.saveGithubUser({ id: 4242, login: 'octo', accessToken: 'ghu_old', accessTokenExpiresAt: past })
        const client = await connectClient(token)
        const result = await client.callTool({ name: 'list_sites', arguments: {} })
        expect(result.isError).toBe(true)
        expect(result.content[0].text).toMatch(/The GitHub sign-in has expired\. Sign in again: remove the Nera connector/)
        await client.close()
    })

    /** Expects a 401 that points the client at our resource metadata. */
    async function expectUnauthorized(response) {
        expect(response.status).toBe(401)
        const header = response.headers.get('www-authenticate')
        expect(header).toMatch(/^Bearer error="invalid_token"/)
        expect(header).toContain(`resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp"`)
    }

    it('answers 401 without a token, on every method', async () => {
        await expectUnauthorized(await initialize())
        for (const method of ['GET', 'DELETE', 'PUT']) {
            await expectUnauthorized(await fetch(url(MCP_PATH), { method, headers: { Accept: 'text/event-stream' } }))
        }
        await expectUnauthorized(await fetch(url(`${MCP_PATH}/anything`), { method: 'POST' }))
    })

    it('answers 401 for an unknown token and for a malformed Authorization header', async () => {
        await expectUnauthorized(await initialize({ Authorization: 'Bearer not-a-token' }))
        await expectUnauthorized(await initialize({ Authorization: 'Basic dXNlcjpwYXNz' }))
    })

    it('answers 401 for an expired token', async () => {
        const { access_token: token } = await tokens()
        clock += (TTL.access + 1) * 1000
        await expectUnauthorized(await initialize({ Authorization: `Bearer ${token}` }))
    })

    it('answers 401 for a revoked token', async () => {
        const { client, access_token: token } = await tokens()
        const revoked = await postForm('/revoke', { client_id: client.client_id, token })
        expect(revoked.status).toBe(200)
        await expectUnauthorized(await initialize({ Authorization: `Bearer ${token}` }))
    })

    it('answers 401 for a token issued for another resource, or for none', async () => {
        const client = await register()
        for (const resource of ['https://other.example/mcp', `${issuer}/other`, undefined]) {
            const { accessToken } = store.issueTokens({ clientId: client.client_id, userId: '4242', resource })
            await expectUnauthorized(await initialize({ Authorization: `Bearer ${accessToken}` }))
        }
    })

    it('answers 405 to GET and DELETE with a valid token: the server is stateless', async () => {
        const { access_token: token } = await tokens()
        for (const method of ['GET', 'DELETE']) {
            const response = await fetch(url(MCP_PATH), { method, headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' } })
            expect(response.status).toBe(405)
            expect(response.headers.get('allow')).toBe('POST')
        }
    })

    it('answers a malformed JSON body with a JSON-RPC parse error, not a stack trace', async () => {
        const { access_token: token } = await tokens()
        const response = await fetch(url(MCP_PATH), {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
            body: '{not json',
        })
        expect(response.status).toBe(400)
        expect((await response.json()).error.code).toBe(-32700)
    })
})

describe('errors', () => {
    it('answers an unexpected failure with a plain 500 and logs only its message', async () => {
        const client = await register()
        const query = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: CLIENT_REDIRECT, code_challenge: pkce().challenge, code_challenge_method: 'S256' })
        const page = await fetch(url(`/authorize?${query}`))
        const html = await page.text()
        const field = (name) => new RegExp(`name="${name}" value="([^"]*)"`).exec(html)[1]
        store.approvePending = () => {
            throw new Error('disk I/O error')
        }
        const response = await postForm(CONSENT_PATH, { state: field('state'), csrf_token: field('csrf_token'), decision: 'approve' }, { Cookie: `${CONSENT_COOKIE}=${field('csrf_token')}` })
        expect(response.status).toBe(500)
        expect(await response.text()).toBe('Internal server error.')
        expect(logs).toEqual(['POST /oauth/consent failed: disk I/O error'])
    })
})
