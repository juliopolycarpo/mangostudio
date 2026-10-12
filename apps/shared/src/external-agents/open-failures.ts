/**
 * Open-time failures the client presents in its own words without an unavailable reason.
 *
 * An unavailable reason (`not-installed`, `signed-out`, ...) describes the agent, and the selector
 * shows it. A runtime at its session cap says nothing about the agent, so it has no reason and no
 * remedy command; the stream's `error` chunk names it by the runtime's own kind in `code`, and the
 * client keeps its copy for that kind. A client that does not know the code ignores it and shows
 * the chunk's English sentence.
 *
 * Browser-safe: pure data, no Node builtins.
 */

/**
 * The runtime's kind for an open refused because it already hosts its maximum number of sessions.
 *
 * Also the `code` of the stream's `error` chunk. The runtime spells it in
 * `crates/mangostudio-runtime/src/external_agents/supervisor.rs`; its tests pin that spelling.
 */
export const EXTERNAL_AGENT_CAPACITY_CODE = 'external_agent_capacity';
