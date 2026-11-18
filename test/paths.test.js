import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PathError, realRoot, resolveInRoot } from '../src/paths.js'

let tmp
let rootLink
let root
let outside

beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nera-mcp-paths-'))
    await fs.mkdir(path.join(tmp, 'root', 'site', 'pages'), { recursive: true })
    await fs.mkdir(path.join(tmp, 'outside'))
    await fs.writeFile(path.join(tmp, 'outside', 'secret.txt'), 'secret')
    await fs.writeFile(path.join(tmp, 'root', 'site', 'pages', 'index.md'), '# hi')
    // The root as the user passes it is a symlink, like macOS /tmp → /private/tmp.
    rootLink = path.join(tmp, 'root-link')
    await fs.symlink(path.join(tmp, 'root'), rootLink)
    root = await realRoot(rootLink)
    outside = await fs.realpath(path.join(tmp, 'outside'))
})

afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true })
})

describe('realRoot', () => {
    it('resolves a symlinked root to its real path', async () => {
        expect(root).toBe(await fs.realpath(path.join(tmp, 'root')))
    })

    it('refuses a root that does not exist', async () => {
        await expect(realRoot(path.join(tmp, 'nope'))).rejects.toThrow(/does not exist/)
    })

    it('refuses a root that is a file', async () => {
        await expect(realRoot(path.join(outside, 'secret.txt'))).rejects.toThrow(/is a file/)
    })
})

describe('resolveInRoot', () => {
    it('returns the root itself for "" and "."', async () => {
        expect(await resolveInRoot(root, '')).toBe(root)
        expect(await resolveInRoot(root, '.')).toBe(root)
    })

    it('resolves an existing path inside the root', async () => {
        expect(await resolveInRoot(root, 'site/pages/index.md')).toBe(path.join(root, 'site', 'pages', 'index.md'))
    })

    it('resolves a path that does not exist yet inside the root', async () => {
        expect(await resolveInRoot(root, 'site/pages/blog/new.md')).toBe(path.join(root, 'site', 'pages', 'blog', 'new.md'))
        expect(await resolveInRoot(root, 'new-site')).toBe(path.join(root, 'new-site'))
    })

    it('refuses any ".." segment, even one that would stay inside', async () => {
        await expect(resolveInRoot(root, '../outside/secret.txt')).rejects.toThrow(PathError)
        await expect(resolveInRoot(root, 'site/../site/pages')).rejects.toThrow(/contains "\.\."/)
        await expect(resolveInRoot(root, 'site\\..\\..\\outside')).rejects.toThrow(/contains "\.\."/)
    })

    it('refuses an absolute path outside the root', async () => {
        await expect(resolveInRoot(root, path.join(outside, 'secret.txt'))).rejects.toThrow(/leads outside/)
        await expect(resolveInRoot(root, '/etc/passwd')).rejects.toThrow(/leads outside/)
    })

    it('accepts an absolute path inside the root, also through the symlinked root', async () => {
        const expected = path.join(root, 'site', 'pages', 'index.md')
        expect(await resolveInRoot(root, path.join(root, 'site', 'pages', 'index.md'))).toBe(expected)
        expect(await resolveInRoot(root, path.join(rootLink, 'site', 'pages', 'index.md'))).toBe(expected)
        expect(await resolveInRoot(root, path.join(rootLink, 'site', 'pages', 'later.md'))).toBe(path.join(root, 'site', 'pages', 'later.md'))
    })

    it('refuses a symlinked file that points outside', async () => {
        await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, 'site', 'pages', 'leak.md'))
        await expect(resolveInRoot(root, 'site/pages/leak.md')).rejects.toThrow(/leads outside/)
    })

    it('refuses a path below a symlinked folder that points outside, existing or not', async () => {
        await fs.symlink(outside, path.join(root, 'site', 'escape'))
        await expect(resolveInRoot(root, 'site/escape')).rejects.toThrow(/leads outside/)
        await expect(resolveInRoot(root, 'site/escape/secret.txt')).rejects.toThrow(/leads outside/)
        await expect(resolveInRoot(root, 'site/escape/not-yet/new.md')).rejects.toThrow(/leads outside/)
    })

    it('accepts a symlink that stays inside the root and returns its real target', async () => {
        await fs.symlink(path.join(root, 'site', 'pages'), path.join(root, 'pages-link'))
        expect(await resolveInRoot(root, 'pages-link/index.md')).toBe(path.join(root, 'site', 'pages', 'index.md'))
    })

    it('refuses a path through a broken symlink', async () => {
        await fs.symlink(path.join(outside, 'gone'), path.join(root, 'site', 'dangling'))
        await expect(resolveInRoot(root, 'site/dangling/new.md')).rejects.toThrow(/broken symbolic link/)
    })

    it('refuses a path through a loop of symlinks with a PathError', async () => {
        await fs.symlink(path.join(root, 'loop-b'), path.join(root, 'loop-a'))
        await fs.symlink(path.join(root, 'loop-a'), path.join(root, 'loop-b'))
        await expect(resolveInRoot(root, 'loop-a/new.md')).rejects.toThrow(PathError)
        await expect(resolveInRoot(root, 'loop-a')).rejects.toThrow(/loop of symbolic links/)
    })

    it('checks a nested base the same way and names the label', async () => {
        const site = await resolveInRoot(root, 'site', { label: 'site' })
        expect(await resolveInRoot(site, 'pages/index.md')).toBe(path.join(root, 'site', 'pages', 'index.md'))
        await expect(resolveInRoot(site, path.join(root, 'other.md'), { label: 'file' })).rejects.toThrow(/^The file ".*" leads outside/)
    })

    it('refuses input that is not a plain string', async () => {
        await expect(resolveInRoot(root, undefined)).rejects.toThrow(/plain text path/)
        await expect(resolveInRoot(root, 'a\0b')).rejects.toThrow(/plain text path/)
    })
})
