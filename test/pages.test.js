import { describe, expect, it } from 'vitest'
import {
    composePage,
    frontmatterText,
    NO_WRITE_SEGMENTS,
    parsePage,
    refuseSecrets,
    refuseSegments,
    requireLayout,
    splitPage,
    withTrailingNewline,
} from '../src/pages.js'
import { ToolError } from '../src/results.js'

describe('splitPage', () => {
    it('splits frontmatter and body at the fences', () => {
        expect(splitPage('---\nlayout: a\n---\n\n# Hi\n')).toEqual({ yamlText: 'layout: a', body: '\n# Hi\n' })
    })

    it('reads CRLF like LF', () => {
        expect(splitPage('---\r\nlayout: a\r\n---\r\nbody')).toEqual({ yamlText: 'layout: a', body: 'body' })
    })

    it('takes a page without a first fence as body only', () => {
        expect(splitPage('# Hi\n---\n')).toEqual({ yamlText: null, body: '# Hi\n---\n' })
    })

    it('takes everything after an unclosed fence as frontmatter', () => {
        expect(splitPage('---\nlayout: a\ntitle: b')).toEqual({ yamlText: 'layout: a\ntitle: b', body: '' })
    })
})

describe('parsePage', () => {
    it('returns the frontmatter as JSON and the body without leading blank lines', () => {
        expect(parsePage('---\nlayout: a\ntags: [x]\n---\n\n\n# Hi\n')).toEqual({ frontmatter: { layout: 'a', tags: ['x'] }, body: '# Hi\n', error: null })
    })

    it('returns an empty object for a page without frontmatter', () => {
        expect(parsePage('# Hi')).toEqual({ frontmatter: {}, body: '# Hi', error: null })
    })

    it('reports invalid YAML and a frontmatter that is not a map', () => {
        expect(parsePage('---\nlayout: [a\n---\n')).toMatchObject({ frontmatter: null })
        expect(parsePage('---\nlayout: [a\n---\n').error).toBeTruthy()
        expect(parsePage('---\n- a\n---\n')).toMatchObject({ frontmatter: null, error: 'The frontmatter is not a list of `key: value` lines.' })
    })
})

describe('frontmatterText', () => {
    const existing = '# the layout\nlayout: "pages/default.pug"\ntitle: Old\nobsolete: 1'

    it('keeps the block byte for byte when nothing changed', () => {
        expect(frontmatterText(existing, { layout: 'pages/default.pug', title: 'Old', obsolete: 1 })).toBe(`${existing}\n`)
    })

    it('keeps comments and quoting, changes values, drops left-out keys, appends new ones', () => {
        expect(frontmatterText(existing, { layout: 'pages/default.pug', title: 'New', lang: 'en' }))
            .toBe('# the layout\nlayout: "pages/default.pug"\ntitle: New\nlang: en\n')
    })

    it('writes fresh YAML for a page without (valid) frontmatter', () => {
        expect(frontmatterText(null, { layout: 'a', tags: ['x', 'y'] })).toBe('layout: a\ntags:\n  - x\n  - y\n')
        expect(frontmatterText('layout: [a', { layout: 'a' })).toBe('layout: a\n')
    })
})

describe('withTrailingNewline', () => {
    it('adds a newline only when there is none', () => {
        expect(withTrailingNewline('a')).toBe('a\n')
        expect(withTrailingNewline('a\n')).toBe('a\n')
    })
})

describe('composePage', () => {
    it('writes a new page', () => {
        expect(composePage(null, { layout: 'a' }, '\n\n# Hi')).toBe('---\nlayout: a\n---\n\n# Hi\n')
    })

    it('keeps the existing body when none is given', () => {
        expect(composePage('---\nlayout: a\n---\n\n# Old\n', { layout: 'b' })).toBe('---\nlayout: b\n---\n\n# Old\n')
    })

    it('gives a new frontmatter to a page that had none, body unchanged', () => {
        expect(composePage('# Old\n', { layout: 'a' })).toBe('---\nlayout: a\n---\n# Old\n')
    })
})

describe('requireLayout', () => {
    it.each([{}, { layout: '' }, { layout: '  ' }, { layout: 3 }])('refuses %j', (frontmatter) => {
        expect(() => requireLayout(frontmatter)).toThrow(ToolError)
        expect(() => requireLayout(frontmatter)).toThrow(/The frontmatter has no `layout`/)
    })

    it('accepts a named layout', () => {
        expect(() => requireLayout({ layout: 'pages/default.pug' })).not.toThrow()
    })
})

describe('refuseSecrets', () => {
    it.each([
        ['.git/config', '.git/config', '".git/config" is inside .git/, which these tools never read or change.'],
        ['link', '.git/HEAD', '"link" is inside .git/, which these tools never read or change.'],
        ['.env', '.env', '".env" can hold secrets (tokens, passwords); these tools never read or change it.'],
        ['config/.env.local', 'config/.env.local', '"config/.env.local" can hold secrets (tokens, passwords); these tools never read or change it.'],
        ['npmrc-link', '.npmrc', '"npmrc-link" can hold secrets (tokens, passwords); these tools never read or change it.'],
    ])('refuses %j (resolved %j)', (input, resolved, message) => {
        expect(() => refuseSecrets(input, resolved)).toThrow(ToolError)
        expect(() => refuseSecrets(input, resolved)).toThrow(message)
    })

    it.each(['config/app.yaml', '.neraignore', 'assets/environment.css', 'pages/.gitkeep'])('accepts %j', (file) => {
        expect(() => refuseSecrets(file, file)).not.toThrow()
    })
})

describe('refuseSegments', () => {
    it('refuses a segment from the set, with the reason', () => {
        expect(() => refuseSegments('node_modules/x/index.js', 'node_modules/x/index.js', NO_WRITE_SEGMENTS, 'npm manages'))
            .toThrow('"node_modules/x/index.js" is inside node_modules/, which npm manages.')
    })

    it('accepts a name that only contains the segment', () => {
        expect(() => refuseSegments('my_node_modules/x', 'my_node_modules/x', NO_WRITE_SEGMENTS, 'npm manages')).not.toThrow()
    })
})
