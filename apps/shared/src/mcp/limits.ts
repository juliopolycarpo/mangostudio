/**
 * Numbers an MCP call is bounded by, on whichever side applies them.
 *
 * The runtime enforces the request cap against the server; the hub reports the
 * same number back when a stored row leaves the timeout unset, so a user who
 * asks "how long before this gives up?" is told the truth rather than a second
 * default that happens to differ.
 */

/** Request cap applied when neither the call nor the server row sets one. */
export const DEFAULT_MCP_TIMEOUT_MS = 30_000;
