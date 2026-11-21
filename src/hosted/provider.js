// The hosted mode's OAuth 2.1 authorization server logic (L7b, plan D1/D4):
// the `OAuthServerProvider` the SDK's `mcpAuthRouter` drives, over the token
// store. We are the authorization server for claude.ai and ChatGPT (they
// register via DCR), and delegate the login itself to GitHub:
//
//   client → /authorize → authorize() saves the request, shows our consent
//            page (src/hosted/consent.js) and sets the browser cookie
//   user   → POST /oauth/consent → handleConsent(): Approve redirects to
//            GitHub, Deny back to the client with `access_denied`
//   GitHub → /oauth/github/callback → handleGitHubCallback() takes only an
//            approved request of the same browser, saves the GitHub user,
//            issues our code, redirects to the client with its `state`
//   client → /token → challengeForAuthorizationCode() (the SDK checks PKCE),
//            then exchangeAuthorizationCode() / exchangeRefreshToken()
//
// A code is bound to the client, its redirect URI, its PKCE challenge and its
// resource, and is single use; refresh tokens rotate on every use. The GitHub
// user token stays on the server — `githubToken(userId)` hands it to the tools
// and refreshes it when it is about to expire. No token is ever logged.
import { timingSafeEqual } from 'node:crypto'
import { InvalidGrantError, InvalidTargetError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js'
import { CONSENT_HEADERS, consentCookie, readConsentCookie, renderConsentPage } from './consent.js'
import { TTL } from './store.js'

/** Refresh the GitHub token this many seconds before it expires. */
const GITHUB_REFRESH_MARGIN = 5 * 60

/** Shown when the GitHub callback cannot be tied to a client's request. */
const EXPIRED_SIGN_IN = 'This sign-in link has expired or was already used. Start the connection again from your AI assistant.'

/** Shown when a consent POST does not come from the page this browser was shown. */
const FOREIGN_CONSENT = 'This approval did not come from the consent page shown in this browser, so it was refused. Start the connection again from your AI assistant.'

/** True for two equal non-empty strings, compared in constant time. */
function sameToken(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || !a) return false
    // Compare byte lengths: a non-ASCII field of the same string length would make timingSafeEqual throw.
    const left = Buffer.from(a)
    const right = Buffer.from(b)
    return left.length === right.length && timingSafeEqual(left, right)
}

/** The user has to sign in with GitHub again; the message says so. */
export class SignInRequiredError extends Error {
    constructor(message) {
        super(message)
        this.name = 'SignInRequiredError'
    }
}

/**
 * Creates the provider.
 *
 * @param {object} options
 * @param {ReturnType<import('./store.js').createStore>} options.store
 * @param {ReturnType<import('./github.js').createGitHubClient>} options.github
 * @param {() => number} [options.now] the clock in milliseconds
 * @param {(message: string) => void} [options.log] where failures are reported (never with a token in them)
 */
export function createProvider({ store, github, now = Date.now, log = () => {} }) {
    const seconds = () => Math.floor(now() / 1000)
    /** In-flight GitHub refreshes per user: GitHub rotates the refresh token, so a second concurrent refresh would fail. */
    const refreshing = new Map()

    const clientsStore = {
        getClient: (clientId) => store.getClient(clientId),
        // The SDK's `/register` handler has already validated the metadata and
        // filled in `client_id`, `client_id_issued_at` and the secret.
        registerClient: (client) => store.saveClient(client),
    }

    /**
     * Redirects to the client's redirect URI with an OAuth result.
     *
     * @param {import('express').Response} res
     * @param {string} redirectUri
     * @param {Record<string, string|undefined>} params
     */
    function redirectToClient(res, redirectUri, params) {
        res.setHeader('Set-Cookie', consentCookie('', 0))
        const url = new URL(redirectUri)
        for (const [name, value] of Object.entries(params)) {
            if (value !== undefined) url.searchParams.set(name, value)
        }
        res.redirect(302, url.href)
    }

    /**
     * An error page of the consent flow, uncached and unframeable.
     *
     * @param {import('express').Response} res
     * @param {number} status
     * @param {string} message
     */
    function errorPage(res, status, message) {
        for (const [name, value] of Object.entries(CONSENT_HEADERS)) res.setHeader(name, value)
        res.setHeader('Set-Cookie', consentCookie('', 0))
        res.status(status).type('text/plain').send(message)
    }

    /** Our token response (RFC 6749 §5.1) for a pair from the store. */
    function tokenResponse(tokens) {
        return {
            access_token: tokens.accessToken,
            token_type: 'Bearer',
            expires_in: tokens.expiresIn,
            refresh_token: tokens.refreshToken,
            ...(tokens.scopes.length ? { scope: tokens.scopes.join(' ') } : {}),
        }
    }

    /** True when a requested resource names a different one than the grant's. */
    const otherResource = (requested, granted) => requested !== undefined && granted !== undefined && requested.href !== new URL(granted).href

    /**
     * The code's record when it belongs to this client and is still valid.
     *
     * @param {object|null} record from the store
     * @param {{client_id: string}} client
     */
    function ownCode(record, client) {
        if (!record || record.clientId !== client.client_id) throw new InvalidGrantError('The authorization code is invalid, expired or was already used.')
        return record
    }

    async function refreshGitHubToken(user) {
        try {
            const tokens = await github.refresh(user.refreshToken)
            store.saveGithubUser({ id: user.id, login: user.login, ...tokens })
            return tokens.accessToken
        } catch (error) {
            log(`GitHub token refresh failed for user ${user.id}: ${error.code || error.message}`)
            throw new SignInRequiredError('GitHub no longer accepts the saved sign-in. Sign in again: remove the Nera connector in your AI assistant and connect it once more.')
        }
    }

    return {
        get clientsStore() {
            return clientsStore
        },

        /**
         * Starts the login: remembers the client's request under a fresh state
         * and shows our consent page, bound to this browser by a cookie. Nobody
         * goes to GitHub before they approve (the confused-deputy guard).
         */
        async authorize(client, params, res) {
            const { state, browserToken } = store.savePending({
                clientId: client.client_id,
                params: {
                    codeChallenge: params.codeChallenge,
                    redirectUri: params.redirectUri,
                    state: params.state,
                    scopes: params.scopes ?? [],
                    resource: params.resource?.href,
                },
            })
            for (const [name, value] of Object.entries(CONSENT_HEADERS)) res.setHeader(name, value)
            res.setHeader('Set-Cookie', consentCookie(browserToken, TTL.pending))
            res.status(200).type('html').send(renderConsentPage({
                clientName: client.client_name,
                clientId: client.client_id,
                redirectUri: params.redirectUri,
                state,
                csrfToken: browserToken,
            }))
        },

        /**
         * The consent form's POST (`/oauth/consent`, urlencoded body). The
         * form's `csrf_token` must equal this browser's consent cookie, and the
         * cookie must be the one the state was issued to — a page opened in an
         * attacker's browser cannot be approved from the victim's. Approve
         * redirects to GitHub, Deny to the client with `access_denied`.
         *
         * @param {{body?: Record<string, unknown>, headers?: Record<string, unknown>}} req
         * @param {import('express').Response} res
         */
        async handleConsent(req, res) {
            const field = (name) => (typeof req.body?.[name] === 'string' ? req.body[name] : undefined)
            const browserToken = readConsentCookie(req.headers?.cookie)
            const state = field('state')
            if (!state) {
                errorPage(res, 400, EXPIRED_SIGN_IN)
                return
            }
            if (!sameToken(field('csrf_token'), browserToken)) {
                errorPage(res, 403, FOREIGN_CONSENT)
                return
            }
            const decision = field('decision')
            if (decision === 'deny') {
                const pending = store.takePending(state, browserToken)
                if (!pending) {
                    errorPage(res, 400, EXPIRED_SIGN_IN)
                    return
                }
                redirectToClient(res, pending.params.redirectUri, { error: 'access_denied', error_description: 'The connection was denied on the consent page.', state: pending.params.state })
                return
            }
            if (decision !== 'approve') {
                errorPage(res, 400, 'The consent form was sent without Approve or Deny. Start the connection again from your AI assistant.')
                return
            }
            if (!store.approvePending(state, browserToken)) {
                errorPage(res, 400, EXPIRED_SIGN_IN)
                return
            }
            res.redirect(302, github.authorizeUrl(state))
        },

        /**
         * GitHub's redirect back to us (`/oauth/github/callback`). Ends with a
         * redirect to the client — our code and its `state`, or an OAuth error —
         * or, when the state is unknown, was never approved or was approved in
         * another browser (we cannot know where to send the user safely), a 400
         * page that says what to do.
         *
         * @param {{query?: Record<string, unknown>, headers?: Record<string, unknown>}} req
         * @param {import('express').Response} res
         */
        async handleGitHubCallback(req, res) {
            const text = (name) => (typeof req.query?.[name] === 'string' ? req.query[name] : undefined)
            const browserToken = readConsentCookie(req.headers?.cookie)
            const pending = text('state') ? store.takePending(text('state'), browserToken) : null
            if (!pending?.approved) {
                errorPage(res, 400, EXPIRED_SIGN_IN)
                return
            }
            const { clientId, params } = pending
            const fail = (error, description) => redirectToClient(res, params.redirectUri, { error, error_description: description, state: params.state })

            if (text('error')) {
                if (text('error') === 'access_denied') fail('access_denied', 'The GitHub sign-in was cancelled.')
                else fail('server_error', `GitHub reported an error during sign-in: ${text('error')}.`)
                return
            }
            if (!text('code')) {
                fail('server_error', 'GitHub returned without an authorization code.')
                return
            }

            let user
            try {
                const tokens = await github.exchangeCode(text('code'))
                const profile = await github.getUser(tokens.accessToken)
                user = { ...profile, ...tokens }
            } catch (error) {
                log(`GitHub sign-in failed: ${error.code || error.message}`)
                fail('server_error', 'The GitHub sign-in could not be completed. Try connecting again.')
                return
            }
            store.saveGithubUser(user)
            const code = store.saveCode({ clientId, userId: user.id, params })
            redirectToClient(res, params.redirectUri, { code, state: params.state })
        },

        /** The PKCE challenge of the code's request, for the SDK's check. */
        async challengeForAuthorizationCode(client, authorizationCode) {
            return ownCode(store.getCode(authorizationCode), client).codeChallenge
        },

        /**
         * Exchanges a code for our tokens. The code is used up first, so even
         * a request that fails the checks below cannot try it again.
         */
        async exchangeAuthorizationCode(client, authorizationCode, _codeVerifier, redirectUri, resource) {
            const record = ownCode(store.takeCode(authorizationCode), client)
            if (redirectUri !== undefined && redirectUri !== record.redirectUri) {
                throw new InvalidGrantError('redirect_uri does not match the one of the authorization request.')
            }
            if (otherResource(resource, record.resource)) {
                throw new InvalidTargetError('resource does not match the one of the authorization request.')
            }
            const tokens = store.issueTokens({
                clientId: client.client_id,
                userId: record.userId,
                scopes: record.scopes ?? [],
                resource: record.resource ?? resource?.href,
            })
            return tokenResponse(tokens)
        },

        /** Rotates a refresh token: the old one is refused from now on. */
        async exchangeRefreshToken(client, refreshToken, scopes, resource) {
            const tokens = store.rotateRefreshToken(refreshToken, { clientId: client.client_id, scopes })
            if (!tokens) throw new InvalidGrantError('The refresh token is invalid, expired or was already used. Sign in again.')
            const granted = store.getAccessToken(tokens.accessToken)
            if (otherResource(resource, granted.resource)) {
                store.revokeToken(tokens.accessToken, { clientId: client.client_id })
                store.revokeToken(tokens.refreshToken, { clientId: client.client_id })
                throw new InvalidTargetError('resource does not match the one the refresh token was issued for. Sign in again.')
            }
            return tokenResponse(tokens)
        },

        /** What `requireBearerAuth` checks; the user id travels in `extra`. */
        async verifyAccessToken(token) {
            const record = store.getAccessToken(token)
            if (!record) throw new InvalidTokenError('The access token is invalid, expired or revoked.')
            return {
                token,
                clientId: record.clientId,
                scopes: record.scopes,
                expiresAt: record.expiresAt,
                resource: record.resource ? new URL(record.resource) : undefined,
                extra: { userId: record.userId },
            }
        },

        /** RFC 7009: an unknown or another client's token is silently ignored. */
        async revokeToken(client, request) {
            store.revokeToken(request.token, { clientId: client.client_id })
        },

        /**
         * The user's GitHub token for the tools, refreshed when it expires
         * within five minutes.
         *
         * @param {string} userId
         * @returns {Promise<string>}
         * @throws {SignInRequiredError} when there is no usable sign-in left
         */
        async githubToken(userId) {
            const user = store.getGithubUser(userId)
            if (!user) throw new SignInRequiredError('No GitHub sign-in is saved for this user. Sign in again by reconnecting the Nera connector.')
            if (user.accessTokenExpiresAt === undefined || user.accessTokenExpiresAt > seconds() + GITHUB_REFRESH_MARGIN) return user.accessToken
            if (!user.refreshToken || (user.refreshTokenExpiresAt !== undefined && user.refreshTokenExpiresAt <= seconds())) {
                throw new SignInRequiredError('The GitHub sign-in has expired. Sign in again: remove the Nera connector in your AI assistant and connect it once more.')
            }
            if (!refreshing.has(user.id)) {
                refreshing.set(user.id, refreshGitHubToken(user).finally(() => refreshing.delete(user.id)))
            }
            return refreshing.get(user.id)
        },
    }
}
