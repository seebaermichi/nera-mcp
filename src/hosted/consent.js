// The hosted mode's consent page (L7b, plan step 2b, decision D6). Any client
// can register itself via DCR, and GitHub does not ask again once a user has
// authorized the "Nera Static" App — so without a page of our own, a link to
// our `/authorize` with an attacker's client would sign a victim in silently
// and hand the code to the attacker's redirect URI (the "confused deputy" of
// the MCP authorization spec). This page names the client and where it sends
// the user, and only its Approve button goes on to GitHub.
//
// The page is bound to the browser that opened it: a random token sits both in
// an HttpOnly cookie and in the form, and the store keeps only its hash. A
// forged POST from another site cannot know this browser's token, so its form
// field never matches the cookie, whatever SameSite does; and a state an
// attacker approved in their own browser is refused at the GitHub callback,
// which checks the same cookie.
import { createHash } from 'node:crypto'

/** Where the consent form posts to; step 3 mounts the route here. */
export const CONSENT_PATH = '/oauth/consent'

/** The browser-binding cookie. `__Host-`: Secure, Path=/, no Domain, so no subdomain can set it. */
export const CONSENT_COOKIE = '__Host-nera-consent'

const STYLE = `
body { font: 16px/1.5 system-ui, sans-serif; max-width: 32rem; margin: 3rem auto; padding: 0 1rem; color: #1f2328; background: #fff; }
h1 { font-size: 1.4rem; }
.client { font-weight: 600; overflow-wrap: anywhere; }
.host { font-family: ui-monospace, monospace; overflow-wrap: anywhere; }
.actions { display: flex; gap: 0.75rem; margin-top: 2rem; }
button { font: inherit; padding: 0.5rem 1.25rem; border-radius: 6px; border: 1px solid #d0d7de; background: #f6f8fa; cursor: pointer; }
button[value="approve"] { background: #1f883d; border-color: #1f883d; color: #fff; }
@media (prefers-color-scheme: dark) { body { color: #e6edf3; background: #0d1117; } button { background: #21262d; border-color: #30363d; color: #e6edf3; } }
`

/** The page allows its own inline style block and nothing else; no framing. */
const CONTENT_SECURITY_POLICY = [
    'default-src \'none\'',
    `style-src 'sha256-${createHash('sha256').update(STYLE).digest('base64')}'`,
    'frame-ancestors \'none\'',
    'base-uri \'none\'',
    // No `form-action`: browsers apply it to the redirect that follows the
    // POST too, and that goes to GitHub or to the client's redirect URI.
].join('; ')

/** Headers for every response of the consent flow: never cached, never framed. */
export const CONSENT_HEADERS = Object.freeze({
    'Cache-Control': 'no-store',
    'Content-Security-Policy': CONTENT_SECURITY_POLICY,
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
})

/**
 * Escapes text for HTML element content and double-quoted attributes.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[char])
}

/**
 * What the page shows as the place the client sends the user back to: the
 * host of a web redirect URI, the whole URI for a custom scheme or loopback
 * app without one.
 *
 * @param {string} redirectUri
 * @returns {string}
 */
export function redirectTarget(redirectUri) {
    const url = new URL(redirectUri)
    return url.host || url.href
}

/**
 * The consent page.
 *
 * @param {object} page
 * @param {string} [page.clientName] the client's self-declared `client_name`
 * @param {string} page.clientId
 * @param {string} page.redirectUri
 * @param {string} page.state our pending state
 * @param {string} page.csrfToken the browser-binding token, also in the cookie
 * @param {string} [page.action] where the form posts
 * @returns {string} the HTML
 */
export function renderConsentPage({ clientName, clientId, redirectUri, state, csrfToken, action = CONSENT_PATH }) {
    const name = clientName?.trim() ? clientName.trim() : `An application without a name (${clientId})`
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect to Nera</title>
<style>${STYLE}</style>
</head>
<body>
<h1>Connect an application to Nera?</h1>
<p><span class="client">${escapeHtml(name)}</span> wants to work on your Nera sites with your GitHub account.</p>
<p>After you approve and sign in with GitHub, you are sent back to <span class="host">${escapeHtml(redirectTarget(redirectUri))}</span>.</p>
<p>The name is chosen by the application itself. Approve only if you started this connection from your AI assistant just now and you recognise that address.</p>
<form method="post" action="${escapeHtml(action)}">
<input type="hidden" name="state" value="${escapeHtml(state)}">
<input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">
<div class="actions">
<button type="submit" name="decision" value="approve">Approve</button>
<button type="submit" name="decision" value="deny">Deny</button>
</div>
</form>
</body>
</html>
`
}

/**
 * The `Set-Cookie` value for the browser-binding token. `SameSite=Lax`, not
 * `Strict`: the cookie must come along on GitHub's top-level redirect back to
 * our callback. The protection does not rest on SameSite, though — see above.
 *
 * @param {string} token
 * @param {number} maxAge seconds; 0 deletes the cookie
 */
export function consentCookie(token, maxAge) {
    return `${CONSENT_COOKIE}=${token}; Max-Age=${maxAge}; Path=/; Secure; HttpOnly; SameSite=Lax`
}

/**
 * Reads the browser-binding token from a `Cookie` request header.
 *
 * @param {string|undefined} header
 * @returns {string|undefined}
 */
export function readConsentCookie(header) {
    if (typeof header !== 'string') return undefined
    for (const part of header.split(';')) {
        const separator = part.indexOf('=')
        if (separator !== -1 && part.slice(0, separator).trim() === CONSENT_COOKIE) return part.slice(separator + 1).trim() || undefined
    }
    return undefined
}
