#!/usr/bin/env node
// Downloads the complete Nera documentation (nera.js.org/llms-full.txt) into
// docs/, so the released package serves it as the nera://docs/llms-full.txt
// resource without a network. Runs on `prepack` (npm pack and npm publish).
// Fails loudly when the download fails: a release without its docs would
// silently send every model to the network. docs/ is git-ignored.
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { BUNDLED_DOCS, DOCS_URL } from '../src/resources.js'

const TIMEOUT_MS = 30000
/** A real llms-full.txt is far larger; anything smaller is an error page. */
const MIN_CHARS = 10000

/**
 * Downloads `url` to `file` (through a temp file, so a failed run never
 * leaves a truncated copy).
 *
 * @param {object} [options]
 * @param {typeof fetch} [options.fetch]
 * @param {string} [options.url]
 * @param {string} [options.file]
 * @returns {Promise<number>} the number of bytes written
 */
export async function fetchDocs({ fetch = globalThis.fetch, url = DOCS_URL, file = BUNDLED_DOCS } = {}) {
    const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!response.ok) {
        throw new Error(`${url} answered HTTP ${response.status}`)
    }
    const body = await response.text()
    if (body.length < MIN_CHARS) {
        throw new Error(`${url} returned only ${body.length} characters; expected the full documentation`)
    }
    await fs.mkdir(path.dirname(file), { recursive: true })
    const partial = `${file}.partial`
    await fs.writeFile(partial, body)
    await fs.rename(partial, file)
    return Buffer.byteLength(body)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        const bytes = await fetchDocs()
        console.error(`Bundled ${DOCS_URL} (${bytes} bytes) into ${path.relative(process.cwd(), BUNDLED_DOCS)}`)
    } catch (error) {
        console.error(`Could not bundle the Nera docs: ${error.message}. The package needs them; check the network and run npm pack / npm publish again.`)
        process.exitCode = 1
    }
}
