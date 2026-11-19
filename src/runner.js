import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { activeShim, npmScripts, ownNpm, withPathPrefix } from './runtime.js'

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
 * The version of the `@nera-static/nera` whose script `neraBin(cwd)` names:
 * the `version` of the `package.json` two folders above it. Read synchronously,
 * so a caller can check it and start a run without yielding in between.
 *
 * @param {string} cwd
 * @returns {string|null} null when the file cannot be read or carries no string `version`
 */
export function neraVersion(cwd) {
    try {
        const { version } = JSON.parse(readFileSync(path.join(path.dirname(neraBin(cwd)), '..', 'package.json'), 'utf8'))
        return typeof version === 'string' ? version : null
    } catch {
        return null
    }
}

/**
 * How to start npm without a shell: its `npm-cli.js` from the server's own
 * `node_modules/npm` (the Desktop extension bundles one) or next to the running
 * Node (where every Node installer puts it), else the `npm` executable on the
 * PATH. Running the script through `process.execPath` avoids `npm.cmd` on
 * Windows, which Node refuses to spawn without a shell.
 *
 * @param {string} [execPath] the Node binary
 * @param {string|null} [own] the server's own npm package folder
 * @returns {{ file: string, prefix: string[] }}
 */
export function npmCommand(execPath = process.execPath, own = ownNpm()) {
    const scripts = npmScripts(execPath, own)
    return scripts ? { file: execPath, prefix: [scripts.npmCli] } : { file: 'npm', prefix: [] }
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
 * The environment every child gets: this process's, without colour codes and
 * with `env` added. Under the bundled runtime the shim folder
 * (`src/runtime.js`) comes first on the PATH, so the child and everything it
 * starts find `node`, `npm` and `npx`. Also what `create_site` hands
 * `createSite`, whose children (`npm pack`, `tar`, `npm install`) the runner
 * does not start.
 *
 * @param {Record<string, string>} [env] added to this process's environment
 * @param {NodeJS.Platform} [platform] injected in tests
 * @param {string|null} [shim] the shim folder; the active one by default
 * @returns {Record<string, string|undefined>}
 */
export function childEnv(env = {}, platform = process.platform, shim = activeShim()) {
    const merged = { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', ...env }
    return shim ? withPathPrefix(merged, shim, platform) : merged
}

/**
 * The options every child is spawned with: no shell (arguments are never
 * interpreted), no stdin (nothing can wait for an answer), both output streams
 * piped (none of it reaches this process's stdout), the env of `childEnv`,
 * and — on POSIX — its own process group, so `stopChild` reaches the
 * processes it starts in turn (npm's scripts, Vite's workers). Windows has no
 * process groups to signal; `stopChild` ends the tree with `taskkill /T` there.
 *
 * @param {string} cwd
 * @param {Record<string, string>} [env] added to this process's environment
 * @param {NodeJS.Platform} [platform] injected in tests
 * @param {string|null} [shim] the shim folder; the active one by default
 * @returns {import('node:child_process').SpawnOptions}
 */
export function spawnOptions(cwd, env = {}, platform = process.platform, shim = activeShim()) {
    return {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        detached: platform !== 'win32',
        env: childEnv(env, platform, shim),
    }
}

function hasExited(child) {
    return child.exitCode !== null || child.signalCode !== null
}

/**
 * `taskkill` by its absolute path: Windows looks for a bare command name in
 * the working directory before PATH, so a `taskkill.exe` there would run
 * instead.
 */
const TASKKILL = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe')

/**
 * Ends a child's whole process tree on Windows: `taskkill /pid <pid> /T /F`,
 * spawned without a shell and with its output ignored. Its failure (the
 * process is gone already) is swallowed; when `taskkill` cannot even start,
 * the child itself is terminated, so at least it does not survive.
 *
 * @param {import('node:child_process').ChildProcess} child
 * @param {typeof nodeSpawn} spawn
 */
function killWindowsTree(child, spawn) {
    const killChild = () => {
        try {
            child.kill('SIGKILL')
        } catch {
            // already gone
        }
    }
    try {
        const taskkill = spawn(TASKKILL, ['/pid', String(child.pid), '/T', '/F'], {
            stdio: 'ignore',
            shell: false,
            windowsHide: true,
        })
        taskkill.on('error', killChild)
    } catch {
        killChild()
    }
}

/**
 * Sends `signal` to a child and everything it started: its process group on
 * POSIX, its process tree (`taskkill /T /F`, always forced) on Windows.
 *
 * @param {import('node:child_process').ChildProcess} child
 * @param {NodeJS.Signals} signal
 * @param {{ platform: NodeJS.Platform, spawn: typeof nodeSpawn }} options
 */
function signalGroup(child, signal, { platform, spawn }) {
    if (platform === 'win32') {
        killWindowsTree(child, spawn)
        return
    }
    try {
        if (child.pid) {
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
 * Stops a child and everything it started. On POSIX: SIGTERM to its process
 * group, then SIGKILL when it is still running after `grace` milliseconds, and
 * SIGKILL to what is left of the group once it has exited. On Windows:
 * `taskkill /T /F` at once (a console process has no SIGTERM to honour),
 * again after `grace` if it still runs, never after it exited — its pid may
 * belong to someone else by then. Resolves once the child has exited (at once
 * when it already has).
 *
 * @param {import('node:child_process').ChildProcess} child
 * @param {object} [options]
 * @param {number} [options.grace]
 * @param {NodeJS.Platform} [options.platform] injected in tests
 * @param {typeof nodeSpawn} [options.spawn] starts `taskkill`; injected in tests
 * @returns {Promise<void>}
 */
export function stopChild(child, { grace = KILL_GRACE_MS, platform = process.platform, spawn = nodeSpawn } = {}) {
    // never started (no pid), or exited long ago: nothing to stop, and its
    // group id may belong to someone else by now
    if (!child.pid || hasExited(child)) return Promise.resolve()
    const tree = { platform, spawn }
    return new Promise((resolve) => {
        const timer = setTimeout(() => signalGroup(child, 'SIGKILL', tree), grace)
        child.once('exit', () => {
            clearTimeout(timer)
            // what the child started may outlive it: end the rest of the group
            if (platform !== 'win32') signalGroup(child, 'SIGKILL', tree)
            resolve()
        })
        signalGroup(child, 'SIGTERM', tree)
    })
}

/**
 * Creates the function the tools run `nera`, `npm` and `node` through, for
 * commands that finish (`nera new`, `nera build`, `npm install`). Every run
 * gets its arguments as an array and the options of `spawnOptions`. A run is
 * stopped (with everything it started) when it exceeds `timeout` or when `signal`
 * aborts — the client cancelled the request, or the server closed.
 *
 * @param {object} [options]
 * @param {typeof nodeSpawn} [options.spawn] injected in tests
 * @param {number} [options.timeout] milliseconds before a run is stopped
 * @param {number} [options.grace] milliseconds between SIGTERM and SIGKILL
 * @param {NodeJS.Platform} [options.platform] injected in tests
 * @returns {(command: 'nera'|'npm'|'node', args: string[], options: { cwd: string, signal?: AbortSignal }) => Promise<{ code: number|null, stdout: string, stderr: string, timedOut: boolean, cancelled: boolean }>}
 *   `code` is null when the process was stopped or could not start; `stderr` then says why
 */
export function createRunner({ spawn = nodeSpawn, timeout = DEFAULT_TIMEOUT_MS, grace = KILL_GRACE_MS, platform = process.platform } = {}) {
    return (command, args, { cwd, signal }) => new Promise((resolve) => {
        const { file, prefix } = commandFor(command, cwd)
        if (signal?.aborted) {
            resolve({ code: null, stdout: '', stderr: 'Cancelled before it started.', timedOut: false, cancelled: true })
            return
        }
        const child = spawn(file, [...prefix, ...args], spawnOptions(cwd, {}, platform))
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
            stopChild(child, { grace, platform, spawn })
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
