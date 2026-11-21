// The GitHub side of the hosted mode's login (L7b, plan D4): the web flow of
// the GitHub App "Nera Static". Our `/authorize` sends the user to GitHub,
// GitHub sends them back to our callback with a code, and this client turns
// that code into a user token and reads who the user is. GitHub App user tokens
// expire (8 h) and come with a refresh token (6 months) that GitHub rotates on
// every use. Every call goes through the injected `fetch`, so tests never touch
// the network; no token ever appears in an error message.

const USER_AGENT = 'nera-mcp'
const API_VERSION = '2022-11-28'

/** A failed call to GitHub; `code` is GitHub's own error code when it sent one. */
export class GitHubError extends Error {
    /**
     * @param {string} message
     * @param {{code?: string, status?: number}} [details]
     */
    constructor(message, { code, status } = {}) {
        super(message)
        this.name = 'GitHubError'
        this.code = code
        this.status = status
    }
}

/**
 * @typedef {object} GitHubTokens a user token as we keep it; times in seconds since the epoch
 * @property {string} accessToken
 * @property {number} [accessTokenExpiresAt] absent when the App issues non-expiring tokens
 * @property {string} [refreshToken]
 * @property {number} [refreshTokenExpiresAt]
 */

/**
 * Creates the GitHub web-flow client.
 *
 * @param {object} options
 * @param {string} options.clientId the GitHub App's client ID
 * @param {string} options.clientSecret the GitHub App's client secret
 * @param {string} options.redirectUri our callback, as registered in the App
 * @param {typeof fetch} [options.fetch]
 * @param {string} [options.webUrl] `https://github.com`, overridable for tests
 * @param {string} [options.apiUrl] `https://api.github.com`, overridable for tests
 * @param {() => number} [options.now] the clock in milliseconds
 */
export function createGitHubClient({
    clientId,
    clientSecret,
    redirectUri,
    fetch = globalThis.fetch,
    webUrl = 'https://github.com',
    apiUrl = 'https://api.github.com',
    now = Date.now,
}) {
    if (!clientId || !clientSecret || !redirectUri) {
        throw new Error('The GitHub client needs the App\'s client ID, its client secret and our callback URL.')
    }

    const seconds = () => Math.floor(now() / 1000)

    /**
     * POSTs to GitHub's token endpoint. GitHub answers errors there with
     * HTTP 200 and an `error` field, so both cases are checked.
     *
     * @param {Record<string, string>} fields
     * @returns {Promise<GitHubTokens>}
     */
    async function tokenRequest(fields) {
        const issuedAt = seconds()
        let response
        try {
            response = await fetch(new URL('/login/oauth/access_token', webUrl), {
                method: 'POST',
                headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
                body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...fields }),
            })
        } catch (error) {
            throw new GitHubError(`Cannot reach GitHub: ${error.message}`)
        }
        const body = await response.json().catch(() => ({}))
        if (!response.ok || body.error || !body.access_token) {
            const code = body.error || undefined
            const reason = body.error_description || code || `HTTP ${response.status}`
            throw new GitHubError(`GitHub refused the token request: ${reason}`, { code, status: response.status })
        }
        return {
            accessToken: body.access_token,
            accessTokenExpiresAt: body.expires_in ? issuedAt + Number(body.expires_in) : undefined,
            refreshToken: body.refresh_token || undefined,
            refreshTokenExpiresAt: body.refresh_token_expires_in ? issuedAt + Number(body.refresh_token_expires_in) : undefined,
        }
    }

    return {
        /**
         * Where to send the user to sign in.
         *
         * @param {string} state our own state, which GitHub hands back to the callback
         * @returns {string}
         */
        authorizeUrl(state) {
            const url = new URL('/login/oauth/authorize', webUrl)
            url.searchParams.set('client_id', clientId)
            url.searchParams.set('redirect_uri', redirectUri)
            url.searchParams.set('state', state)
            return url.href
        },

        /**
         * Exchanges the code GitHub sent to our callback for a user token.
         *
         * @param {string} code
         * @returns {Promise<GitHubTokens>}
         */
        exchangeCode(code) {
            return tokenRequest({ code, redirect_uri: redirectUri })
        },

        /**
         * Trades a refresh token for a new user token (and a new refresh token:
         * GitHub invalidates the old one).
         *
         * @param {string} refreshToken
         * @returns {Promise<GitHubTokens>}
         */
        refresh(refreshToken) {
            return tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken })
        },

        /**
         * Reads the signed-in user.
         *
         * @param {string} accessToken
         * @returns {Promise<{id: string, login: string}>}
         */
        async getUser(accessToken) {
            let response
            try {
                response = await fetch(new URL('/user', apiUrl), {
                    headers: {
                        Accept: 'application/vnd.github+json',
                        Authorization: `Bearer ${accessToken}`,
                        'User-Agent': USER_AGENT,
                        'X-GitHub-Api-Version': API_VERSION,
                    },
                })
            } catch (error) {
                throw new GitHubError(`Cannot reach GitHub: ${error.message}`)
            }
            const body = await response.json().catch(() => ({}))
            if (!response.ok || body.id === undefined || !body.login) {
                throw new GitHubError(`GitHub did not return the signed-in user (HTTP ${response.status}).`, { status: response.status })
            }
            return { id: String(body.id), login: body.login }
        },
    }
}
