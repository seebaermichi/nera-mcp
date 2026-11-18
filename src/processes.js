import { spawn as nodeSpawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import net from 'node:net'
import { capped, commandFor, KILL_GRACE_MS, spawnOptions, stopChild } from './runner.js'

/**
 * A command that keeps running after the tool call that started it returned
 * (`nera dev`, `nera publish`): its output so far, whether it has exited and
 * with which code.
 *
 * @typedef {object} Tracked
 * @property {string} key what it was started for, e.g. `preview:/abs/site`
 * @property {string} stdout everything it wrote to stdout (its end, capped)
 * @property {string} stderr everything it wrote to stderr (its end, capped)
 * @property {boolean} exited
 * @property {number|null} code its exit code; null while running, when it was stopped by a signal or could not start
 * @property {(predicate: (tracked: Tracked) => boolean, ms: number) => Promise<boolean>} waitFor
 *   resolves true as soon as `predicate` holds (checked now, on every output chunk and on exit), false after `ms`
 */

/**
 * A free TCP port on localhost, for `nera dev --port`. Vite takes the next
 * one itself if another process grabs it in between, which is why the
 * preview reads the URL Vite prints rather than trusting this number.
 *
 * @returns {Promise<number>}
 */
export function freePort() {
    return new Promise((resolve, reject) => {
        const probe = net.createServer()
        probe.unref()
        probe.on('error', reject)
        probe.listen(0, 'localhost', () => {
            const { port } = probe.address()
            probe.close(() => resolve(port))
        })
    })
}

/**
 * The registry of long-running children, one per key. A child is started
 * like a runner's (`spawnOptions`: no shell, no stdin, output captured, its
 * own process group) and stays in the registry after it exits, so a later
 * tool call can still read how it ended, until it is `forget`-ten.
 * `stopAll` stops every child that is still running — the server calls it
 * when it closes.
 *
 * @param {object} [options]
 * @param {typeof nodeSpawn} [options.spawn] injected in tests
 * @param {number} [options.grace] milliseconds between SIGTERM and SIGKILL
 */
export function createProcesses({ spawn = nodeSpawn, grace = KILL_GRACE_MS } = {}) {
    /** @type {Map<string, Tracked & { child: import('node:child_process').ChildProcess }>} */
    const tracked = new Map()

    /**
     * Starts `command args` in `cwd` under `key`; a child already running
     * under that key is a caller's mistake.
     *
     * @param {string} key
     * @param {'nera'|'npm'|'node'} command
     * @param {string[]} args
     * @param {{ cwd: string, env?: Record<string, string> }} options
     * @returns {Tracked}
     */
    function start(key, command, args, { cwd, env }) {
        if (tracked.get(key)?.exited === false) {
            throw new Error(`"${key}" is already running.`)
        }
        const { file, prefix } = commandFor(command, cwd)
        const child = spawn(file, [...prefix, ...args], spawnOptions(cwd, env))
        const changes = new EventEmitter()
        const entry = {
            key,
            child,
            stdout: '',
            stderr: '',
            exited: false,
            code: null,
            waitFor(predicate, ms) {
                if (predicate(entry)) return Promise.resolve(true)
                return new Promise((resolve) => {
                    const check = () => {
                        if (!predicate(entry)) return
                        done(true)
                    }
                    const done = (value) => {
                        clearTimeout(timer)
                        changes.off('change', check)
                        resolve(value)
                    }
                    const timer = setTimeout(() => done(predicate(entry)), ms)
                    changes.on('change', check)
                })
            },
        }
        const exit = (code) => {
            if (entry.exited) return
            entry.exited = true
            entry.code = code
            changes.emit('change')
        }
        child.stdout.setEncoding('utf8')
        child.stderr.setEncoding('utf8')
        child.stdout.on('data', (chunk) => {
            entry.stdout = capped(entry.stdout + chunk)
            changes.emit('change')
        })
        child.stderr.on('data', (chunk) => {
            entry.stderr = capped(entry.stderr + chunk)
            changes.emit('change')
        })
        child.on('error', (error) => {
            entry.stderr = capped(`${entry.stderr}\nCould not start ${command}: ${error.message}`)
            exit(null)
        })
        child.on('close', (code) => exit(code))
        tracked.set(key, entry)
        return entry
    }

    /**
     * Stops the child under `key` (if it still runs) and drops it.
     *
     * @param {string} key
     * @returns {Promise<boolean>} true when there was one
     */
    async function stop(key) {
        const entry = tracked.get(key)
        if (!entry) return false
        tracked.delete(key)
        await stopChild(entry.child, { grace })
        // its output streams close just after it exits (at once, since its group is gone)
        await entry.waitFor((r) => r.exited, grace)
        return true
    }

    return {
        start,
        stop,
        /** @returns {Tracked|undefined} */
        get: (key) => tracked.get(key),
        /** Drops an exited child's record, so the next call starts afresh; a running one is kept. */
        forget: (key) => {
            if (tracked.get(key)?.exited) tracked.delete(key)
        },
        /** Stops every child; resolves once all have exited. */
        stopAll: () => Promise.all([...tracked.keys()].map(stop)).then(() => undefined),
    }
}
