/**
 * What a connected host re-reads when deciding whether a method may run.
 *
 * Consent is recorded in `runtime.json` and can change while a connection is
 * open — `setup` is how an owner narrows a machine after it is already serving.
 * Capturing the allow set once at connect would leave that change invisible
 * until reconnect, which is exactly the window a model spends retrying a
 * shell tool the user just took away.
 *
 * Reads are cheap; the mtime/size cache keeps the ordinary call path off the
 * filesystem when nothing has moved.
 */

import { stat } from 'node:fs/promises';
import {
  RUNTIME_CONSENT_PRESETS,
  type RuntimeCapabilityAllow,
  type RuntimeSlot,
  runtimeSlotConfigPath,
} from '@mangostudio/shared/runtime-home';
import { loadRuntimeConfig } from './config';
import { readRuntimeSlotState } from './runtime-home';

export interface RuntimeConsentSource {
  readonly slot: RuntimeSlot;
  /** Last known allow set; sync so a host can build its hello without awaiting. */
  current(): RuntimeCapabilityAllow;
  /** Re-read the slot file when its mtime or size changed; otherwise return the cache. */
  refresh(): Promise<RuntimeCapabilityAllow>;
}

/** Fixed allow set for tests and for callers that already resolved consent once. */
export function staticConsentSource(
  allow: RuntimeCapabilityAllow,
  slot: RuntimeSlot
): RuntimeConsentSource {
  return {
    slot,
    current: () => allow,
    refresh: async () => allow,
  };
}

export function createSlotConsentSource(options: {
  readonly slot: RuntimeSlot;
  readonly initial?: RuntimeCapabilityAllow;
  readonly env?: NodeJS.ProcessEnv;
}): RuntimeConsentSource {
  const env = options.env;
  const slot = options.slot;
  let allow = options.initial ?? RUNTIME_CONSENT_PRESETS.full;
  let fingerprint: string | null = null;

  return {
    slot,
    current: () => allow,
    refresh: async () => {
      const path = runtimeSlotConfigPath(slot, {
        mangoHome: loadRuntimeConfig(env).mangoHome,
        platform: process.platform,
      });

      let nextFingerprint: string | null = null;
      try {
        const info = await stat(path);
        nextFingerprint = `${info.mtimeMs}:${info.size}`;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') {
          // Unreadable is not "unchanged": fall through and let readRuntimeSlotState
          // report the error and apply the slot's safe default.
          fingerprint = null;
        } else if (fingerprint === 'absent') {
          return allow;
        } else {
          nextFingerprint = 'absent';
        }
      }

      if (nextFingerprint !== null && nextFingerprint === fingerprint) {
        return allow;
      }

      const state = await readRuntimeSlotState(slot, env);
      allow = state.error ? RUNTIME_CONSENT_PRESETS.none : state.config.allow;
      fingerprint = nextFingerprint ?? 'read';
      return allow;
    },
  };
}
