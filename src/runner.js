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
/** How long a stopped child gets to exit after SIGTERM before it gets SIGKILL. */
export const KILL_GRACE_MS = 5000

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

/**
 * The executable and leading arguments for `nera`, `npm` or `node` in `cwd`.
 *
 * @param {'nera'|'npm'|'node'} command
 * @param {string} cwd
 * @returns {{ file: string, prefix: string[] }}
 * @throws {Error} for any other command
 */
export function commandFor(command, cwd) {
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

/**
 * Keeps the end of a captured stream, at most `MAX_CAPTURE` characters.
 *
 * @param {string} text
 * @returns {string}
 */
export function capped(text) {
    return text.length > MAX_CAPTURE ? text.slice(-MAX_CAPTURE) : text
}

/**
 * The options every child is spawned with: no shell (arguments are never
 * interpreted), no stdin (nothing can wait for an answer), both output streams
 * piped (none of it reaches this process's stdout), no colour codes, and — on
 * POSIX — its own process group, so `stopChild` reaches the processes it
 * starts in turn (npm's scripts, Vite's workers).
 *
 * @param {string} cwd
 * @param {Record<string, string>} [env] added to this process's environment
 * @returns {import('node:child_process').SpawnOptions}
 */
export function spawnOptions(cwd, env = {}) {
    return {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        detached: process.platform !== 'win32',
        env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', ...env },
    }
}

function hasExited(child) {
    return child.exitCode !== null || child.signalCode !== null
}

function signalGroup(child, signal) {
    try {
        if (child.pid && process.platform !== 'win32') {
            process.kill(-child.pid, signal)
            return
        }
    } catch {
        // the group is gone already, or this child leads none: signal the child itself
    }
    try {
        child.kill(signal)
    } catch {
        // already gone
    }
}

/**
 * Stops a child and everything in its process group: SIGTERM, then SIGKILL
 * when it is still running after `grace` milliseconds. Resolves once the child
 * has exited (at once when it already has).
 *
 * @param {import('node:child_process').ChildProcess} child
 * @param {{ grace?: number }} [options]
 * @returns {Promise<void>}
 */
export function stopChild(child, { grace = KILL_GRACE_MS } = {}) {
    // never started (no pid), or exited long ago: nothing to stop, and its
    // group id may belong to someone else by now
    if (!child.pid || hasExited(child)) return Promise.resolve()
    return new Promise((resolve) => {
        const timer = setTimeout(() => signalGroup(child, 'SIGKILL'), grace)
        child.once('exit', () => {
            clearTimeout(timer)
            // what the child started may outlive it: end the rest of the group
            signalGroup(child, 'SIGKILL')
            resolve()
        })
        signalGroup(child, 'SIGTERM')
    })
}

/**
 * Creates the function the tools run `nera`, `npm` and `node` through, for
 * commands that finish (`nera new`, `nera build`, `npm install`). Every run
 * gets its arguments as an array and the options of `spawnOptions`. A run is
 * stopped (with its process group) when it exceeds `timeout` or when `signal`
 * aborts — the client cancelled the request, or the server closed.
 *
 * @param {object} [options]
 * @param {typeof nodeSpawn} [options.spawn] injected in tests
 * @param {number} [options.timeout] milliseconds before a run is stopped
 * @param {number} [options.grace] milliseconds between SIGTERM and SIGKILL
 * @returns {(command: 'nera'|'npm'|'node', args: string[], options: { cwd: string, signal?: AbortSignal }) => Promise<{ code: number|null, stdout: string, stderr: string, timedOut: boolean, cancelled: boolean }>}
 *   `code` is null when the process was stopped or could not start; `stderr` then says why
 */
export function createRunner({ spawn = nodeSpawn, timeout = DEFAULT_TIMEOUT_MS, grace = KILL_GRACE_MS } = {}) {
    return (command, args, { cwd, signal }) => new Promise((resolve) => {
        const { file, prefix } = commandFor(command, cwd)
        if (signal?.aborted) {
            resolve({ code: null, stdout: '', stderr: 'Cancelled before it started.', timedOut: false, cancelled: true })
            return
        }
        const child = spawn(file, [...prefix, ...args], spawnOptions(cwd))
        let stdout = ''
        let stderr = ''
        let timedOut = false
        let cancelled = false
        let settled = false
        const finish = (code) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            signal?.removeEventListener('abort', onAbort)
            resolve({ code, stdout, stderr, timedOut, cancelled })
        }
        const stop = (reason) => {
            stderr = capped(`${stderr}\n${reason}`)
            stopChild(child, { grace })
        }
        const onAbort = () => {
            cancelled = true
            stop('Cancelled.')
        }
        const timer = setTimeout(() => {
            timedOut = true
            stop(`Stopped after ${timeout / 1000} s.`)
        }, timeout)
        signal?.addEventListener('abort', onAbort, { once: true })
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
