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

/** The runtime's kinds for external-agent failures are `external_agent_` and snake_case words. */
const EXTERNAL_AGENT_KIND_PATTERN = /^external_agent_[a-z]+(?:_[a-z]+)*$/;

/** Longest kind the hub forwards or the client shows; the runtime's longest is under 40. */
const EXTERNAL_AGENT_KIND_MAX_LENGTH = 64;

/**
 * Whether `value` has the shape of a runtime external-agent kind.
 *
 * The hub forwards a failed open's kind in the `error` chunk's `code` so the person has something
 * to quote to support, and the client shows it as plain text. Checking the shape on both sides
 * keeps anything else, such as vendor text or markup, out of that field.
 *
 * @example
 * isExternalAgentKindCode('external_agent_launch_failed'); // true
 * isExternalAgentKindCode('<img src=x>'); // false
 */
export function isExternalAgentKindCode(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= EXTERNAL_AGENT_KIND_MAX_LENGTH &&
    EXTERNAL_AGENT_KIND_PATTERN.test(value)
  );
}
