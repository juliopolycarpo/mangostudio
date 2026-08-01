/**
 * Where a dial-in runtime keeps what it needs to reconnect on its own.
 *
 * `~/.mango/runtime/<slot>/` is the layout the whole runtime home will use; a
 * slot names who put the runtime there, not which transport talks to it, and a
 * machine paired over WebSocket is a `remote` one. Only the two files this
 * transport needs exist here — the full manifest, consent state, and versioned
 * binary directories arrive with the setup CLI.
 *
 * Two files rather than one, because they have different rules: `runtime.json`
 * must stay safe to paste into a bug report, and `credentials.json` must never
 * leave the machine. Merging them would make the safe half unpasteable.
 */

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Who placed the runtime in this directory. */
export type RuntimeSlot = 'host' | 'wsl' | 'remote';

const CONFIG_FILE = 'runtime.json';
const CREDENTIALS_FILE = 'credentials.json';
const OWNER_ONLY = 0o600;

export interface RuntimeSlotConfig {
  readonly schemaVersion: 1;
  readonly slot: RuntimeSlot;
  /** The hub address `connect` dials, remembered so later runs need no flags. */
  readonly hubUrl?: string;
}

interface RuntimeSlotCredentials {
  readonly schemaVersion: 1;
  readonly pairingToken?: string;
}

/** Root of the runtime home. `MANGO_HOME` moves it, which is what tests use. */
function runtimeHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.MANGO_HOME?.trim();
  return join(override && override.length > 0 ? override : join(homedir(), '.mango'), 'runtime');
}

export function runtimeSlotDir(slot: RuntimeSlot, env?: NodeJS.ProcessEnv): string {
  return join(runtimeHomeDir(env), slot);
}

export async function readRuntimeSlotConfig(
  slot: RuntimeSlot,
  env?: NodeJS.ProcessEnv
): Promise<RuntimeSlotConfig> {
  const stored = await readJsonFile<RuntimeSlotConfig>(
    join(runtimeSlotDir(slot, env), CONFIG_FILE)
  );
  return { schemaVersion: 1, slot, ...(stored?.hubUrl ? { hubUrl: stored.hubUrl } : {}) };
}

export async function writeRuntimeSlotConfig(
  slot: RuntimeSlot,
  update: { readonly hubUrl?: string },
  env?: NodeJS.ProcessEnv
): Promise<void> {
  const current = await readRuntimeSlotConfig(slot, env);
  const next: RuntimeSlotConfig = {
    schemaVersion: 1,
    slot,
    ...((update.hubUrl ?? current.hubUrl) ? { hubUrl: update.hubUrl ?? current.hubUrl } : {}),
  };
  await writeFileAtomically(join(runtimeSlotDir(slot, env), CONFIG_FILE), next);
}

export async function readPairingToken(
  slot: RuntimeSlot,
  env?: NodeJS.ProcessEnv
): Promise<string | null> {
  const stored = await readJsonFile<RuntimeSlotCredentials>(
    join(runtimeSlotDir(slot, env), CREDENTIALS_FILE)
  );
  return stored?.pairingToken ?? null;
}

/**
 * Persists the credential owner-only. On a filesystem that cannot express that
 * — a Windows volume, a mounted share — the write still happens and the caller
 * is told, rather than the runtime pretending the file is protected.
 */
export async function writePairingToken(
  slot: RuntimeSlot,
  token: string,
  env?: NodeJS.ProcessEnv
): Promise<{ readonly restricted: boolean }> {
  const path = join(runtimeSlotDir(slot, env), CREDENTIALS_FILE);
  const credentials: RuntimeSlotCredentials = { schemaVersion: 1, pairingToken: token };
  await writeFileAtomically(path, credentials, OWNER_ONLY);
  try {
    await chmod(path, OWNER_ONLY);
    return { restricted: true };
  } catch {
    return { restricted: false };
  }
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    // Missing is the common case, and a file this process cannot parse is one
    // a later write replaces; neither is worth failing a connect over.
    return null;
  }
}

/**
 * Writes through a temporary file in the same directory. Two hubs can provision
 * one machine at once, and a reader must never see a half-written config.
 */
async function writeFileAtomically(path: string, value: unknown, mode?: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    ...(mode === undefined ? {} : { mode }),
  });
  await rename(temporary, path);
}
