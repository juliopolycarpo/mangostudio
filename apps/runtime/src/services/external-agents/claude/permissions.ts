/**
 * D4's two product axes, collapsed onto Claude's single `--permission-mode`.
 *
 * Claude is the vendor where the axes are *not* independent. Codex keeps
 * "what may run" and "who answers" as separate fields; Claude has one flag
 * whose members mix both, so some product combinations are simply
 * unrepresentable. Those come back `supported: false` with a reason rather than
 * being quietly rounded to the nearest mode — a selector that silently swaps
 * `default` + `auto-review` for `acceptEdits` would offer the same label over a
 * different risk profile.
 *
 * | Mode            | What runs without asking                             |
 * | --------------- | ---------------------------------------------------- |
 * | `default`       | Reads only                                           |
 * | `acceptEdits`   | Reads, file edits, common filesystem commands        |
 * | `plan`          | Reads, plus classifier-approved commands under auto  |
 * | `auto`          | Everything, with a classifier reviewing each action  |
 * | `dontAsk`       | Only pre-approved tools                              |
 *
 * `auto` and `dontAsk` point in opposite directions and are never substituted
 * for one another. `auto` is the genuine auto-review analogue; `dontAsk` is for
 * locked-down CI and would silently *narrow* what a user asked to widen.
 *
 * ## Why this is resolved per account rather than declared
 *
 * `auto` is not a property of the binary. It needs a qualifying plan tier and a
 * supported model, an administrator can remove it with `disableAutoMode` in
 * managed settings — which makes the CLI **reject `--permission-mode auto` at
 * startup** — and Claude ignores `defaultMode: "auto"` coming from project or
 * local settings. A static table would therefore be wrong on some machines and
 * right on others, and the failure would surface as a turn that dies at startup
 * rather than as a choice the selector greyed out.
 */

import type {
  ExternalApprovalRouting,
  ExternalPermissionLevel,
  ExternalSupportedConfiguration,
} from '@mangostudio/shared/external-agents';
import { externalConfigurationMatrix } from '../permission-matrix';
import type { ClaudeAccountKind } from './auth';

/**
 * The `--permission-mode` values this adapter may pass.
 *
 * `default` is deliberately absent. It is the *config* spelling — what hooks
 * and SDK integrations persist — while the CLI's own choice list offers
 * `manual` as its alias. This adapter persists the canonical `default` and
 * passes `manual` on the command line, which is why the two vocabularies are
 * kept apart rather than unified into one string.
 */
export type ClaudeCliPermissionMode =
  | 'manual'
  | 'acceptEdits'
  | 'plan'
  | 'auto'
  | 'dontAsk'
  | 'bypassPermissions';

/** The canonical config spelling of the mode that reviews every action. */
export const CLAUDE_CANONICAL_DEFAULT_MODE = 'default' as const;

/** The command-line alias for {@link CLAUDE_CANONICAL_DEFAULT_MODE}. */
export const CLAUDE_CLI_DEFAULT_MODE = 'manual' as const;

/**
 * What the account's own effective default resolves to.
 *
 * MangoStudio's `default` level follows this rather than pinning `manual`.
 * Pinning would opt every Pro, Max and Team user out of the mode Claude is
 * moving them to on 2026-08-14, and MangoStudio would then be the only place
 * their agent behaved differently from every other Claude surface they use.
 */
export interface ClaudeEffectiveDefault {
  readonly mode: ClaudeCliPermissionMode;
  /** The canonical value persisted and fingerprinted. `default` when `mode` is `manual`. */
  readonly canonical: string;
}

/** Everything discovery learned that narrows the matrix. */
export interface ClaudeModeAvailability {
  /** Absent when `auth status` did not establish an account. */
  readonly accountKind?: ClaudeAccountKind;
  /** True when managed settings set `disableAutoMode` to `"disable"`. */
  readonly autoModeDisabledByPolicy: boolean;
  /**
   * Whether the account's own effective default is already `auto`.
   *
   * Read from a live `system/init.permissionMode`, not guessed from a date. The
   * 2026-08-14 flip lands during this cycle, and a test asserting a specific
   * mode string would start failing on the day the vendor changed it — which is
   * correct behaviour, not a regression.
   */
  readonly effectiveDefaultIsAuto: boolean;
}

/** i18n keys for every way a combination can be refused. */
export const CLAUDE_UNSUPPORTED_REASON_KEYS = {
  versionTooOld: 'externalAgents.unsupported.claudeVersionTooOld',
  /** `auto` needs a qualifying plan tier; an API key or a cloud provider has none. */
  autoNeedsSubscription: 'externalAgents.unsupported.claudeAutoNeedsSubscription',
  /** An administrator set `disableAutoMode`, and the CLI rejects `auto` at startup. */
  autoDisabledByPolicy: 'externalAgents.unsupported.claudeAutoDisabledByPolicy',
  /** Read-only is a whole session mode in Claude; nothing reviews inside it. */
  readOnlyHasNoReviewer: 'externalAgents.unsupported.claudeReadOnlyHasNoReviewer',
  /** Nothing left to review once every action is permitted. */
  fullAccessHasNoReviewer: 'externalAgents.unsupported.claudeFullAccessHasNoReviewer',
  /** The account could not be established, so no claim about `auto` is safe. */
  autoUnverified: 'externalAgents.unsupported.claudeAutoUnverified',
} as const;

/**
 * Whether `auto` may be passed at all, and why not when it may not.
 *
 * Fails closed on an unknown account. An unavailable `auto` that MangoStudio
 * passes anyway is a turn that dies at startup with a message the user cannot
 * act on; an `auto` marked unsupported when it would in fact have worked is one
 * greyed row with a reason. Only the second is recoverable by the person
 * reading it.
 */
export function claudeAutoModeRefusal(availability: ClaudeModeAvailability): string | undefined {
  if (availability.autoModeDisabledByPolicy) {
    return CLAUDE_UNSUPPORTED_REASON_KEYS.autoDisabledByPolicy;
  }
  if (availability.accountKind === undefined) {
    return CLAUDE_UNSUPPORTED_REASON_KEYS.autoUnverified;
  }
  if (availability.accountKind !== 'subscription') {
    return CLAUDE_UNSUPPORTED_REASON_KEYS.autoNeedsSubscription;
  }
  return undefined;
}

/**
 * The account's effective default, as a mode and as a canonical value.
 *
 * Follows the account: `auto` once the account is actually on it, `manual`
 * before. Policy wins over the observed value, because an administrator that
 * disabled `auto` has disabled it regardless of what a stale init record said.
 */
export function claudeEffectiveDefault(
  availability: ClaudeModeAvailability
): ClaudeEffectiveDefault {
  const autoAvailable = claudeAutoModeRefusal(availability) === undefined;
  return autoAvailable && availability.effectiveDefaultIsAuto
    ? { mode: 'auto', canonical: 'auto' }
    : { mode: CLAUDE_CLI_DEFAULT_MODE, canonical: CLAUDE_CANONICAL_DEFAULT_MODE };
}

/**
 * The `--permission-mode` value one (level, routing) pair resolves to.
 *
 * `undefined` means the pair is unrepresentable, which is the honest answer for
 * every routing choice other than the one Claude's chosen mode already implies.
 */
export function claudePermissionMode(
  level: ExternalPermissionLevel,
  routing: ExternalApprovalRouting,
  availability: ClaudeModeAvailability
): ClaudeCliPermissionMode | undefined {
  if (routing === 'auto-review') {
    // Only `default` + `auto-review` has a mode behind it. `plan` already means
    // read-only, so there is nothing for a classifier to review inside it, and
    // `bypassPermissions` has already permitted everything.
    if (level !== 'default') return undefined;
    return claudeAutoModeRefusal(availability) === undefined ? 'auto' : undefined;
  }
  switch (level) {
    case 'read-only':
      return 'plan';
    case 'default':
      return claudeEffectiveDefault(availability).mode;
    case 'full-access':
      // The supported spelling. `--dangerously-skip-permissions` and
      // `--allow-dangerously-skip-permissions` are never passed: they are the
      // interactive escape hatches, and this is the documented flag value.
      return 'bypassPermissions';
  }
}

/** The 2 × 3 matrix, minus whatever this account and this machine forbid. */
export function buildSupportedConfigurations(
  availability: ClaudeModeAvailability
): ExternalSupportedConfiguration[] {
  return externalConfigurationMatrix((level, routing) => {
    const mode = claudePermissionMode(level, routing, availability);
    if (mode) {
      // The canonical spelling crosses the wire, so the persisted `default` is
      // what the fingerprint and the UI see rather than the CLI's alias.
      const vendorId = mode === CLAUDE_CLI_DEFAULT_MODE ? CLAUDE_CANONICAL_DEFAULT_MODE : mode;
      return { supported: true, vendorId };
    }
    if (routing === 'auto-review') {
      if (level === 'read-only') {
        return {
          supported: false,
          reasonKey: CLAUDE_UNSUPPORTED_REASON_KEYS.readOnlyHasNoReviewer,
        };
      }
      if (level === 'full-access') {
        return {
          supported: false,
          reasonKey: CLAUDE_UNSUPPORTED_REASON_KEYS.fullAccessHasNoReviewer,
        };
      }
      return {
        supported: false,
        reasonKey:
          claudeAutoModeRefusal(availability) ?? CLAUDE_UNSUPPORTED_REASON_KEYS.autoUnverified,
        vendorId: 'auto',
      };
    }
    /* c8 ignore next -- every `user` routing above returns a mode. */
    return { supported: false, reasonKey: CLAUDE_UNSUPPORTED_REASON_KEYS.autoUnverified };
  });
}

/**
 * The same matrix, wholly unavailable for one reason.
 *
 * A machine that has Claude but cannot run it — a binary older than the pinned
 * minimum, say — still has to describe the choices it is refusing. An empty
 * list reads as "this target has no configurations", which is a different and
 * less useful statement than "here is why none of them can be selected".
 */
export function unsupportedConfigurations(reasonKey: string): ExternalSupportedConfiguration[] {
  return externalConfigurationMatrix(() => ({ supported: false, reasonKey }));
}

/**
 * Reads `disableAutoMode` out of a managed-settings document.
 *
 * Only the literal `"disable"` counts. The setting is administrator-authored
 * JSON that this code does not own, so anything else — a boolean, a typo, a
 * missing file — leaves `auto` decided by the account instead of by a guess
 * about what an unrecognized value meant.
 */
export function readAutoModeDisabled(managedSettings: unknown): boolean {
  if (typeof managedSettings !== 'object' || managedSettings === null) return false;
  return (managedSettings as { readonly disableAutoMode?: unknown }).disableAutoMode === 'disable';
}
