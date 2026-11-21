// The hosted mode's secrets (L7b): our own tokens are random and stored only as
// SHA-256 hashes, so a leaked database cannot be replayed; GitHub's user tokens
// must be read back to call the API, so they are encrypted with AES-256-GCM
// under the operator's key (`NERA_MCP_TOKEN_KEY`). Nothing here logs a value.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'
const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16
/** The prefix of every encrypted value, so a later format can be told apart. */
const VERSION = 'v1'

/**
 * Turns the operator's key into the 32 bytes AES-256 needs. Accepted: 64 hex
 * characters or the base64 of 32 bytes (`openssl rand -base64 32`).
 *
 * @param {string|Buffer} input
 * @returns {Buffer}
 */
export function parseKey(input) {
    if (Buffer.isBuffer(input)) {
        if (input.length === KEY_BYTES) return Buffer.from(input)
    } else if (typeof input === 'string') {
        const text = input.trim()
        if (/^[0-9a-fA-F]{64}$/.test(text)) return Buffer.from(text, 'hex')
        if (/^[A-Za-z0-9+/_-]{43}=?$/.test(text)) {
            const bytes = Buffer.from(text, 'base64')
            if (bytes.length === KEY_BYTES) return bytes
        }
    }
    throw new Error(`The token key must be ${KEY_BYTES} bytes, written as 64 hex characters or base64 (create one with \`openssl rand -base64 32\`).`)
}

/**
 * Encrypts a string with a fresh random IV per call.
 *
 * @param {Buffer} key 32 bytes, from `parseKey`
 * @param {string} plaintext
 * @returns {string} `v1.<iv>.<tag>.<ciphertext>`, each part base64url
 */
export function encrypt(key, plaintext) {
    const iv = randomBytes(IV_BYTES)
    const cipher = createCipheriv(ALGORITHM, key, iv)
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return [VERSION, iv, tag, ciphertext].map((part) => (typeof part === 'string' ? part : part.toString('base64url'))).join('.')
}

/**
 * Decrypts what `encrypt` wrote. Throws when the key is wrong or the value was
 * altered (the GCM auth tag does not match), never returns garbage.
 *
 * @param {Buffer} key
 * @param {string} blob
 * @returns {string}
 */
export function decrypt(key, blob) {
    const parts = String(blob).split('.')
    if (parts.length !== 4 || parts[0] !== VERSION) throw new Error('Not an encrypted value of a known format.')
    const [iv, tag, ciphertext] = parts.slice(1).map((part) => Buffer.from(part, 'base64url'))
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error('Not an encrypted value of a known format.')
    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES })
    decipher.setAuthTag(tag)
    try {
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
    } catch {
        throw new Error('Cannot decrypt a stored token: the token key differs from the one it was written with, or the value was altered.')
    }
}

/**
 * The SHA-256 of a token, hex: how our tokens are stored and looked up.
 *
 * @param {string} token
 * @returns {string}
 */
export function hashToken(token) {
    return createHash('sha256').update(String(token), 'utf8').digest('hex')
}

/**
 * A random, URL-safe token.
 *
 * @param {number} [bytes] entropy in bytes (default 32 = 256 bits)
 * @returns {string}
 */
export function randomToken(bytes = 32) {
    return randomBytes(bytes).toString('base64url')
}
