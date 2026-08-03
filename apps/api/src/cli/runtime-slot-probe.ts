/**
 * What the runtime home on this machine holds.
 *
 * Doctor reports it because the consent file is the only thing that decides
 * what a hub may do on a machine, and a runtime that is installed, reachable,
 * and refusing everything looks identical from the outside to one that is not
 * there. The hub reads it, never writes it: consent is authored by
 * `mangostudio-runtime setup` on the machine it governs.
 *
 * Only this machine's slots appear. A `wsl` slot lives inside the distribution
 * and a `remote` one on the far host, so a plain install has just `host` — and
 * often not even that, since a `host` slot with no file means full consent.
 *
 * The home comes from `getRuntimeHomeMangoDir`, not from this hub's own
 * `~/.mango`: a spawned runtime inherits `MANGO_HOME` from here, and doctor
 * reporting on a directory the runtime beside it does not use would be worse
 * than reporting nothing.
 */

import { readFile, stat } from 'node:fs/promises';
import {
  type ResolvedRuntimeSlotConfig,
  type RuntimeSlot,
  RuntimeSlotConfigSchema,
  resolveRuntimeSlotConfig,
  runtimeSlotConfigPath,
  runtimeSlotDir,
} from '@mangostudio/shared/runtime-home';
import { Value } from '@sinclair/typebox/value';
import { getRuntimeHomeMangoDir } from '../lib/config';

const SLOTS: readonly RuntimeSlot[] = ['host', 'wsl', 'remote'];

export interface RuntimeSlotProbe {
  readonly slot: RuntimeSlot;
  readonly directory: string;
  readonly config: ResolvedRuntimeSlotConfig;
  /** Set when a `runtime.json` is present but unreadable. */
  readonly error: string | null;
}

/**
 * Reports every slot that exists on disk. A slot with no directory is not
 * reported at all — three rows saying "nothing here" would bury the one row
 * that matters on a machine that does have a runtime home.
 */
export async function probeRuntimeSlots(
  mangoHome: string = getRuntimeHomeMangoDir()
): Promise<RuntimeSlotProbe[]> {
  const probes = await Promise.all(SLOTS.map((slot) => probeSlot(slot, mangoHome)));
  return probes.filter((probe): probe is RuntimeSlotProbe => probe !== null);
}

async function probeSlot(slot: RuntimeSlot, mangoHome: string): Promise<RuntimeSlotProbe | null> {
  const options = { mangoHome, platform: process.platform };
  const directory = runtimeSlotDir(slot, options);
  if (!(await isDirectory(directory))) return null;

  const base = { slot, directory };
  let raw: string;
  try {
    raw = await readFile(runtimeSlotConfigPath(slot, options), 'utf8');
  } catch {
    return { ...base, config: resolve(slot, null), error: null };
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    return Value.Check(RuntimeSlotConfigSchema, parsed)
      ? { ...base, config: resolve(slot, parsed), error: null }
      : { ...base, config: resolve(slot, null), error: 'does not match the runtime config schema' };
  } catch {
    return { ...base, config: resolve(slot, null), error: 'is not valid JSON' };
  }
}

function resolve(
  slot: RuntimeSlot,
  stored: Parameters<typeof resolveRuntimeSlotConfig>[1]
): ResolvedRuntimeSlotConfig {
  // The hub cannot tell how the bytes in another machine's slot got there, and
  // a slot directory on this machine was put there by an install either way.
  return resolveRuntimeSlotConfig(slot, stored, { source: 'provisioned' });
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
