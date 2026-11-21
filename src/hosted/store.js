// The hosted mode's persistent state (L7b), one SQLite file via `node:sqlite`:
// registered OAuth clients, pending authorizations (from our `/authorize`
// through the consent page to GitHub's callback), authorization codes, our
// access and refresh tokens, and the GitHub users with their tokens.
//
// What reaches the file: our codes, tokens, the GitHub `state` and the consent
// page's browser token only as SHA-256 hashes (they are looked up, never read
// back); GitHub's tokens and a client's secret AES-256-GCM-encrypted (they
// must be read back).
//
// Every code and the tokens issued from it share a `grant_id`, kept through
// every refresh rotation. A used code and a rotated refresh token leave a
// tombstone (their hash, the grant id, the expiry they had), so presenting
// one again is recognised as a replay and revokes the whole grant (OAuth 2.1's
// code reuse rule, the Security BCP's refresh-token reuse detection). Only the
// hosted mode loads this module — `node:sqlite` needs Node >= 22.13, while the
// stdio server (`src/server.js`) stays on the package's 22.12 floor.
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { chmodSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { decrypt, encrypt, hashToken, parseKey, randomToken } from './crypto.js'

/** Lifetimes in seconds (plan D3). */
export const TTL = Object.freeze({
    pending: 10 * 60,
    code: 10 * 60,
    access: 60 * 60,
    refresh: 30 * 24 * 60 * 60,
})

const SCHEMA = `
CREATE TABLE IF NOT EXISTS clients (
    client_id TEXT PRIMARY KEY,
    info TEXT NOT NULL,
    secret TEXT
);
CREATE TABLE IF NOT EXISTS pending (
    state_hash TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    params TEXT NOT NULL,
    browser_hash TEXT NOT NULL,
    approved INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS codes (
    code_hash TEXT PRIMARY KEY,
    grant_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    params TEXT NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tokens (
    token_hash TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
    grant_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    scopes TEXT NOT NULL,
    resource TEXT,
    expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tokens_grant ON tokens (grant_id);
CREATE TABLE IF NOT EXISTS tombstones (
    hash TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('code', 'refresh')),
    grant_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS github_users (
    user_id TEXT PRIMARY KEY,
    login TEXT NOT NULL,
    access_token TEXT NOT NULL,
    access_expires_at INTEGER,
    refresh_token TEXT,
    refresh_expires_at INTEGER,
    updated_at INTEGER NOT NULL
);
`

/**
 * @typedef {object} AuthorizationRecord the part of a client's `/authorize`
 *   request that the code exchange checks later
 * @property {string} codeChallenge
 * @property {string} redirectUri
 * @property {string} [state] the client's own state
 * @property {string[]} [scopes]
 * @property {string} [resource]
 */

/**
 * Opens (and creates, if needed) the store.
 *
 * @param {object} options
 * @param {string} options.file the SQLite file, or `:memory:`
 * @param {string|Buffer} options.key the token key (`parseKey`)
 * @param {() => number} [options.now] the clock in milliseconds, for tests
 */
export function createStore({ file, key, now = Date.now }) {
    const secretKey = parseKey(key)
    const db = new DatabaseSync(file)
    if (file !== ':memory:') {
        try {
            chmodSync(file, 0o600)
        } catch {
            // Windows has no POSIX modes; the file stays as the OS created it.
        }
    }
    db.exec('PRAGMA journal_mode = WAL')
    db.exec(SCHEMA)

    const seconds = () => Math.floor(now() / 1000)
    const statements = {
        getClient: db.prepare('SELECT info, secret FROM clients WHERE client_id = ?'),
        saveClient: db.prepare('INSERT OR REPLACE INTO clients (client_id, info, secret) VALUES (?, ?, ?)'),
        savePending: db.prepare('INSERT INTO pending (state_hash, client_id, params, browser_hash, expires_at) VALUES (?, ?, ?, ?, ?)'),
        getPending: db.prepare('SELECT client_id, params, browser_hash, approved, expires_at FROM pending WHERE state_hash = ?'),
        approvePending: db.prepare('UPDATE pending SET approved = 1 WHERE state_hash = ? AND approved = 0'),
        takePending: db.prepare('DELETE FROM pending WHERE state_hash = ? RETURNING client_id, params, browser_hash, approved, expires_at'),
        saveCode: db.prepare('INSERT INTO codes (code_hash, grant_id, client_id, user_id, params, expires_at) VALUES (?, ?, ?, ?, ?, ?)'),
        getCode: db.prepare('SELECT grant_id, client_id, user_id, params, expires_at FROM codes WHERE code_hash = ?'),
        takeCode: db.prepare('DELETE FROM codes WHERE code_hash = ? RETURNING grant_id, client_id, user_id, params, expires_at'),
        saveToken: db.prepare('INSERT INTO tokens (token_hash, kind, grant_id, client_id, user_id, scopes, resource, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
        getToken: db.prepare('SELECT kind, grant_id, client_id, user_id, scopes, resource, expires_at FROM tokens WHERE token_hash = ?'),
        deleteToken: db.prepare('DELETE FROM tokens WHERE token_hash = ?'),
        revokeGrant: db.prepare('DELETE FROM tokens WHERE grant_id = ?'),
        saveTombstone: db.prepare('INSERT OR REPLACE INTO tombstones (hash, kind, grant_id, expires_at) VALUES (?, ?, ?, ?)'),
        getTombstone: db.prepare('SELECT kind, grant_id, expires_at FROM tombstones WHERE hash = ?'),
        revokeToken: db.prepare('DELETE FROM tokens WHERE token_hash = ? AND client_id = ?'),
        saveGithubUser: db.prepare(`INSERT OR REPLACE INTO github_users
            (user_id, login, access_token, access_expires_at, refresh_token, refresh_expires_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`),
        getGithubUser: db.prepare('SELECT * FROM github_users WHERE user_id = ?'),
        purge: ['pending', 'codes', 'tokens', 'tombstones'].map((table) => db.prepare(`DELETE FROM ${table} WHERE expires_at <= ?`)),
    }

    const live = (row) => (row && row.expires_at > seconds() ? row : null)
    /** True when the browser token hashes to the one stored with the pending row. */
    const sameBrowser = (row, browserToken) => typeof browserToken === 'string' && timingSafeEqual(Buffer.from(hashToken(browserToken)), Buffer.from(row.browser_hash))
    /** A live pending row of this browser as a record, else null. */
    const pendingRecord = (row, browserToken) => {
        const own = live(row)
        if (!own || !sameBrowser(own, browserToken)) return null
        return { clientId: own.client_id, params: JSON.parse(own.params), approved: own.approved === 1 }
    }
    const codeRecord = (row) => row && { grantId: row.grant_id, clientId: row.client_id, userId: row.user_id, ...JSON.parse(row.params), expiresAt: row.expires_at }
    const tokenRecord = (row) => row && {
        kind: row.kind,
        clientId: row.client_id,
        userId: row.user_id,
        scopes: JSON.parse(row.scopes),
        resource: row.resource ?? undefined,
        expiresAt: row.expires_at,
    }

    /**
     * Marks a used code or a rotated refresh token, so presenting it again is
     * recognised as a replay until the moment it would have expired anyway.
     * Only its hash is kept, as in `codes` and `tokens`.
     *
     * @param {string} hash
     * @param {'code'|'refresh'} kind
     * @param {{grant_id: string, expires_at: number}} row the used code's or token's row
     */
    function bury(hash, kind, row) {
        statements.saveTombstone.run(hash, kind, row.grant_id, row.expires_at)
    }

    /**
     * When `hash` is a used code or rotated refresh token of `kind` presented
     * again, revokes every token of its grant: one of the two holders is not
     * the legitimate client, and we cannot tell which.
     *
     * @param {string} hash
     * @param {'code'|'refresh'} kind
     */
    function revokeOnReplay(hash, kind) {
        const tombstone = live(statements.getTombstone.get(hash))
        if (tombstone?.kind === kind) statements.revokeGrant.run(tombstone.grant_id)
    }

    /**
     * Issues a fresh access + refresh token pair; only their hashes are stored.
     *
     * @param {{clientId: string, userId: string, scopes?: string[], resource?: string, grantId?: string}} grant
     *   `grantId` ties the pair to its code and earlier rotations; a new grant when absent
     */
    function issueTokens({ clientId, userId, scopes = [], resource, grantId = randomUUID() }) {
        const issued = seconds()
        const accessToken = randomToken()
        const refreshToken = randomToken()
        const accessExpiresAt = issued + TTL.access
        const refreshExpiresAt = issued + TTL.refresh
        const scopesJson = JSON.stringify(scopes)
        statements.saveToken.run(hashToken(accessToken), 'access', grantId, clientId, String(userId), scopesJson, resource ?? null, accessExpiresAt)
        statements.saveToken.run(hashToken(refreshToken), 'refresh', grantId, clientId, String(userId), scopesJson, resource ?? null, refreshExpiresAt)
        return { accessToken, refreshToken, expiresIn: TTL.access, accessExpiresAt, refreshExpiresAt, scopes }
    }

    /** Runs `fn` in one transaction, so a rotation is all or nothing. */
    function transaction(fn) {
        db.exec('BEGIN IMMEDIATE')
        try {
            const result = fn()
            db.exec('COMMIT')
            return result
        } catch (error) {
            db.exec('ROLLBACK')
            throw error
        }
    }

    const store = {
        /** @param {string} clientId */
        getClient(clientId) {
            const row = statements.getClient.get(String(clientId))
            if (!row) return undefined
            const info = JSON.parse(row.info)
            if (row.secret !== null) info.client_secret = decrypt(secretKey, row.secret)
            return info
        },

        /**
         * Persists a registered client (RFC 7591); its secret, if any, encrypted.
         *
         * @param {object} client the full client information, `client_id` included
         */
        saveClient(client) {
            if (!client?.client_id) throw new Error('A client needs a client_id.')
            const { client_secret: secret, ...info } = client
            statements.saveClient.run(client.client_id, JSON.stringify(info), secret ? encrypt(secretKey, secret) : null)
            return { ...client }
        },

        /**
         * Remembers a client's authorization request while the user decides on
         * the consent page and logs in at GitHub. It is bound to the browser
         * that holds `browserToken` (the consent cookie).
         *
         * @param {{clientId: string, params: AuthorizationRecord}} pending
         * @returns {{state: string, browserToken: string}} the `state` for the consent form and GitHub, the token for the cookie
         */
        savePending({ clientId, params }) {
            const state = randomToken()
            const browserToken = randomToken()
            statements.savePending.run(hashToken(state), clientId, JSON.stringify(params), hashToken(browserToken), seconds() + TTL.pending)
            return { state, browserToken }
        },

        /**
         * Reads a pending request without using it up.
         *
         * @param {string} state
         * @param {string} browserToken
         * @returns {{clientId: string, params: AuthorizationRecord, approved: boolean}|null} null when unknown, expired or another browser's
         */
        getPending(state, browserToken) {
            return pendingRecord(statements.getPending.get(hashToken(state)), browserToken)
        },

        /**
         * Records the user's Approve; once only.
         *
         * @param {string} state
         * @param {string} browserToken
         * @returns {boolean} false when unknown, expired, another browser's or already approved
         */
        approvePending(state, browserToken) {
            return transaction(() => {
                const record = pendingRecord(statements.getPending.get(hashToken(state)), browserToken)
                if (!record || record.approved) return false
                return statements.approvePending.run(hashToken(state)).changes > 0
            })
        },

        /**
         * Takes the pending request back (GitHub's callback, or a Deny); single
         * use — the row is gone afterwards even when it belongs to another
         * browser, so a wrong guess cannot be retried.
         *
         * @param {string} state
         * @param {string} browserToken
         * @returns {{clientId: string, params: AuthorizationRecord, approved: boolean}|null} null when unknown, used, expired or another browser's
         */
        takePending(state, browserToken) {
            return pendingRecord(statements.takePending.get(hashToken(state)), browserToken)
        },

        /**
         * Issues an authorization code for a logged-in user; it starts a new
         * grant.
         *
         * @param {{clientId: string, userId: string, params: AuthorizationRecord}} grant
         * @returns {string} the code
         */
        saveCode({ clientId, userId, params }) {
            const code = randomToken()
            statements.saveCode.run(hashToken(code), randomUUID(), clientId, String(userId), JSON.stringify(params), seconds() + TTL.code)
            return code
        },

        /**
         * Reads a code without using it up (the PKCE challenge lookup, which
         * the token endpoint runs first). A code that was already used revokes
         * every token issued from it, here already.
         *
         * @param {string} code
         * @returns {object|null} null when unknown, expired or used
         */
        getCode(code) {
            const hash = hashToken(code)
            const record = codeRecord(live(statements.getCode.get(hash)))
            if (!record) revokeOnReplay(hash, 'code')
            return record
        },

        /**
         * Uses a code up: a second call with the same code returns null and
         * revokes every token issued from the first.
         *
         * @param {string} code
         * @returns {object|null} null when unknown, expired or used
         */
        takeCode(code) {
            const hash = hashToken(code)
            return transaction(() => {
                const row = live(statements.takeCode.get(hash))
                if (!row) {
                    revokeOnReplay(hash, 'code')
                    return null
                }
                bury(hash, 'code', row)
                return codeRecord(row)
            })
        },

        issueTokens,

        /**
         * Looks an access token up.
         *
         * @param {string} token
         * @returns {object|null} null when unknown, revoked, expired or a refresh token
         */
        getAccessToken(token) {
            const row = live(statements.getToken.get(hashToken(token)))
            return row?.kind === 'access' ? tokenRecord(row) : null
        },

        /**
         * Exchanges a refresh token for a new pair of the same grant; the old
         * refresh token is gone afterwards. Presenting it again is a replay:
         * it is refused and revokes the grant's current pair.
         *
         * @param {string} refreshToken
         * @param {{clientId: string, scopes?: string[]}} request `scopes` may narrow, never widen, the grant
         * @returns {object|null} the new pair, or null when the token is unknown, used, expired or another client's
         */
        rotateRefreshToken(refreshToken, { clientId, scopes }) {
            return transaction(() => {
                const hash = hashToken(refreshToken)
                const row = live(statements.getToken.get(hash))
                if (!row) {
                    revokeOnReplay(hash, 'refresh')
                    return null
                }
                const record = tokenRecord(row)
                if (record.kind !== 'refresh' || record.clientId !== clientId) return null
                if (scopes && !scopes.every((scope) => record.scopes.includes(scope))) return null
                statements.deleteToken.run(hash)
                bury(hash, 'refresh', row)
                return issueTokens({ clientId, userId: record.userId, scopes: scopes ?? record.scopes, resource: record.resource, grantId: row.grant_id })
            })
        },

        /**
         * Revokes an access or refresh token of this client (RFC 7009); an
         * unknown token is no error.
         *
         * @param {string} token
         * @param {{clientId: string}} request
         * @returns {boolean} whether a token was removed
         */
        revokeToken(token, { clientId }) {
            return statements.revokeToken.run(hashToken(token), clientId).changes > 0
        },

        /**
         * Saves (or replaces) a GitHub user with their tokens, encrypted.
         *
         * @param {{id: string|number, login: string, accessToken: string, accessTokenExpiresAt?: number, refreshToken?: string, refreshTokenExpiresAt?: number}} user
         */
        saveGithubUser({ id, login, accessToken, accessTokenExpiresAt, refreshToken, refreshTokenExpiresAt }) {
            statements.saveGithubUser.run(
                String(id),
                login,
                encrypt(secretKey, accessToken),
                accessTokenExpiresAt ?? null,
                refreshToken ? encrypt(secretKey, refreshToken) : null,
                refreshTokenExpiresAt ?? null,
                seconds(),
            )
        },

        /**
         * Reads a GitHub user back, tokens decrypted. Throws when the token key
         * is not the one they were written with.
         *
         * @param {string|number} id
         */
        getGithubUser(id) {
            const row = statements.getGithubUser.get(String(id))
            if (!row) return null
            return {
                id: row.user_id,
                login: row.login,
                accessToken: decrypt(secretKey, row.access_token),
                accessTokenExpiresAt: row.access_expires_at ?? undefined,
                refreshToken: row.refresh_token === null ? undefined : decrypt(secretKey, row.refresh_token),
                refreshTokenExpiresAt: row.refresh_expires_at ?? undefined,
            }
        },

        /**
         * Deletes every expired pending authorization, code, token and
         * tombstone.
         *
         * @returns {number} how many rows went
         */
        purgeExpired() {
            const at = seconds()
            return statements.purge.reduce((count, statement) => count + Number(statement.run(at).changes), 0)
        },

        close() {
            db.close()
        },
    }

    store.purgeExpired()
    return store
}
