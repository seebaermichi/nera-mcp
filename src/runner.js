import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const NERA_BIN = path.join('node_modules', '@nera-static', 'nera', 'bin', 'nera.js')
/** `npm install` inside `nera new` can take minutes; past this a run is stopped. */
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
/** Each captured stream keeps at most this many characters (its end). */
const MAX_CAPTURE = 1024 * 1024

/**
 * The `nera` script a command in `cwd` runs: the site's own
 * `node_modules/@nera-static/nera` when it has one (so a site builds with the
 * CLI version it pins), else the one this server depends on.
 *
 * @param {string} cwd
 * @returns {string} absolute path of `bin/nera.js`
 */
export function neraBin(cwd) {
    const local = path.join(cwd, NERA_BIN)
    if (existsSync(local)) return local
    return path.join(path.dirname(require.resolve('@nera-static/nera/package.json')), 'bin', 'nera.js')
}

/**
 * How to start npm without a shell: its `npm-cli.js` next to the running Node
 * (where every Node installer puts it), else the `npm` executable on the PATH.
 * Running the script through `process.execPath` avoids `npm.cmd` on Windows,
 * which Node refuses to spawn without a shell.
 *
 * @param {string} [execPath] the Node binary
 * @returns {{ file: string, prefix: string[] }}
 */
export function npmCommand(execPath = process.execPath) {
    const bin = path.dirname(execPath)
    const candidates = [
        path.join(bin, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        path.join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ]
    const script = candidates.find((candidate) => existsSync(candidate))
    return script ? { file: execPath, prefix: [script] } : { file: 'npm', prefix: [] }
}

function commandFor(command, cwd) {
    switch (command) {
    case 'nera':
        return { file: process.execPath, prefix: [neraBin(cwd)] }
    case 'npm':
        return npmCommand()
    case 'node':
        return { file: process.execPath, prefix: [] }
    default:
        throw new Error(`Unknown command "${command}": the runner starts nera, npm or node only.`)
    }
}

function capped(text) {
    return text.length > MAX_CAPTURE ? text.slice(-MAX_CAPTURE) : text
}

/**
 * Creates the function the tools run `nera`, `npm` and `node` through. Every
 * run gets its arguments as an array (no shell, so nothing in them is
 * interpreted), no stdin (nothing can wait for an answer), and both output
 * streams captured — none of it reaches this process's stdout, which belongs
 * to the MCP protocol.
 *
 * @param {object} [options]
 * @param {typeof nodeSpawn} [options.spawn] injected in tests
 * @param {number} [options.timeout] milliseconds before a run is killed
 * @returns {(command: 'nera'|'npm'|'node', args: string[], options: { cwd: string }) => Promise<{ code: number|null, stdout: string, stderr: string, timedOut: boolean }>}
 *   `code` is null when the process was killed or could not start; `stderr` then says why
 */
export function createRunner({ spawn = nodeSpawn, timeout = DEFAULT_TIMEOUT_MS } = {}) {
    return (command, args, { cwd }) => new Promise((resolve) => {
        const { file, prefix } = commandFor(command, cwd)
        const child = spawn(file, [...prefix, ...args], {
            cwd,
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: false,
            env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
        })
        let stdout = ''
        let stderr = ''
        let timedOut = false
        let settled = false
        const finish = (code) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            resolve({ code, stdout, stderr, timedOut })
        }
        const timer = setTimeout(() => {
            timedOut = true
            stderr = capped(`${stderr}\nStopped after ${timeout / 1000} s.`)
            child.kill('SIGTERM')
        }, timeout)
        child.stdout.setEncoding('utf8')
        child.stderr.setEncoding('utf8')
        child.stdout.on('data', (chunk) => { stdout = capped(stdout + chunk) })
        child.stderr.on('data', (chunk) => { stderr = capped(stderr + chunk) })
        child.on('error', (error) => {
            stderr = capped(`${stderr}\nCould not start ${command}: ${error.message}`)
            finish(null)
        })
        child.on('close', (code) => finish(code))
    })
}
