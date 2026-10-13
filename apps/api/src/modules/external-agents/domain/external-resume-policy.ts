/**
 * What the hub knows about resuming each target's stored conversation.
 *
 * One row per target, typed `Record<ExternalAgentTargetId, ...>`, so a target added to the
 * contract does not compile until someone has chosen both facts for it.
 *
 * `resumeMode` is what the hub sends with a `resumeRef`. `fallback` means "resume the stored
 * conversation, or start a new one and say why"; `strict` means "resume exactly that
 * conversation or fail". The Claude harness supports only `strict`: its documented headless
 * surface supplies no conclusive cannot-resume signal, so the SDK refuses `fallback` at open
 * (`Error::HostConfiguration`, "expected a strict Claude resume") rather than risk presenting an
 * authentication or transport failure as a fresh chat (the SDK's `docs/harness-claude.md`,
 * "Fallback is explicitly unsupported").
 *
 * `continuesKilledTurn` is whether resuming the conversation after the vendor's child was killed
 * mid-turn carries on that turn. The Claude CLI documents it: "When you resume the session,
 * Claude Code continues the turn that SIGTERM left unfinished" (`docs/harness-claude.md`, "The
 * vendor's own turn is left unfinished"). The SDK refuses further turns on a session it had to
 * kill, but only in memory; the hub must remember it durably. Codex and Cursor stop a turn with a
 * protocol request (`turn/interrupt`, `session/cancel`), not a process signal, so the stored
 * conversation does not hold a half-run turn.
 *
 * The runtime's tests `the_claude_harness_refuses_fallback_resume_and_opens_a_strict_one`,
 * `the_codex_harness_opens_a_resumed_session_in_either_mode` and
 * `the_acp_harness_falls_back_in_fallback_mode_and_refuses_in_strict_mode` pin the resume-mode
 * facts, so an SDK change fails there instead of in a user's reopen.
 */

import type {
  ExternalAgentResumeMode,
  ExternalAgentTargetId,
  ExternalTurnTerminalReason,
} from '@mangostudio/shared/external-agents';

export interface ExternalResumePolicy {
  /** The mode sent with a `resumeRef` for an ordinary turn. */
  readonly resumeMode: ExternalAgentResumeMode;
  /** Whether a resume of a conversation whose child was killed mid-turn continues that turn. */
  readonly continuesKilledTurn: boolean;
}

export const EXTERNAL_RESUME_POLICIES = {
  claude: { resumeMode: 'strict', continuesKilledTurn: true },
  codex: { resumeMode: 'fallback', continuesKilledTurn: false },
  cursor: { resumeMode: 'fallback', continuesKilledTurn: false },
} as const satisfies Record<ExternalAgentTargetId, ExternalResumePolicy>;

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
  if (adopted) return 'strict';
  return EXTERNAL_RESUME_POLICIES[targetId].resumeMode;
}

/**
 * Vendor error codes that mean the child died or was stopped under a turn, so a resume could
 * continue that turn. From the Claude harness: the stream broke, the process ended without a
 * result, or it was terminated by something outside the harness.
 */
const PROCESS_DEATH_ERROR_CODES: ReadonlySet<string> = new Set([
  'claude-stream-broken',
  'claude-no-result',
  'claude-terminated',
]);

/**
 * How each way a turn can end bears on the stored conversation.
 *
 * `never`: the turn finished (a finished turn is not left unfinished). `always`: the child may
 * have been killed, and the hub cannot tell a clean interrupt from a kill, because the SDK does
 * not report how a stop ended, so the unknown case is treated as a kill. `process-death`: only
 * when the vendor error names the child dying; an ordinary vendor error (a rate limit, a refusal)
 * leaves the conversation as it was.
 */
const CONTINUATION_EFFECT = {
  completed: 'never',
  'cancelled-by-user': 'always',
  interrupted: 'always',
  'vendor-error': 'process-death',
  'runtime-disconnected': 'always',
  'hub-restarted': 'always',
  'acceptance-unknown': 'always',
  'sequence-gap': 'always',
  'limit-exceeded': 'always',
  'consent-revoked': 'always',
  'session-lost': 'always',
} as const satisfies Record<ExternalTurnTerminalReason, 'never' | 'always' | 'process-death'>;

/**
 * Whether a turn that ended this way leaves the stored conversation unsafe to resume.
 *
 * @example
 * endLeavesConversationUnresumable('claude', 'cancelled-by-user'); // true
 * endLeavesConversationUnresumable('codex', 'cancelled-by-user'); // false
 * endLeavesConversationUnresumable('claude', 'vendor-error', 'claude-no-result'); // true
 * endLeavesConversationUnresumable('claude', 'vendor-error', 'claude-error'); // false
 */
export function endLeavesConversationUnresumable(
  targetId: ExternalAgentTargetId,
  reason: ExternalTurnTerminalReason,
  errorCode?: string
): boolean {
  if (!EXTERNAL_RESUME_POLICIES[targetId].continuesKilledTurn) return false;
  const effect = CONTINUATION_EFFECT[reason];
  if (effect === 'always') return true;
  if (effect === 'never') return false;
  return errorCode !== undefined && PROCESS_DEATH_ERROR_CODES.has(errorCode);
}
