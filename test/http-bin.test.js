import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import pkg from '../package.json' with { type: 'json' }
import { HOSTED_ENV, hasNodeSqlite, HostedConfigError, parsePort, parseTrustProxy, readHostedConfig } from '../src/hosted/config.js'

const BIN = fileURLToPath(new URL('../bin/nera-mcp.js', import.meta.url))
const EXIT_MS = 15000

const ISSUER = 'http://localhost:9999'
const TOKEN_KEY = Buffer.alloc(32, 9).toString('base64')
const CLIENT_SECRET = 'github-app-secret-do-not-log'

/** Every secret the bin gets; none of them may ever reach its output. */
const SECRETS = [TOKEN_KEY, CLIENT_SECRET]

/** A complete hosted configuration, with the database in `dir`. */
function hostedEnv(dir) {
    return {
        NERA_MCP_ISSUER: ISSUER,
        NERA_MCP_DB: path.join(dir, 'mcp.sqlite'),
        NERA_MCP_TOKEN_KEY: TOKEN_KEY,
        NERA_MCP_GITHUB_CLIENT_ID: 'Iv1.nera-test',
        NERA_MCP_GITHUB_CLIENT_SECRET: CLIENT_SECRET,
    }
}

/**
 * Starts the bin with `args` and `env` only (plus PATH), so no NERA_MCP_*
 * value of the developer's shell leaks in. `listening` resolves with the port
 * once the bin says it listens; `exited` with the exit code.
 */
function startBin(args, env = {}) {
    const child = spawn(process.execPath, [BIN, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, ...env } })
    const out = { stdout: '', stderr: '' }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { out.stdout += chunk })
    const listening = new Promise((resolve) => {
        child.stderr.on('data', (chunk) => {
            out.stderr += chunk
            const port = out.stderr.match(/listening on .+:(\d+)\n/)?.[1]
            if (port) resolve(Number(port))
        })
    })
    const exited = new Promise((resolve) => child.on('close', (code) => resolve(code)))
    return { child, out, listening, exited }
}

/** A port something else already listens on, and a function that frees it. */
async function occupiedPort() {
    const blocker = createServer()
    await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve))
    return { port: blocker.address().port, close: () => new Promise((resolve) => blocker.close(resolve)) }
}

describe('bin/nera-mcp.js --http', () => {
    let dir
    let bin

    beforeEach(async () => {
        dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nera-mcp-http-')))
    })

    afterEach(async () => {
        if (bin && bin.child.exitCode === null && bin.child.signalCode === null) {
            bin.child.kill('SIGKILL')
            await bin.exited
        }
        bin = undefined
        await fs.rm(dir, { recursive: true, force: true })
    })

    it('serves the OAuth metadata, guards /mcp, and exits 0 on SIGTERM without logging a secret', async () => {
        bin = startBin(['--http', '--port', '0', '--trust-proxy', 'loopback'], hostedEnv(dir))
        const port = await bin.listening
        const base = `http://127.0.0.1:${port}`

        const metadata = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()
        expect(metadata.issuer).toBe(`${ISSUER}/`)
        expect(metadata.registration_endpoint).toBe(`${ISSUER}/register`)
        expect(metadata.code_challenge_methods_supported).toEqual(['S256'])
        const resource = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json()
        expect(resource.resource).toBe(`${ISSUER}/mcp`)

        const registered = await fetch(`${base}/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], token_endpoint_auth_method: 'none' }),
        })
        expect(registered.status).toBe(201)

        const unauthorized = await fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: 'Bearer not-a-token' } })
        expect(unauthorized.status).toBe(401)
        expect(unauthorized.headers.get('www-authenticate')).toContain(`resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/mcp"`)

        bin.child.kill('SIGTERM')

        expect(await bin.exited).toBe(0)
        expect(bin.out.stderr).toContain(`nera-mcp ${pkg.version}: hosted mode for ${ISSUER}, listening on 127.0.0.1:${port}`)
        expect(bin.out.stdout).toBe('')
        for (const secret of [...SECRETS, 'not-a-token']) expect(bin.out.stderr).not.toContain(secret)
        const { mode } = await fs.stat(path.join(dir, 'mcp.sqlite'))
        if (process.platform !== 'win32') expect(mode & 0o777).toBe(0o600)
    }, EXIT_MS)

    it('exits 1 and names every missing variable when the environment is empty', async () => {
        bin = startBin(['--http'])

        expect(await bin.exited).toBe(1)
        for (const name of Object.keys(HOSTED_ENV)) expect(bin.out.stderr).toContain(name)
        expect(bin.out.stdout).toBe('')
    }, EXIT_MS)

    it('names only the missing variable and quotes no value of the others', async () => {
        const env = hostedEnv(dir)
        delete env.NERA_MCP_ISSUER
        bin = startBin(['--http'], env)

        expect(await bin.exited).toBe(1)
        expect(bin.out.stderr).toContain('NERA_MCP_ISSUER')
        expect(bin.out.stderr).not.toContain('NERA_MCP_DB')
        for (const secret of SECRETS) expect(bin.out.stderr).not.toContain(secret)
    }, EXIT_MS)

    it('exits 1 on a token key of the wrong size, without quoting it', async () => {
        const badKey = 'c2hvcnQta2V5'
        bin = startBin(['--http', '--port', '0'], { ...hostedEnv(dir), NERA_MCP_TOKEN_KEY: badKey })

        expect(await bin.exited).toBe(1)
        expect(bin.out.stderr).toContain('The token key must be 32 bytes')
        expect(bin.out.stderr).not.toContain(badKey)
        expect(bin.out.stderr).not.toContain(CLIENT_SECRET)
    }, EXIT_MS)

    it('exits 1 on a plain-http issuer that is not localhost', async () => {
        bin = startBin(['--http', '--port', '0'], { ...hostedEnv(dir), NERA_MCP_ISSUER: 'http://mcp.example.org' })

        expect(await bin.exited).toBe(1)
        expect(bin.out.stderr).toContain('cannot start the hosted mode')
        expect(bin.out.stderr).toMatch(/HTTPS/i)
    }, EXIT_MS)

    it('exits 1 when the port is taken', async () => {
        const blocker = await occupiedPort()
        try {
            bin = startBin(['--http', '--port', String(blocker.port)], hostedEnv(dir))

            expect(await bin.exited).toBe(1)
            expect(bin.out.stderr).toContain(`cannot listen on 127.0.0.1:${blocker.port}`)
        } finally {
            await blocker.close()
        }
    }, EXIT_MS)

    it('exits 1 on --root together with --http', async () => {
        bin = startBin(['--http', '--root', dir], hostedEnv(dir))

        expect(await bin.exited).toBe(1)
        expect(bin.out.stderr).toContain('--root is for the stdio mode only')
        expect(bin.out.stdout).toBe('')
    }, EXIT_MS)

    it('exits 1 on a port that is not a number', async () => {
        bin = startBin(['--http', '--port', 'eighty'], hostedEnv(dir))

        expect(await bin.exited).toBe(1)
        expect(bin.out.stderr).toContain('--port must be a number from 0 to 65535 (got eighty)')
    }, EXIT_MS)
})

describe('hasNodeSqlite', () => {
    it.each([
        ['22.12.0', false],
        ['22.13.0', true],
        ['22.22.0', true],
        ['23.3.0', false],
        ['23.4.0', true],
        ['24.0.0', true],
        ['20.19.0', false],
    ])('%s → %s', (version, expected) => {
        expect(hasNodeSqlite(version)).toBe(expected)
    })
})

describe('readHostedConfig', () => {
    it('returns the trimmed values', () => {
        const env = hostedEnv('/srv')
        expect(readHostedConfig({ ...env, NERA_MCP_ISSUER: ` ${ISSUER} ` })).toEqual({
            issuer: ISSUER,
            db: env.NERA_MCP_DB,
            tokenKey: TOKEN_KEY,
            githubClientId: 'Iv1.nera-test',
            githubClientSecret: CLIENT_SECRET,
        })
    })

    it('treats a blank value as missing', () => {
        expect(() => readHostedConfig({ ...hostedEnv('/srv'), NERA_MCP_GITHUB_CLIENT_SECRET: '  ' })).toThrow(HostedConfigError)
        expect(() => readHostedConfig({ ...hostedEnv('/srv'), NERA_MCP_GITHUB_CLIENT_SECRET: '  ' })).toThrow(/NERA_MCP_GITHUB_CLIENT_SECRET/)
    })
})

describe('parseTrustProxy and parsePort', () => {
    it('trusts no proxy by default, a number of hops, or named addresses', () => {
        expect(parseTrustProxy(undefined)).toBe(false)
        expect(parseTrustProxy('1')).toBe(1)
        expect(parseTrustProxy('loopback')).toBe('loopback')
        expect(() => parseTrustProxy(' ')).toThrow(HostedConfigError)
    })

    it('accepts 0 to 65535 and falls back when absent', () => {
        expect(parsePort(undefined, 8080)).toBe(8080)
        expect(parsePort('0', 8080)).toBe(0)
        expect(parsePort('65535', 8080)).toBe(65535)
        expect(() => parsePort('65536', 8080)).toThrow(HostedConfigError)
        expect(() => parsePort('-1', 8080)).toThrow(HostedConfigError)
    })
})
