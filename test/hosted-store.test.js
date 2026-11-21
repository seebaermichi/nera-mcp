import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { decrypt, encrypt, hashToken, parseKey, randomToken } from '../src/hosted/crypto.js'
import { createStore, TTL } from '../src/hosted/store.js'

const KEY = Buffer.alloc(32, 7).toString('base64')
const OTHER_KEY = Buffer.alloc(32, 9).toString('hex')

const PARAMS = { codeChallenge: 'challenge', redirectUri: 'https://claude.ai/api/mcp/auth_callback', state: 'client-state', scopes: ['mcp'], resource: 'https://mcp.example/mcp' }
const GITHUB_USER = {
    id: 4242,
    login: 'octo',
    accessToken: 'ghu_plaintextAccessToken0001',
    accessTokenExpiresAt: 2_000_000_000,
    refreshToken: 'ghr_plaintextRefreshToken0001',
    refreshTokenExpiresAt: 2_100_000_000,
}

let tmp
let file
let clock
let store

const now = () => clock

beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nera-mcp-store-'))
    file = path.join(tmp, 'auth.sqlite')
    clock = 1_800_000_000_000
    store = createStore({ file, key: KEY, now })
})

afterEach(async () => {
    try {
        store.close()
    } catch {
        // already closed by the test
    }
    await fs.rm(tmp, { recursive: true, force: true })
})

/** Everything SQLite wrote, main file and write-ahead log, as one string. */
function databaseBytes() {
    return [file, `${file}-wal`].filter((part) => existsSync(part)).map((part) => readFileSync(part).toString('latin1')).join('')
}

/** Counts a table's rows straight from the file, past the store. */
function countRows(table) {
    const db = new DatabaseSync(file)
    try {
        return db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n
    } finally {
        db.close()
    }
}

describe('crypto', () => {
    it('accepts a 32-byte key as base64 or hex and refuses anything else', () => {
        expect(parseKey(KEY)).toHaveLength(32)
        expect(parseKey(OTHER_KEY)).toHaveLength(32)
        expect(() => parseKey('too-short')).toThrow(/32 bytes/)
        expect(() => parseKey(Buffer.alloc(16).toString('base64'))).toThrow(/32 bytes/)
        expect(() => parseKey(undefined)).toThrow(/openssl rand -base64 32/)
    })

    it('round-trips, with a fresh IV per encryption', () => {
        const key = parseKey(KEY)
        const first = encrypt(key, 'secret')
        const second = encrypt(key, 'secret')
        expect(first).not.toBe(second)
        expect(first.split('.')[1]).not.toBe(second.split('.')[1])
        expect(decrypt(key, first)).toBe('secret')
        expect(decrypt(key, second)).toBe('secret')
    })

    it('refuses a wrong key and an altered value instead of returning garbage', () => {
        const blob = encrypt(parseKey(KEY), 'secret')
        expect(() => decrypt(parseKey(OTHER_KEY), blob)).toThrow(/token key differs/)
        const [version, iv, tag, ciphertext] = blob.split('.')
        const flipped = Buffer.from(ciphertext, 'base64url')
        flipped[0] ^= 1
        expect(() => decrypt(parseKey(KEY), [version, iv, tag, flipped.toString('base64url')].join('.'))).toThrow(/altered/)
        expect(() => decrypt(parseKey(KEY), [version, iv, Buffer.alloc(16).toString('base64url'), ciphertext].join('.'))).toThrow(/altered/)
        expect(() => decrypt(parseKey(KEY), 'plain')).toThrow(/known format/)
    })

    it('hashes with SHA-256 and makes 256-bit URL-safe tokens', () => {
        expect(hashToken('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
        expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{43}$/)
        expect(randomToken()).not.toBe(randomToken())
    })
})

describe('createStore', () => {
    it('refuses to open without a valid key', () => {
        expect(() => createStore({ file: ':memory:', key: 'nope' })).toThrow(/32 bytes/)
    })

    it('persists a registered client, its secret encrypted, across a reopen', () => {
        const client = { client_id: 'client-1', client_id_issued_at: 1, client_secret: 'client-secret-plaintext', redirect_uris: [PARAMS.redirectUri] }
        store.saveClient(client)
        store.close()
        expect(databaseBytes()).not.toContain('client-secret-plaintext')
        store = createStore({ file, key: KEY, now })
        expect(store.getClient('client-1')).toEqual(client)
        expect(store.getClient('unknown')).toBeUndefined()
    })

    it('stores a public client without a secret', () => {
        store.saveClient({ client_id: 'public', redirect_uris: [PARAMS.redirectUri], token_endpoint_auth_method: 'none' })
        expect(store.getClient('public')).not.toHaveProperty('client_secret')
    })

    it('hands a pending authorization back once, by the state sent to GitHub', () => {
        const state = store.savePending({ clientId: 'client-1', params: PARAMS })
        expect(store.takePending(state)).toEqual({ clientId: 'client-1', params: PARAMS })
        expect(store.takePending(state)).toBeNull()
        expect(store.takePending('forged')).toBeNull()
    })

    it('lets a pending authorization expire', () => {
        const state = store.savePending({ clientId: 'client-1', params: PARAMS })
        clock += TTL.pending * 1000
        expect(store.takePending(state)).toBeNull()
    })

    it('reads a code without using it up, then uses it up once', () => {
        const code = store.saveCode({ clientId: 'client-1', userId: 4242, params: PARAMS })
        expect(store.getCode(code)).toMatchObject({ clientId: 'client-1', userId: '4242', codeChallenge: 'challenge' })
        expect(store.getCode(code)).not.toBeNull()
        expect(store.takeCode(code)).toMatchObject({ clientId: 'client-1', redirectUri: PARAMS.redirectUri })
        expect(store.takeCode(code)).toBeNull()
        expect(store.getCode(code)).toBeNull()
    })

    it('refuses a code after ten minutes', () => {
        const code = store.saveCode({ clientId: 'client-1', userId: 1, params: PARAMS })
        clock += TTL.code * 1000
        expect(store.getCode(code)).toBeNull()
        expect(store.takeCode(code)).toBeNull()
    })

    it('issues access tokens that verify until they expire', () => {
        const tokens = store.issueTokens({ clientId: 'client-1', userId: 4242, scopes: ['mcp'], resource: PARAMS.resource })
        expect(tokens.expiresIn).toBe(3600)
        expect(store.getAccessToken(tokens.accessToken)).toEqual({
            kind: 'access',
            clientId: 'client-1',
            userId: '4242',
            scopes: ['mcp'],
            resource: PARAMS.resource,
            expiresAt: tokens.accessExpiresAt,
        })
        expect(store.getAccessToken(tokens.refreshToken)).toBeNull()
        expect(store.getAccessToken('unknown')).toBeNull()
        clock += TTL.access * 1000
        expect(store.getAccessToken(tokens.accessToken)).toBeNull()
    })

    it('rotates a refresh token and refuses the old one afterwards', () => {
        const first = store.issueTokens({ clientId: 'client-1', userId: 4242, scopes: ['mcp', 'read'] })
        const second = store.rotateRefreshToken(first.refreshToken, { clientId: 'client-1' })
        expect(second.refreshToken).not.toBe(first.refreshToken)
        expect(second.scopes).toEqual(['mcp', 'read'])
        expect(store.getAccessToken(second.accessToken)).toMatchObject({ userId: '4242' })
        expect(store.rotateRefreshToken(first.refreshToken, { clientId: 'client-1' })).toBeNull()
        expect(store.rotateRefreshToken(second.refreshToken, { clientId: 'client-1', scopes: ['mcp'] }).scopes).toEqual(['mcp'])
    })

    it('refuses a refresh by another client, a widened scope, an access token or an expired token', () => {
        const tokens = store.issueTokens({ clientId: 'client-1', userId: 1, scopes: ['mcp'] })
        expect(store.rotateRefreshToken(tokens.refreshToken, { clientId: 'client-2' })).toBeNull()
        expect(store.rotateRefreshToken(tokens.refreshToken, { clientId: 'client-1', scopes: ['admin'] })).toBeNull()
        expect(store.rotateRefreshToken(tokens.accessToken, { clientId: 'client-1' })).toBeNull()
        clock += TTL.refresh * 1000
        expect(store.rotateRefreshToken(tokens.refreshToken, { clientId: 'client-1' })).toBeNull()
    })

    it('revokes a token of the same client only', () => {
        const tokens = store.issueTokens({ clientId: 'client-1', userId: 1 })
        expect(store.revokeToken(tokens.accessToken, { clientId: 'client-2' })).toBe(false)
        expect(store.getAccessToken(tokens.accessToken)).not.toBeNull()
        expect(store.revokeToken(tokens.accessToken, { clientId: 'client-1' })).toBe(true)
        expect(store.getAccessToken(tokens.accessToken)).toBeNull()
        expect(store.revokeToken(tokens.refreshToken, { clientId: 'client-1' })).toBe(true)
        expect(store.rotateRefreshToken(tokens.refreshToken, { clientId: 'client-1' })).toBeNull()
        expect(store.revokeToken('unknown', { clientId: 'client-1' })).toBe(false)
    })

    it('round-trips a GitHub user with tokens and replaces them on a later login', () => {
        store.saveGithubUser(GITHUB_USER)
        expect(store.getGithubUser(4242)).toEqual({ ...GITHUB_USER, id: '4242' })
        store.saveGithubUser({ id: 4242, login: 'octo', accessToken: 'ghu_second' })
        expect(store.getGithubUser('4242')).toEqual({ id: '4242', login: 'octo', accessToken: 'ghu_second', accessTokenExpiresAt: undefined, refreshToken: undefined, refreshTokenExpiresAt: undefined })
        expect(store.getGithubUser(1)).toBeNull()
    })

    it('fails to read GitHub tokens back under another key', () => {
        store.saveGithubUser(GITHUB_USER)
        store.close()
        store = createStore({ file, key: OTHER_KEY, now })
        expect(() => store.getGithubUser(4242)).toThrow(/token key differs/)
    })

    it('writes no plaintext token, code or state into the database file', () => {
        store.saveGithubUser(GITHUB_USER)
        const state = store.savePending({ clientId: 'client-1', params: PARAMS })
        const code = store.saveCode({ clientId: 'client-1', userId: 4242, params: PARAMS })
        const tokens = store.issueTokens({ clientId: 'client-1', userId: 4242 })
        store.close()
        const bytes = databaseBytes()
        expect(bytes).toContain('octo')
        expect(bytes).toContain(hashToken(tokens.accessToken))
        for (const secret of [GITHUB_USER.accessToken, GITHUB_USER.refreshToken, state, code, tokens.accessToken, tokens.refreshToken]) {
            expect(bytes).not.toContain(secret)
        }
    })

    it.skipIf(process.platform === 'win32')('creates the database file readable by its owner only', async () => {
        expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
    })

    it('purges expired rows, on demand and when it opens', () => {
        store.savePending({ clientId: 'client-1', params: PARAMS })
        store.saveCode({ clientId: 'client-1', userId: 1, params: PARAMS })
        const tokens = store.issueTokens({ clientId: 'client-1', userId: 1 })
        expect(store.purgeExpired()).toBe(0)
        clock += TTL.access * 1000
        expect(store.purgeExpired()).toBe(3)
        expect(store.rotateRefreshToken(tokens.refreshToken, { clientId: 'client-1' })).not.toBeNull()
        store.close()
        expect(countRows('tokens')).toBe(2)
        clock += TTL.refresh * 1000
        store = createStore({ file, key: KEY, now })
        store.close()
        expect(countRows('tokens')).toBe(0)
    })
})
