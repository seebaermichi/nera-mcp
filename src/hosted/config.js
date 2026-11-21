// The hosted mode's configuration (L7b), read by the bin before anything else
// of `src/hosted/` loads. It has no imports on purpose: the bin calls it before
// it knows whether this Node has `node:sqlite`, which `store.js` needs.
// Values come from the environment, never from the command line, so no secret
// shows up in `ps`; no error message ever quotes a value.

/** The environment variables the hosted mode needs, with what each one is. */
export const HOSTED_ENV = Object.freeze({
    NERA_MCP_ISSUER: 'our public origin, e.g. https://mcp.nera-pro.app',
    NERA_MCP_DB: 'the SQLite file for clients and tokens',
    NERA_MCP_TOKEN_KEY: 'the key that encrypts GitHub tokens (openssl rand -base64 32)',
    NERA_MCP_GITHUB_CLIENT_ID: 'the GitHub App\'s client ID',
    NERA_MCP_GITHUB_CLIENT_SECRET: 'the GitHub App\'s client secret',
})

/** The first Node releases with an unflagged `node:sqlite`, per major line. */
const SQLITE_SINCE = Object.freeze({ 22: 13, 23: 4 })

/** A configuration the hosted mode cannot start with; the message is safe to print. */
export class HostedConfigError extends Error {
    constructor(message) {
        super(message)
        this.name = 'HostedConfigError'
    }
}

/**
 * Whether a Node version has `node:sqlite` without a flag: 22.13+, 23.4+, 24+.
 *
 * @param {string} version `process.versions.node`, e.g. `22.12.0`
 * @returns {boolean}
 */
export function hasNodeSqlite(version) {
    const [major, minor] = version.split('.').map(Number)
    if (major in SQLITE_SINCE) return minor >= SQLITE_SINCE[major]
    return major > 23
}

/**
 * Reads the hosted mode's settings from `env`. Every missing variable is named
 * in one error, so the operator fixes them in one go.
 *
 * @param {Record<string, string|undefined>} env usually `process.env`
 * @returns {{ issuer: string, db: string, tokenKey: string, githubClientId: string, githubClientSecret: string }}
 * @throws {HostedConfigError} when a variable is missing or empty
 */
export function readHostedConfig(env) {
    const missing = Object.keys(HOSTED_ENV).filter((name) => !env[name]?.trim())
    if (missing.length > 0) {
        const lines = missing.map((name) => `  ${name}  ${HOSTED_ENV[name]}`)
        throw new HostedConfigError(`the hosted mode (--http) needs these environment variables:\n${lines.join('\n')}`)
    }
    return {
        issuer: env.NERA_MCP_ISSUER.trim(),
        db: env.NERA_MCP_DB.trim(),
        tokenKey: env.NERA_MCP_TOKEN_KEY.trim(),
        githubClientId: env.NERA_MCP_GITHUB_CLIENT_ID.trim(),
        githubClientSecret: env.NERA_MCP_GITHUB_CLIENT_SECRET.trim(),
    }
}

/**
 * Turns `--trust-proxy` into Express's `trust proxy` setting: a number of
 * hops (`1`), or the addresses/subnets to trust (`loopback`, `10.0.0.0/8`).
 * Absent means no proxy is trusted.
 *
 * @param {string|undefined} value
 * @returns {false|number|string}
 */
export function parseTrustProxy(value) {
    if (value === undefined) return false
    const text = value.trim()
    if (text === '') throw new HostedConfigError('--trust-proxy needs a value: a number of proxies (e.g. 1) or the addresses to trust (e.g. loopback).')
    return /^\d+$/.test(text) ? Number(text) : text
}

/**
 * Turns `--port` into a TCP port; `0` picks a free one.
 *
 * @param {string|undefined} value
 * @param {number} fallback
 * @returns {number}
 */
export function parsePort(value, fallback) {
    if (value === undefined) return fallback
    const port = /^\d+$/.test(value.trim()) ? Number(value) : NaN
    if (!(port >= 0 && port <= 65535)) throw new HostedConfigError(`--port must be a number from 0 to 65535 (got ${value}).`)
    return port
}
