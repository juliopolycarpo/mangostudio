/**
 * Turning what is on disk into what a runtime is allowed to do.
 *
 * Two rules carry the whole file. Profiles are presets over `allow`, never a
 * second source of truth — the stored `allow` set decides, and the profile name
 * is re-derived from it so a hand-edited file cannot claim `readonly` while
 * granting a shell. And a missing answer takes the slot's default rather than
 * failing, because the default is a real decision: `host` and `wsl` were placed
 * by somebody with an account on the machine, `remote` was placed by somebody's
 * hub.
 */

import type {
  ResolvedRuntimeSlotConfig,
  RuntimeCapabilityAllow,
  RuntimeConsentProfile,
  RuntimeInstallSource,
  RuntimeSetupRecord,
  RuntimeSlot,
  RuntimeSlotConfig,
} from './schemas';
import { RuntimeCapabilityAllowSchema } from './schemas';

/**
 * Every capability name, taken from the schema so the two can never disagree.
 * `--allow k=v` validates against this, and `health` iterates it.
 */
export const RUNTIME_CAPABILITY_KEYS = Object.keys(
  RuntimeCapabilityAllowSchema.properties
) as readonly (keyof RuntimeCapabilityAllow)[];

function allowWith(overrides: Partial<RuntimeCapabilityAllow>, fill: boolean) {
  return Object.fromEntries(
    RUNTIME_CAPABILITY_KEYS.map((key) => [key, overrides[key] ?? fill])
  ) as RuntimeCapabilityAllow;
}

/**
 * The presets a user can name. `custom` is absent on purpose: it is what any
 * other combination is called, not something you can ask for.
 *
 * `readonly` leaves `checkpoints` off even though the plan for it reads like a
 * read: a checkpoint writes a snapshot of the file it captures, and a profile
 * whose promise is "nothing on this machine changes" cannot make an exception
 * for the feature that exists to change files back.
 */
export const RUNTIME_CONSENT_PRESETS: Readonly<
  Record<Exclude<RuntimeConsentProfile, 'custom'>, RuntimeCapabilityAllow>
> = {
  full: allowWith({}, true),
  readonly: allowWith({ fsRead: true, git: true, probing: true, library: true }, false),
  none: allowWith({}, false),
};

/** Names the stored set, or `custom` when it matches no preset. */
export function profileForAllow(allow: RuntimeCapabilityAllow): RuntimeConsentProfile {
  for (const [name, preset] of Object.entries(RUNTIME_CONSENT_PRESETS)) {
    if (RUNTIME_CAPABILITY_KEYS.every((key) => preset[key] === allow[key])) {
      return name as RuntimeConsentProfile;
    }
  }
  return 'custom';
}

/**
 * What a slot means when nothing has answered for it yet.
 *
 * `remote` defaulting to `pending` is the gate D11 asks for, and it has to come
 * from absence rather than from a file: the thing that installs a remote
 * runtime is somebody else's hub, and a gate that only exists once that hub
 * writes it is a gate that hub can decline to write.
 */
export function defaultConsentForSlot(slot: RuntimeSlot): {
  readonly allow: RuntimeCapabilityAllow;
  readonly setup: RuntimeSetupRecord;
} {
  return slot === 'remote'
    ? { allow: RUNTIME_CONSENT_PRESETS.none, setup: { state: 'pending' } }
    : { allow: RUNTIME_CONSENT_PRESETS.full, setup: { state: 'configured' } };
}

/**
 * Whether an unanswered slot records protocol calls.
 *
 * Off for `host` — the machine's own hub is noise. On for `wsl` and `remote`,
 * where another machine's hub reaches in and the receipt is the point.
 */
export function defaultAuditEnabledForSlot(slot: RuntimeSlot): boolean {
  return slot !== 'host';
}

/**
 * Fills every default in, so callers reason about one fully-populated shape.
 *
 * A stored `allow` that is missing keys — written by an older runtime, or by a
 * newer one that dropped a capability — takes the *slot default* for those
 * keys, not `true`. An unknown capability must never be granted by omission.
 */
export function resolveRuntimeSlotConfig(
  slot: RuntimeSlot,
  stored: RuntimeSlotConfig | null,
  fallback: { readonly source: RuntimeInstallSource }
): ResolvedRuntimeSlotConfig {
  const defaults = defaultConsentForSlot(slot);
  const allow = stored?.allow
    ? (Object.fromEntries(
        RUNTIME_CAPABILITY_KEYS.map((key) => [key, stored.allow?.[key] ?? defaults.allow[key]])
      ) as RuntimeCapabilityAllow)
    : defaults.allow;

  return {
    schemaVersion: stored?.schemaVersion ?? 1,
    slot,
    source: stored?.source ?? fallback.source,
    version: stored?.version ?? null,
    binaryPath: stored?.binaryPath ?? null,
    digest: stored?.digest ?? null,
    // The stored name is a label; the set is the decision. Re-deriving keeps a
    // hand-edited file from claiming `readonly` over a full `allow`.
    profile: profileForAllow(allow),
    allow,
    setup: stored?.setup ?? defaults.setup,
    installedBy: stored?.installedBy ?? null,
    hubUrl: stored?.hubUrl ?? null,
    audit: {
      enabled: stored?.audit?.enabled ?? defaultAuditEnabledForSlot(slot),
    },
  };
}

/** Capabilities a resolved consent denies, for a refusal that names them. */
export function deniedCapabilities(
  allow: RuntimeCapabilityAllow
): readonly (keyof RuntimeCapabilityAllow)[] {
  return RUNTIME_CAPABILITY_KEYS.filter((key) => !allow[key]);
}
