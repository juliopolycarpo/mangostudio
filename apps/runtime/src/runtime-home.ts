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

/** Operator consent for serving this slot; absent means the gate is not armed. */
export type RuntimeSetupState = 'pending' | 'ready';

const CONFIG_FILE = 'runtime.json';
const CREDENTIALS_FILE = 'credentials.json';
const OWNER_ONLY = 0o600;

export interface RuntimeSlotConfig {
  readonly schemaVersion: 1;
  readonly slot: RuntimeSlot;
  /** The hub address `connect` dials, remembered so later runs need no flags. */
  readonly hubUrl?: string;
  /**
   * When `pending`, `serve` refuses before listening. Absent means the setup
   * CLI has not written a gate yet, so serving is allowed.
   */
  readonly setupState?: RuntimeSetupState;
}

interface RuntimeSlotCredentials {
  readonly schemaVersion: 1;
  readonly pairingToken?: string;
  readonly serveToken?: string;
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
  return {
    schemaVersion: 1,
    slot,
    ...(stored?.hubUrl ? { hubUrl: stored.hubUrl } : {}),
    ...(stored?.setupState === 'pending' || stored?.setupState === 'ready'
      ? { setupState: stored.setupState }
      : {}),
  };
}

export async function writeRuntimeSlotConfig(
  slot: RuntimeSlot,
  update: { readonly hubUrl?: string; readonly setupState?: RuntimeSetupState },
  env?: NodeJS.ProcessEnv
): Promise<void> {
  const current = await readRuntimeSlotConfig(slot, env);
  const next: RuntimeSlotConfig = {
    schemaVersion: 1,
    slot,
    ...((update.hubUrl ?? current.hubUrl) ? { hubUrl: update.hubUrl ?? current.hubUrl } : {}),
    ...((update.setupState ?? current.setupState)
      ? { setupState: update.setupState ?? current.setupState }
      : {}),
  };
  await writeFileAtomically(join(runtimeSlotDir(slot, env), CONFIG_FILE), next);
}

export async function readPairingToken(
  slot: RuntimeSlot,
  env?: NodeJS.ProcessEnv
): Promise<string | null> {
  const stored = await readCredentials(slot, env);
  return stored.pairingToken ?? null;
}

/**
 * Persists the credential owner-only. On a filesystem that cannot express that
 * — a Windows volume, a mounted share — the write still happens and the caller
 * is told, rather than the runtime pretending the file is protected.
 *
 * Windows is reported as unrestricted unconditionally, and that is not
 * pessimism. `chmod` there resolves after setting the read-only attribute and
 * reports success, so a `restricted: true` on Windows would mean "the call did
 * not throw", not "no other account can read this" — and the whole point of
 * the flag is the second sentence. Owner-only access needs an ACL this
 * runtime does not set yet, so it says so instead.
 */
export async function writePairingToken(
  slot: RuntimeSlot,
  token: string,
  env?: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform
): Promise<{ readonly restricted: boolean }> {
  const current = await readCredentials(slot, env);
  return await writeCredentials(
    slot,
    {
      schemaVersion: 1,
      pairingToken: token,
      ...(current.serveToken ? { serveToken: current.serveToken } : {}),
    },
    env,
    platform
  );
}

export async function readServeToken(
  slot: RuntimeSlot,
  env?: NodeJS.ProcessEnv
): Promise<string | null> {
  const stored = await readCredentials(slot, env);
  return stored.serveToken ?? null;
}

/**
 * Persists the serve credential the same way as the pairing token: owner-only
 * when the filesystem allows it, and never in the pasteable config file.
 */
export async function writeServeToken(
  slot: RuntimeSlot,
  token: string,
  env?: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform
): Promise<{ readonly restricted: boolean }> {
  const current = await readCredentials(slot, env);
  return await writeCredentials(
    slot,
    {
      schemaVersion: 1,
      serveToken: token,
      ...(current.pairingToken ? { pairingToken: current.pairingToken } : {}),
    },
    env,
    platform
  );
}

/**
 * Generates a serve token, stores it, and returns it. Callers that show it
 * once to the operator should print it immediately — nothing re-reads it for
 * display after this.
 */
export async function bootstrapServeToken(
  slot: RuntimeSlot,
  env?: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform
): Promise<{ readonly token: string; readonly restricted: boolean }> {
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
  const { restricted } = await writeServeToken(slot, token, env, platform);
  return { token, restricted };
}

async function readCredentials(
  slot: RuntimeSlot,
  env?: NodeJS.ProcessEnv
): Promise<RuntimeSlotCredentials> {
  const stored = await readJsonFile<RuntimeSlotCredentials>(
    join(runtimeSlotDir(slot, env), CREDENTIALS_FILE)
  );
  return { schemaVersion: 1, ...(stored ?? {}) };
}

async function writeCredentials(
  slot: RuntimeSlot,
  credentials: RuntimeSlotCredentials,
  env: NodeJS.ProcessEnv | undefined,
  platform: NodeJS.Platform
): Promise<{ readonly restricted: boolean }> {
  const path = join(runtimeSlotDir(slot, env), CREDENTIALS_FILE);
  await writeFileAtomically(path, credentials, OWNER_ONLY);
  if (platform === 'win32') return { restricted: false };
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
