/**
 * Per-request user token context.
 *
 * Historically Sentinel kept a single module-global "active token" that was
 * overwritten on every login, which broke multi-user isolation (background
 * work could run under whichever user logged in last, and any logout cleared
 * the token for everyone).
 *
 * This module carries the caller's OAuth token through the async call chain
 * using AsyncLocalStorage instead. Request handlers should wrap their work in
 * runWithUserToken(reqToken, fn); services then resolve the effective token
 * via getEffectiveToken() without threading a token argument through every
 * function signature.
 *
 * A module-level fallback token exists ONLY for startup / server-credential
 * use (e.g. boot-time status checks or jobs that legitimately run as the
 * server itself). Request paths must rely on the async context, not the
 * fallback.
 */
const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();

// Startup / server-credential fallback token. Set once at boot via
// setFallbackToken(); never set per-request.
let fallbackToken = null;

/**
 * Run fn within a context carrying the given user token.
 * @param {string|null} token - The caller's OAuth token (may be null).
 * @param {Function} fn - Function to execute inside the context.
 * @returns {*} Whatever fn returns (often a Promise).
 */
function runWithUserToken(token, fn) {
    return storage.run({ token: token || null }, fn);
}

/**
 * Get the token bound to the current async context, or null when there is no
 * active context (or the context carries no token).
 * @returns {string|null}
 */
function getContextToken() {
    const store = storage.getStore();
    return store ? (store.token || null) : null;
}

/**
 * Set the process-wide fallback token. Startup / server-credential use only —
 * request paths must use runWithUserToken() instead.
 * @param {string|null} token
 */
function setFallbackToken(token) {
    fallbackToken = token || null;
}

/**
 * Resolve the effective token for an operation.
 * Priority:
 *   1. Explicit token argument
 *   2. Async-context token (current request's user)
 *   3. Startup fallback token
 * @param {string} [explicit] - Optional explicit token.
 * @returns {string|null}
 */
function getEffectiveToken(explicit) {
    if (typeof explicit === 'string' && explicit.length > 0) return explicit;
    return getContextToken() || fallbackToken || null;
}

module.exports = {
    runWithUserToken,
    getContextToken,
    setFallbackToken,
    getEffectiveToken
};
