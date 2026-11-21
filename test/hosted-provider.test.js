import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CONSENT_COOKIE } from '../src/hosted/consent.js'
import { createGitHubClient, GitHubError } from '../src/hosted/github.js'
import { createProvider, SignInRequiredError } from '../src/hosted/provider.js'
import { createStore, TTL } from '../src/hosted/store.js'

const KEY = Buffer.alloc(32, 3).toString('base64')
const CALLBACK = 'https://mcp.example/oauth/github/callback'
const RESOURCE = new URL('https://mcp.example/mcp')
const CLIENT = { client_id: 'client-a', client_secret: 'secret-a', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], client_name: 'Claude' }
const OTHER_CLIENT = { client_id: 'client-b', redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'] }
const AUTH_PARAMS = { codeChallenge: 'the-challenge', redirectUri: CLIENT.redirect_uris[0], state: 'client-state', scopes: ['mcp'], resource: RESOURCE }

/**
 * A fake GitHub: answers the token endpoint and `/user`, and records every
 * request. `github.tokenAnswer` / `github.userAnswer` switch the answers.
 */
function fakeGitHub() {
    const github = {
        requests: [],
        issued: 0,
        tokenAnswer: null,
        userAnswer: { status: 200, body: { id: 4242, login: 'octo' } },
    }
    github.fetch = async (url, init = {}) => {
        const href = String(url)
        const body = init.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : undefined
        github.requests.push({ href, headers: init.headers, body })
        if (href === 'https://github.example/login/oauth/access_token') {
            if (github.tokenAnswer) return Response.json(github.tokenAnswer.body, { status: github.tokenAnswer.status })
            github.issued += 1
            return Response.json({
                access_token: `ghu_access${github.issued}`,
                expires_in: 28800,
                refresh_token: `ghr_refresh${github.issued}`,
                refresh_token_expires_in: 15897600,
                token_type: 'bearer',
                scope: '',
            })
        }
        if (href === 'https://api.github.example/user') return Response.json(github.userAnswer.body, { status: github.userAnswer.status })
        return new Response('not found', { status: 404 })
    }
    return github
}

/** An Express-like response that records what the handler did. */
function fakeResponse() {
    const res = {
        statusCode: 200,
        headers: {},
        setHeader(name, value) {
            res.headers[name.toLowerCase()] = value
            return res
        },
        status(code) {
            res.statusCode = code
            return res
        },
        type(value) {
            res.contentType = value
            return res
        },
        send(body) {
            res.body = body
            return res
        },
        redirect(status, location) {
            res.statusCode = status
            res.location = location
            return res
        },
    }
    return res
}

let clock
let store
let gh
let github
let provider
let logs

beforeEach(() => {
    clock = 1_800_000_000_000
    const now = () => clock
    store = createStore({ file: ':memory:', key: KEY, now })
    gh = fakeGitHub()
    github = createGitHubClient({
        clientId: 'Iv1.nera',
        clientSecret: 'app-secret',
        redirectUri: CALLBACK,
        fetch: gh.fetch,
        webUrl: 'https://github.example',
        apiUrl: 'https://api.github.example',
        now,
    })
    logs = []
    provider = createProvider({ store, github, now, log: (line) => logs.push(line) })
    store.saveClient(CLIENT)
    store.saveClient(OTHER_CLIENT)
})

afterEach(() => {
    store.close()
})

/** The browser-binding token a response's `Set-Cookie` sets, or '' when it deletes it. */
function cookieToken(res) {
    const match = new RegExp(`^${CONSENT_COOKIE}=([^;]*);`).exec(res.headers['set-cookie'] ?? '')
    return match ? match[1] : undefined
}

/** A hidden form field of the consent page. */
function formField(html, name) {
    return new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1]
}

/**
 * Runs `/authorize` in one browser: returns the consent page and what that
 * browser now holds (its cookie header) and would post (state, csrf_token).
 */
async function openConsent(client = CLIENT, params = AUTH_PARAMS) {
    const res = fakeResponse()
    await provider.authorize(client, params, res)
    return {
        res,
        state: formField(res.body, 'state'),
        csrf: formField(res.body, 'csrf_token'),
        cookie: `other=1; ${CONSENT_COOKIE}=${cookieToken(res)}`,
    }
}

/** POSTs the consent form. */
async function consent({ state, csrf, cookie, decision = 'approve' }) {
    const res = fakeResponse()
    await provider.handleConsent({ body: { state, csrf_token: csrf, decision }, headers: { cookie } }, res)
    return res
}

/** GitHub's redirect back to our callback, in a browser holding `cookie`. */
async function callback(query, cookie) {
    const res = fakeResponse()
    await provider.handleGitHubCallback({ query, headers: { cookie } }, res)
    return res
}

/** Runs `/authorize` and Approve; returns the state sent to GitHub and the browser's cookie. */
async function startSignIn(params = AUTH_PARAMS) {
    const page = await openConsent(CLIENT, params)
    const res = await consent(page)
    return { state: new URL(res.location).searchParams.get('state'), cookie: page.cookie }
}

/** Runs the whole login and returns the code the client receives. */
async function signIn(params = AUTH_PARAMS) {
    const { state, cookie } = await startSignIn(params)
    const res = await callback({ code: 'gh-code', state }, cookie)
    return new URL(res.location).searchParams.get('code')
}

async function tokensFor(client = CLIENT) {
    const code = await signIn()
    return provider.exchangeAuthorizationCode(client, code, undefined, AUTH_PARAMS.redirectUri, RESOURCE)
}

async function oauthError(promise) {
    const error = await promise.then(() => null, (thrown) => thrown)
    expect(error, 'expected the call to fail').not.toBeNull()
    return error.errorCode ?? error.name
}

describe('GitHub web-flow client', () => {
    it('builds the authorize URL from the App and our callback', () => {
        const url = new URL(github.authorizeUrl('our-state'))
        expect(url.origin + url.pathname).toBe('https://github.example/login/oauth/authorize')
        expect(Object.fromEntries(url.searchParams)).toEqual({ client_id: 'Iv1.nera', redirect_uri: CALLBACK, state: 'our-state' })
    })

    it('exchanges a code and turns the lifetimes into expiry times', async () => {
        const tokens = await github.exchangeCode('gh-code')
        expect(gh.requests[0].body).toEqual({ client_id: 'Iv1.nera', client_secret: 'app-secret', code: 'gh-code', redirect_uri: CALLBACK })
        expect(gh.requests[0].headers.Accept).toBe('application/json')
        expect(tokens).toEqual({
            accessToken: 'ghu_access1',
            accessTokenExpiresAt: clock / 1000 + 28800,
            refreshToken: 'ghr_refresh1',
            refreshTokenExpiresAt: clock / 1000 + 15897600,
        })
    })

    it('refreshes with the refresh_token grant', async () => {
        await github.refresh('ghr_old')
        expect(gh.requests[0].body).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'ghr_old' })
    })

    it('treats GitHub\'s HTTP-200 error answer as a failure, without the token in the message', async () => {
        gh.tokenAnswer = { status: 200, body: { error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired.' } }
        const error = await github.exchangeCode('ghcode_secret').catch((thrown) => thrown)
        expect(error).toBeInstanceOf(GitHubError)
        expect(error.code).toBe('bad_verification_code')
        expect(error.message).not.toContain('ghcode_secret')
    })

    it('reads the user with the token as a bearer', async () => {
        expect(await github.getUser('ghu_x')).toEqual({ id: '4242', login: 'octo' })
        expect(gh.requests[0].headers.Authorization).toBe('Bearer ghu_x')
        gh.userAnswer = { status: 401, body: { message: 'Bad credentials' } }
        await expect(github.getUser('ghu_x')).rejects.toThrow(/HTTP 401/)
    })

    it('refuses to start without the App credentials', () => {
        expect(() => createGitHubClient({ clientId: 'x', redirectUri: CALLBACK })).toThrow(/client secret/)
    })
})

describe('clients store', () => {
    it('persists a registered client and reads it back with its secret', async () => {
        const registered = await provider.clientsStore.registerClient({ client_id: 'dcr-1', client_secret: 's3cret', redirect_uris: ['https://x.example/cb'] })
        expect(registered.client_id).toBe('dcr-1')
        expect(await provider.clientsStore.getClient('dcr-1')).toMatchObject({ client_id: 'dcr-1', client_secret: 's3cret' })
        expect(await provider.clientsStore.getClient('unknown')).toBeUndefined()
    })
})

describe('consent page', () => {
    it('shows our consent page instead of sending the user to GitHub', async () => {
        const { res, state, csrf } = await openConsent()
        expect(res.statusCode).toBe(200)
        expect(res.location).toBeUndefined()
        expect(res.contentType).toBe('html')
        expect(res.body).toContain('<span class="client">Claude</span>')
        expect(res.body).toContain('<span class="host">claude.ai</span>')
        expect(res.body).toMatch(/<form method="post" action="\/oauth\/consent">/)
        expect(state).not.toBe('client-state')
        expect(state.length).toBeGreaterThan(30)
        expect(csrf).toBe(cookieToken(res))
        expect(gh.requests).toEqual([])
    })

    it('binds the page to the browser with a __Host- cookie and forbids framing and caching', async () => {
        const { res } = await openConsent()
        expect(res.headers['set-cookie']).toMatch(new RegExp(`^${CONSENT_COOKIE}=[\\w-]{40,}; Max-Age=${TTL.pending}; Path=/; Secure; HttpOnly; SameSite=Lax$`))
        expect(res.headers['x-frame-options']).toBe('DENY')
        expect(res.headers['content-security-policy']).toMatch(/default-src 'none'/)
        expect(res.headers['content-security-policy']).toMatch(/frame-ancestors 'none'/)
        expect(res.headers['content-security-policy']).toMatch(/style-src 'sha256-[\w+/=]+'/)
        expect(res.headers['cache-control']).toBe('no-store')
    })

    it('escapes a client_name with markup and names a nameless client by its id', async () => {
        const evil = { ...CLIENT, client_id: 'client-evil', client_name: '<script>alert("x")</script><b>Claude</b>' }
        store.saveClient(evil)
        const { res } = await openConsent(evil)
        expect(res.body).not.toContain('<script>alert')
        expect(res.body).not.toContain('<b>Claude</b>')
        expect(res.body).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&lt;b&gt;Claude&lt;/b&gt;')

        const nameless = await openConsent(OTHER_CLIENT, { ...AUTH_PARAMS, redirectUri: OTHER_CLIENT.redirect_uris[0] })
        expect(nameless.res.body).toContain('An application without a name (client-b)')
        expect(nameless.res.body).toContain('<span class="host">chatgpt.com</span>')
    })

    it('sends only Approve on to GitHub, with our state, and only once', async () => {
        const page = await openConsent()
        const approved = await consent(page)
        expect(approved.statusCode).toBe(302)
        const url = new URL(approved.location)
        expect(url.origin + url.pathname).toBe('https://github.example/login/oauth/authorize')
        expect(url.searchParams.get('state')).toBe(page.state)
        expect(approved.headers['set-cookie']).toBeUndefined()

        const again = await consent(page)
        expect(again.statusCode).toBe(400)
        expect(again.location).toBeUndefined()
    })

    it('refuses a POST whose csrf_token is missing, wrong or not this browser\'s cookie', async () => {
        const page = await openConsent()
        for (const forged of [
            { ...page, csrf: undefined },
            { ...page, csrf: 'guessed' },
            { ...page, cookie: undefined },
            { ...page, cookie: `${CONSENT_COOKIE}=guessed`, csrf: 'guessed' },
            // Same string length as the cookie, more bytes: refused, not a thrown RangeError.
            { ...page, csrf: `é${page.csrf.slice(1)}` },
        ]) {
            const res = await consent(forged)
            expect(res.statusCode, JSON.stringify(forged)).toBeGreaterThanOrEqual(400)
            expect(res.location).toBeUndefined()
        }
        expect((await consent(page)).statusCode).toBe(302)
    })

    it('refuses a cross-site POST built from a consent page the attacker opened in their own browser', async () => {
        const attackers = await openConsent()
        const victims = await openConsent()
        // The forged form carries the attacker's state and csrf_token; the
        // victim's browser sends its own cookie, or none at all.
        for (const cookie of [victims.cookie, undefined]) {
            const res = await consent({ state: attackers.state, csrf: attackers.csrf, cookie })
            expect(res.statusCode).toBe(403)
            expect(res.body).toMatch(/did not come from the consent page/)
        }
        // A matching pair of the victim's cookie and csrf_token still does not approve the attacker's state.
        const res = await consent({ state: attackers.state, csrf: victims.csrf, cookie: victims.cookie })
        expect(res.statusCode).toBe(400)
        expect(store.getPending(attackers.state, cookieToken(attackers.res))).toMatchObject({ approved: false })
    })

    it('refuses an unknown or expired state and a missing decision', async () => {
        const page = await openConsent()
        expect((await consent({ ...page, state: 'made-up' })).statusCode).toBe(400)
        expect((await consent({ ...page, state: undefined })).statusCode).toBe(400)
        expect((await consent({ ...page, decision: 'maybe' })).statusCode).toBe(400)
        clock += (TTL.pending + 1) * 1000
        const expired = await consent(page)
        expect(expired.statusCode).toBe(400)
        expect(expired.body).toMatch(/Start the connection again/)
        expect(expired.headers['set-cookie']).toMatch(/Max-Age=0/)
    })

    it('answers Deny with access_denied and the client\'s state, and forgets the request', async () => {
        const page = await openConsent()
        const res = await consent({ ...page, decision: 'deny' })
        expect(res.statusCode).toBe(302)
        const url = new URL(res.location)
        expect(url.origin + url.pathname).toBe(AUTH_PARAMS.redirectUri)
        expect(url.searchParams.get('error')).toBe('access_denied')
        expect(url.searchParams.get('state')).toBe('client-state')
        expect(url.searchParams.get('code')).toBeNull()
        expect(res.headers['set-cookie']).toMatch(/Max-Age=0/)
        expect((await consent(page)).statusCode).toBe(400)
        expect((await callback({ code: 'gh-code', state: page.state }, page.cookie)).statusCode).toBe(400)
        expect(gh.requests).toEqual([])
    })
})

describe('the GitHub callback', () => {
    it('returns our code and the client\'s state to the client\'s redirect URI', async () => {
        const { state, cookie } = await startSignIn()
        const res = await callback({ code: 'gh-code', state }, cookie)
        const url = new URL(res.location)
        expect(res.statusCode).toBe(302)
        expect(url.origin + url.pathname).toBe(AUTH_PARAMS.redirectUri)
        expect(url.searchParams.get('state')).toBe('client-state')
        expect(url.searchParams.get('code')).toMatch(/^[\w-]{40,}$/)
        expect(res.headers['set-cookie']).toMatch(/Max-Age=0/)
        expect(store.getGithubUser('4242')).toMatchObject({ login: 'octo', accessToken: 'ghu_access1', refreshToken: 'ghr_refresh1' })
    })

    it('refuses a state nobody approved, without calling GitHub', async () => {
        const page = await openConsent()
        const res = await callback({ code: 'gh-code', state: page.state }, page.cookie)
        expect(res.statusCode).toBe(400)
        expect(res.location).toBeUndefined()
        expect(gh.requests).toEqual([])
        // The request is used up: approving it afterwards does not revive it.
        expect((await consent(page)).statusCode).toBe(400)
    })

    it('refuses a state approved in another browser, without calling GitHub', async () => {
        // The attacker approves their own request, then lures the victim
        // through GitHub with its state; the victim's browser lacks the cookie.
        const attackers = await startSignIn()
        const victims = await openConsent()
        for (const cookie of [victims.cookie, undefined]) {
            const res = await callback({ code: 'victim-gh-code', state: attackers.state }, cookie)
            expect(res.statusCode).toBe(400)
        }
        expect(gh.requests).toEqual([])
    })

    it('answers an unknown, reused or expired state with a 400 that says what to do', async () => {
        const unknown = await callback({ code: 'gh-code', state: 'made-up' })
        expect(unknown.statusCode).toBe(400)
        expect(unknown.body).toMatch(/Start the connection again/)

        const { state, cookie } = await startSignIn()
        await callback({ code: 'gh-code', state }, cookie)
        expect((await callback({ code: 'gh-code', state }, cookie)).statusCode).toBe(400)

        const late = await startSignIn()
        clock += (TTL.pending + 1) * 1000
        expect((await callback({ code: 'gh-code', state: late.state }, late.cookie)).statusCode).toBe(400)

        expect((await callback({})).statusCode).toBe(400)
        const noRequest = fakeResponse()
        await provider.handleGitHubCallback({}, noRequest)
        expect(noRequest.statusCode).toBe(400)
    })

    it('passes a GitHub denial on to the client as access_denied with its state', async () => {
        const { state, cookie } = await startSignIn()
        const res = await callback({ error: 'access_denied', error_description: 'The user has denied your application access.', state }, cookie)
        const url = new URL(res.location)
        expect(url.origin + url.pathname).toBe(AUTH_PARAMS.redirectUri)
        expect(url.searchParams.get('error')).toBe('access_denied')
        expect(url.searchParams.get('state')).toBe('client-state')
        expect(url.searchParams.get('code')).toBeNull()
        expect(gh.requests).toEqual([])
    })

    it('reports a failed GitHub exchange as server_error and logs no secret', async () => {
        gh.tokenAnswer = { status: 200, body: { error: 'bad_verification_code' } }
        const { state, cookie } = await startSignIn()
        const res = await callback({ code: 'gh-code', state }, cookie)
        const url = new URL(res.location)
        expect(url.searchParams.get('error')).toBe('server_error')
        expect(url.searchParams.get('state')).toBe('client-state')
        expect(logs.join('\n')).toContain('bad_verification_code')
        expect(logs.join('\n')).not.toMatch(/gh-code|app-secret|ghu_/)
    })

    it('reports a callback without code as server_error', async () => {
        const { state, cookie } = await startSignIn()
        const res = await callback({ state }, cookie)
        expect(new URL(res.location).searchParams.get('error')).toBe('server_error')
    })
})

describe('authorization code', () => {
    it('yields the PKCE challenge of its request to its own client only', async () => {
        const code = await signIn()
        expect(await provider.challengeForAuthorizationCode(CLIENT, code)).toBe('the-challenge')
        expect(await oauthError(provider.challengeForAuthorizationCode(OTHER_CLIENT, code))).toBe('invalid_grant')
    })

    it('exchanges for a token pair bound to client, user and resource', async () => {
        const tokens = await tokensFor()
        expect(tokens).toMatchObject({ token_type: 'Bearer', expires_in: TTL.access, scope: 'mcp' })
        const auth = await provider.verifyAccessToken(tokens.access_token)
        expect(auth).toMatchObject({ clientId: 'client-a', scopes: ['mcp'], extra: { userId: '4242' } })
        expect(auth.resource.href).toBe(RESOURCE.href)
        expect(auth.expiresAt).toBe(clock / 1000 + TTL.access)
    })

    it('works once only', async () => {
        const code = await signIn()
        await provider.exchangeAuthorizationCode(CLIENT, code, undefined, AUTH_PARAMS.redirectUri, RESOURCE)
        expect(await oauthError(provider.exchangeAuthorizationCode(CLIENT, code, undefined, AUTH_PARAMS.redirectUri, RESOURCE))).toBe('invalid_grant')
        expect(await oauthError(provider.challengeForAuthorizationCode(CLIENT, code))).toBe('invalid_grant')
    })

    it('is refused for another client, another redirect URI or another resource, and burnt by the attempt', async () => {
        const stolen = await signIn()
        expect(await oauthError(provider.exchangeAuthorizationCode(OTHER_CLIENT, stolen, undefined, AUTH_PARAMS.redirectUri, RESOURCE))).toBe('invalid_grant')
        expect(await oauthError(provider.exchangeAuthorizationCode(CLIENT, stolen, undefined, AUTH_PARAMS.redirectUri, RESOURCE))).toBe('invalid_grant')

        const redirected = await signIn()
        expect(await oauthError(provider.exchangeAuthorizationCode(CLIENT, redirected, undefined, 'https://evil.example/cb', RESOURCE))).toBe('invalid_grant')

        const retargeted = await signIn()
        expect(await oauthError(provider.exchangeAuthorizationCode(CLIENT, retargeted, undefined, AUTH_PARAMS.redirectUri, new URL('https://other.example/mcp')))).toBe('invalid_target')
    })

    it('keeps the request\'s resource when the token request names none', async () => {
        const code = await signIn()
        const tokens = await provider.exchangeAuthorizationCode(CLIENT, code)
        expect((await provider.verifyAccessToken(tokens.access_token)).resource.href).toBe(RESOURCE.href)
    })

    it('expires after ten minutes', async () => {
        const code = await signIn()
        clock += (TTL.code + 1) * 1000
        expect(await oauthError(provider.exchangeAuthorizationCode(CLIENT, code))).toBe('invalid_grant')
    })
})

describe('tokens', () => {
    it('refuses an unknown, a refresh and an expired token as access token', async () => {
        const tokens = await tokensFor()
        expect(await oauthError(provider.verifyAccessToken('made-up'))).toBe('invalid_token')
        expect(await oauthError(provider.verifyAccessToken(tokens.refresh_token))).toBe('invalid_token')
        clock += (TTL.access + 1) * 1000
        expect(await oauthError(provider.verifyAccessToken(tokens.access_token))).toBe('invalid_token')
    })

    it('rotates the refresh token and refuses the old one', async () => {
        const first = await tokensFor()
        const second = await provider.exchangeRefreshToken(CLIENT, first.refresh_token)
        expect(second.refresh_token).not.toBe(first.refresh_token)
        expect(await provider.verifyAccessToken(second.access_token)).toMatchObject({ clientId: 'client-a', extra: { userId: '4242' } })
        const replay = await provider.exchangeRefreshToken(CLIENT, first.refresh_token).catch((thrown) => thrown)
        expect(replay.errorCode).toBe('invalid_grant')
        expect(replay.message).toMatch(/Sign in again/)
    })

    it('refuses another client\'s refresh token and a wider scope', async () => {
        const tokens = await tokensFor()
        expect(await oauthError(provider.exchangeRefreshToken(OTHER_CLIENT, tokens.refresh_token))).toBe('invalid_grant')
        expect(await oauthError(provider.exchangeRefreshToken(CLIENT, tokens.refresh_token, ['mcp', 'admin']))).toBe('invalid_grant')
        await expect(provider.exchangeRefreshToken(CLIENT, tokens.refresh_token, ['mcp'])).resolves.toMatchObject({ scope: 'mcp' })
    })

    it('refuses a refresh for another resource and leaves no usable pair behind', async () => {
        const tokens = await tokensFor()
        expect(await oauthError(provider.exchangeRefreshToken(CLIENT, tokens.refresh_token, undefined, new URL('https://other.example/mcp')))).toBe('invalid_target')
        expect(await oauthError(provider.exchangeRefreshToken(CLIENT, tokens.refresh_token))).toBe('invalid_grant')
    })

    it('revokes an access or refresh token of the calling client only', async () => {
        const tokens = await tokensFor()
        await provider.revokeToken(OTHER_CLIENT, { token: tokens.access_token })
        await expect(provider.verifyAccessToken(tokens.access_token)).resolves.toBeTruthy()
        await provider.revokeToken(CLIENT, { token: tokens.access_token })
        expect(await oauthError(provider.verifyAccessToken(tokens.access_token))).toBe('invalid_token')
        await provider.revokeToken(CLIENT, { token: tokens.refresh_token })
        expect(await oauthError(provider.exchangeRefreshToken(CLIENT, tokens.refresh_token))).toBe('invalid_grant')
        await expect(provider.revokeToken(CLIENT, { token: 'made-up' })).resolves.toBeUndefined()
    })
})

describe('githubToken', () => {
    it('returns the saved token while it is valid, without calling GitHub', async () => {
        await signIn()
        const calls = gh.requests.length
        expect(await provider.githubToken('4242')).toBe('ghu_access1')
        expect(gh.requests.length).toBe(calls)
    })

    it('refreshes a token about to expire once, also for concurrent calls, and saves the new pair', async () => {
        await signIn()
        clock += (28800 - 60) * 1000
        const [a, b] = await Promise.all([provider.githubToken('4242'), provider.githubToken('4242')])
        expect([a, b]).toEqual(['ghu_access2', 'ghu_access2'])
        const refreshes = gh.requests.filter((request) => request.body?.grant_type === 'refresh_token')
        expect(refreshes).toHaveLength(1)
        expect(refreshes[0].body.refresh_token).toBe('ghr_refresh1')
        expect(store.getGithubUser('4242')).toMatchObject({ accessToken: 'ghu_access2', refreshToken: 'ghr_refresh2' })
    })

    it('says "sign in again" when GitHub refuses the refresh', async () => {
        await signIn()
        clock += 28800 * 1000
        gh.tokenAnswer = { status: 200, body: { error: 'bad_refresh_token' } }
        const error = await provider.githubToken('4242').catch((thrown) => thrown)
        expect(error).toBeInstanceOf(SignInRequiredError)
        expect(error.message).toMatch(/Sign in again/)
        expect(logs.join('\n')).toContain('bad_refresh_token')
        expect(logs.join('\n')).not.toMatch(/ghr_|ghu_/)
    })

    it('says "sign in again" when the refresh token has expired or the user is unknown', async () => {
        await signIn()
        clock += 15897600 * 1000
        await expect(provider.githubToken('4242')).rejects.toThrow(SignInRequiredError)
        await expect(provider.githubToken('9999')).rejects.toThrow(/Sign in again/)
        expect(gh.requests.some((request) => request.body?.grant_type === 'refresh_token')).toBe(false)
    })
})
