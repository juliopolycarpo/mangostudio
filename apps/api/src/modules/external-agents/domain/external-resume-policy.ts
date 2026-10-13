/**
 * Which resume mode the hub asks each target for.
 *
 * `fallback` means "resume the stored conversation, or start a new one and say why", and it is
 * what an ordinary reopen wants. `strict` means "resume exactly that conversation or fail".
 *
 * The Claude harness supports only `strict`: its documented headless surface supplies no
 * conclusive cannot-resume signal, so the SDK refuses `fallback` at open
 * (`Error::HostConfiguration`, "expected a strict Claude resume") rather than risk presenting an
 * authentication or transport failure as a fresh chat (`docs/harness-claude.md`, "Fallback is
 * explicitly unsupported"). Codex and the ACP harnesses accept both. The runtime's own test
 * `the_claude_harness_refuses_fallback_resume_and_opens_a_strict_one` pins the Claude fact, so an
 * SDK change fails there instead of in a user's reopen.
 */

import type {
  ExternalAgentResumeMode,
  ExternalAgentTargetId,
} from '@mangostudio/shared/external-agents';

/** Targets whose harness refuses `fallback` outright. */
const STRICT_ONLY_TARGETS: ReadonlySet<ExternalAgentTargetId> = new Set(['claude']);

/**
 * The mode to send with a `resumeRef` for `targetId`.
 *
 * `adopted` is a conversation the user picked by name, which is never allowed to start a new one
 * silently, whatever the target supports.
 *
 * @example
 * resumeModeFor('claude', false); // 'strict'
 * resumeModeFor('codex', false); // 'fallback'
 * resumeModeFor('codex', true); // 'strict'
 */
export function resumeModeFor(
  targetId: ExternalAgentTargetId,
  adopted: boolean
): ExternalAgentResumeMode {
  if (adopted || STRICT_ONLY_TARGETS.has(targetId)) return 'strict';
  return 'fallback';
}
