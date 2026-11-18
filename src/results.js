import { PathError } from './paths.js'

/**
 * A mistake in what a tool was asked to do (a missing site, a page without
 * `layout`, a file that does not exist). The tool wrapper turns it into an
 * `isError` result whose text is this message, so it must say what is wrong,
 * where, and what to do instead.
 */
export class ToolError extends Error {
    constructor(message) {
        super(message)
        this.name = 'ToolError'
    }
}

/**
 * A successful tool result: the JSON a client can use, plus a short text for
 * a human or a client that ignores structured content.
 *
 * @param {object} structured the result as JSON (`structuredContent`)
 * @param {string} text one or two sentences saying what happened and what to do next
 * @returns {{ content: Array<{ type: 'text', text: string }>, structuredContent: object }}
 */
export function ok(structured, text) {
    return {
        content: [{ type: 'text', text }],
        structuredContent: structured,
    }
}

/**
 * A failed tool result (`isError: true`) — the model sees the message and can
 * correct its call; the protocol call itself succeeds.
 *
 * @param {string} message what is wrong, where, and what to do instead
 * @returns {{ content: Array<{ type: 'text', text: string }>, isError: true }}
 */
export function fail(message) {
    return {
        content: [{ type: 'text', text: message }],
        isError: true,
    }
}

/**
 * Wraps a tool handler so a user mistake (`ToolError`, `PathError`) becomes an
 * `isError` result instead of an exception. Anything else is a defect and is
 * rethrown; the SDK reports it as an `isError` result too, but without our
 * wording.
 *
 * @template T
 * @param {(args: T, extra: object) => Promise<object>} handler
 * @returns {(args: T, extra: object) => Promise<object>}
 */
export function tool(handler) {
    return async (args, extra) => {
        try {
            return await handler(args, extra)
        } catch (error) {
            if (error instanceof ToolError || error instanceof PathError) {
                return fail(error.message)
            }
            throw error
        }
    }
}
