/**
 * D4's two product axes, expressed in Cursor's session modes.
 *
 * Cursor is the vendor that shows why the axes need per-adapter vetting. It has
 * one control where Codex has three: a session mode, changeable on a live
 * session with `session/set_mode`, whose members on a live `2026.08.04-aaa8809`
 * are `agent`, `plan` and `ask`. There is no reviewer field and no sandbox
 * field, so half the matrix is honestly unavailable rather than approximated.
 *
 * | Level         | Mode                                                     |
 * | ------------- | -------------------------------------------------------- |
 * | `read-only`   | `plan` — it proposes rather than only answering          |
 * | `default`     | `agent`, with the user's own Cursor configuration ruling |
 * | `full-access` | **unsupported** — see below                              |
 *
 * `ask` is deliberately unused. It is the narrower Q&A mode — no edits and no
 * command execution — and `read-only` in MangoStudio's vocabulary means "it can
 * look at the workspace", which is `plan`.
 *
 * **`full-access` and `auto-review` are refused, not synthesized.** Cursor's
 * print mode has `--force`/`--yolo` and `--auto-review`, and the CLI's own
 * `cli-config.json` carries `approvalMode` and an auto-review availability
 * cache — but those are the *user's* Cursor configuration, and ACP exposes
 * neither as a session option or a permission-response policy. The only way to
 * fake either from here would be to answer every `session/request_permission`
 * automatically, which would make MangoStudio the thing granting the
 * permission. That is precisely the ownership inversion this cycle removes, so
 * both come back `supported: false` with a reason that says where the setting
 * actually lives.
 */

import type {
  ExternalPermissionLevel,
  ExternalSupportedConfiguration,
} from '@mangostudio/shared/external-agents';
import { externalConfigurationMatrix } from '../permission-matrix';
import type { AcpModeState } from './protocol';

/** i18n keys for the combinations Cursor does not offer over ACP. */
export const CURSOR_UNSUPPORTED_REASON_KEYS = {
  fullAccess: 'externalAgents.unsupported.cursorNoFullAccess',
  autoReview: 'externalAgents.unsupported.cursorNoAutoReview',
  modeMissing: 'externalAgents.unsupported.cursorModeMissing',
  versionTooOld: 'externalAgents.unsupported.cursorVersionTooOld',
  handshakeFailed: 'externalAgents.unsupported.cursorAcpUnavailable',
} as const;

/**
 * The session mode each neutral level selects, or `undefined` where ACP has no
 * equivalent at all.
 */
const CURSOR_MODE_IDS: Readonly<Record<ExternalPermissionLevel, string | undefined>> = {
  'read-only': 'plan',
  default: 'agent',
  'full-access': undefined,
};

/** The mode id a level runs as, or `undefined` when the level is unsupported. */
export function cursorModeFor(level: ExternalPermissionLevel): string | undefined {
  return CURSOR_MODE_IDS[level];
}

/**
 * The matrix, narrowed by what this account's session actually offers.
 *
 * The mode list comes from a live `session/new`, not from a table here: modes
 * are session state, and a build or an account that stopped offering `plan`
 * would otherwise be advertised as supporting `read-only` right up until
 * `session/set_mode` refused it. When no session could be opened the list is
 * absent, and the levels fall back to their declared modes — the handshake gate
 * has already decided whether the target is selectable at all.
 */
export function buildCursorSupportedConfigurations(
  modes: AcpModeState | undefined
): ExternalSupportedConfiguration[] {
  const available = modes?.availableModes;
  const offered = available
    ? new Set(available.map((mode) => mode.id).filter((id): id is string => Boolean(id)))
    : undefined;

  return externalConfigurationMatrix((level, routing) => {
    const vendorId = CURSOR_MODE_IDS[level];
    if (routing === 'auto-review') {
      return {
        supported: false,
        reasonKey: CURSOR_UNSUPPORTED_REASON_KEYS.autoReview,
        ...(vendorId === undefined ? {} : { vendorId }),
      };
    }
    if (vendorId === undefined) {
      return { supported: false, reasonKey: CURSOR_UNSUPPORTED_REASON_KEYS.fullAccess };
    }
    if (offered && !offered.has(vendorId)) {
      return { supported: false, reasonKey: CURSOR_UNSUPPORTED_REASON_KEYS.modeMissing, vendorId };
    }
    return { supported: true, vendorId };
  });
}

/**
 * The same matrix, wholly unavailable for one reason.
 *
 * A machine that has `cursor-agent` but cannot drive it — a build older than
 * the pin, or one whose `acp` handshake failed — still has to describe the
 * choices it is refusing.
 */
export function cursorUnsupportedConfigurations(
  reasonKey: string
): ExternalSupportedConfiguration[] {
  return externalConfigurationMatrix((level) => {
    const vendorId = CURSOR_MODE_IDS[level];
    return { supported: false, reasonKey, ...(vendorId === undefined ? {} : { vendorId }) };
  });
}
