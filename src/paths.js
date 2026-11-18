import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * A path a tool was given that points outside the folder it may touch, or that
 * cannot be checked. Tool handlers turn it into an `isError` result; its message
 * says what was wrong and what to pass instead.
 */
export class PathError extends Error {
    constructor(message) {
        super(message)
        this.name = 'PathError'
    }
}

const MISSING = new Set(['ENOENT', 'ENOTDIR'])

/**
 * Resolves the server's `--root` to its real, absolute path, so every later
 * containment check compares real paths (on macOS `/tmp` is a symlink to
 * `/private/tmp`).
 *
 * @param {string} root the folder given on the command line
 * @returns {Promise<string>} the real path of that folder
 * @throws {PathError} when it does not exist or is not a folder
 */
export async function realRoot(root) {
    let real
    try {
        real = await fs.realpath(path.resolve(root))
    } catch {
        throw new PathError(`Root folder "${root}" does not exist. Create it, or start the server with --root pointing at an existing folder.`)
    }
    const stat = await fs.stat(real)
    if (!stat.isDirectory()) {
        throw new PathError(`Root "${root}" is a file, not a folder. Start the server with --root pointing at a folder.`)
    }
    return real
}

/**
 * Resolves `input` against `base` and guarantees the result stays inside
 * `base`: no `..` segment, no absolute path elsewhere, no symlink leading out.
 * The path need not exist yet; then the real path of its nearest existing
 * ancestor decides, so a not-yet-written file below a symlinked folder is
 * checked against where that folder really is.
 *
 * @param {string} base a real, absolute folder (from `realRoot` or an earlier call)
 * @param {string} input a path relative to `base`, or absolute; `''` and `'.'` mean `base`
 * @param {object} [options]
 * @param {string} [options.label] what the path is, for the error message (e.g. `site`)
 * @returns {Promise<string>} the real, absolute path inside `base`
 * @throws {PathError} when the path is not a string, contains `..` or leads outside `base`
 */
export async function resolveInRoot(base, input, { label = 'path' } = {}) {
    if (typeof input !== 'string' || input.includes('\0')) {
        throw new PathError(`The ${label} must be a plain text path.`)
    }
    if (input.split(/[\\/]/).includes('..')) {
        throw new PathError(`The ${label} "${input}" contains "..". Give a path relative to ${base} without "..".`)
    }

    const real = await realpathOfNearest(path.resolve(base, input), input, label)
    if (!isInside(base, real)) {
        throw new PathError(`The ${label} "${input}" leads outside ${base}. Only files and folders inside it can be used.`)
    }
    return real
}

/**
 * The real path of `target`, where missing trailing segments are appended to
 * the real path of the nearest ancestor that exists.
 */
async function realpathOfNearest(target, input, label) {
    const rest = []
    let current = target
    for (;;) {
        try {
            return path.join(await fs.realpath(current), ...rest)
        } catch (error) {
            if (error.code === 'ELOOP') {
                throw new PathError(`The ${label} "${input}" goes through a loop of symbolic links, so it cannot be checked. Remove the loop or use another path.`)
            }
            if (!MISSING.has(error.code)) throw error
        }
        if (await isDanglingLink(current)) {
            throw new PathError(`The ${label} "${input}" goes through a broken symbolic link, so it cannot be checked. Remove the link or use another path.`)
        }
        const parent = path.dirname(current)
        if (parent === current) return target
        rest.unshift(path.basename(current))
        current = parent
    }
}

async function isDanglingLink(candidate) {
    try {
        return (await fs.lstat(candidate)).isSymbolicLink()
    } catch {
        return false
    }
}

/**
 * Whether `target` is `base` itself or lies below it. Both must be real,
 * absolute paths (from `realRoot` / `resolveInRoot`).
 *
 * @param {string} base
 * @param {string} target
 * @returns {boolean}
 */
export function isInside(base, target) {
    const relative = path.relative(base, target)
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}
