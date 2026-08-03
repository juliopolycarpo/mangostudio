/**
 * Reading and writing what a runtime keeps on the machine it runs on.
 *
 * The shape lives in `@mangostudio/shared/runtime-home`; this is the half that
 * touches disk. Two files rather than one, because they have different rules:
 * `runtime.json` must stay safe to paste into a bug report, and
 * `credentials.json` must never leave the machine. Merging them would make the
 * safe half unpasteable.
 *
 * Writes go through a temporary file and a rename. Two hubs can provision one
 * machine at once, and a reader must never see a half-written config.
 */

import { chmod, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  type ResolvedRuntimeSlotConfig,
  type RuntimeInstallSource,
  type RuntimeSlot,
  type RuntimeSlotConfig,
  RuntimeSlotConfigSchema,
  resolveRuntimeSlotConfig,
  runtimeSlotConfigPath,
  runtimeSlotCredentialsPath,
  runtimeSlotForPath,
  runtimeSlotDir as sharedRuntimeSlotDir,
} from '@mangostudio/shared/runtime-home';
import { Value } from '@sinclair/typebox/value';
import { loadRuntimeConfig } from './config';

export type { RuntimeSlot } from '@mangostudio/shared/runtime-home';

/**
 * The phrase a runtime prints when it refuses a slot its owner has not
 * consented to yet, and the sentence built around it.
 *
 * It is a constant because a second party reads it. A hub launching a runtime
 * over SSH sees only the remote side's exit code and stderr — ssh reports its
 * own failures as 255 and passes everything else through — so "not set up yet"
 * and "no binary there" are told apart by signature. Two spellings of the same
 * refusal would make the hub classify a consent gate as a missing install and
 * send the user to reinstall something that is already present.
 */
export const RUNTIME_SETUP_PENDING_SIGNATURE = 'runtime setup is pending on this machine';
export const RUNTIME_SETUP_PENDING_MESSAGE = `${RUNTIME_SETUP_PENDING_SIGNATURE}. Run "mangostudio-runtime setup" there before connecting it.`;

const CONFIG_LOCK_FILE = 'runtime.lock';
const CREDENTIALS_LOCK_FILE = 'credentials.lock';
const OWNER_ONLY = 0o600;
/** How long a writer waits for another process before failing the lock. */
const SLOT_LOCK_TIMEOUT_MS = 5_000;
const SLOT_LOCK_POLL_MS = 25;

interface RuntimeSlotCredentials {
  readonly schemaVersion: 1;
  readonly pairingToken?: string;
  readonly serveToken?: string;
}

/** What was on disk, plus why it could not be trusted when that happened. */
export interface RuntimeSlotState {
  readonly config: ResolvedRuntimeSlotConfig;
  /**
   * The file exactly as stored, or null when there was none. Callers that need
   * to tell "nobody has answered yet" from "somebody answered no" read this:
   * the resolved config fills both in as a refusal, and they are not the same
   * situation.
   */
  readonly stored: RuntimeSlotConfig | null;
  /**
   * Set when a file was present but unusable. A corrupt `runtime.json` must not
   * read as an absent one: for `host` and `wsl` absence means full consent, so
   * swallowing the parse error would silently widen what a machine allows.
   */
  readonly error: string | null;
}

function homeOptions(env?: NodeJS.ProcessEnv) {
  return { mangoHome: loadRuntimeConfig(env).mangoHome, platform: process.platform };
}

export function runtimeSlotDir(slot: RuntimeSlot, env?: NodeJS.ProcessEnv): string {
  return sharedRuntimeSlotDir(slot, homeOptions(env));
}

/**
 * Which slot governs this process, from where its executable sits.
 *
 * The same binary serves a `host` install and an ssh-pushed `remote` one, and
 * only its location says which consent file applies. A binary outside the home
 * entirely — beside a hub, or on a PATH — is the machine's own install, so it
 * answers to `host`.
 */
export function resolveRuntimeSlot(
  env: NodeJS.ProcessEnv = process.env,
  executablePaths: readonly string[] = [process.execPath, process.argv[1] ?? '']
): RuntimeSlot {
  const options = homeOptions(env);
  for (const path of executablePaths) {
    if (!path) continue;
    const slot = runtimeSlotForPath(path, options);
    if (slot) return slot;
  }
  return 'host';
}

/**
 * Where these bytes came from, which is what tells a `host` slot apart.
 *
 * A checkout runs `bun apps/runtime/src/cli.ts`, so the executable is Bun
 * itself and there is no runtime binary to point at. Anything under the runtime
 * home was put there by an install; anything else is the binary a release
 * shipped beside the hub.
 */
export function resolveRuntimeSource(
  env: NodeJS.ProcessEnv = process.env,
  execPath: string = process.execPath
): RuntimeInstallSource {
  const name = basename(execPath).toLowerCase();
  if (name === 'bun' || name === 'bun.exe') return 'source-checkout';
  return runtimeSlotForPath(execPath, homeOptions(env)) ? 'provisioned' : 'bundled';
}

/** The binary this process is, or null in a checkout where there is none. */
export function resolveRuntimeBinaryPath(
  env: NodeJS.ProcessEnv = process.env,
  execPath: string = process.execPath
): string | null {
  return resolveRuntimeSource(env, execPath) === 'source-checkout' ? null : execPath;
}

/**
 * Reads a slot's config with every default filled in.
 *
 * A file that is absent is not an error — most slots never have one — but a
 * file that is present and unreadable is, and it travels on the result rather
 * than being thrown: callers that only wanted the hub URL should not die on it,
 * and callers that gate on consent need to see it.
 */
export async function readRuntimeSlotState(
  slot: RuntimeSlot,
  env?: NodeJS.ProcessEnv
): Promise<RuntimeSlotState> {
  const path = runtimeSlotConfigPath(slot, homeOptions(env));
  const fallback = { source: resolveRuntimeSource(env) };

  const unusable = (error: string): RuntimeSlotState => ({
    config: resolveRuntimeSlotConfig(slot, null, fallback),
    stored: null,
    error,
  });

  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    // Only a confirmed absence may take the slot default, because for `host`
    // and `wsl` that default is full consent. `EACCES`, `EISDIR`, `EPERM` and
    // `EIO` all mean a file is there and this process cannot see what it says,
    // which is an unknown answer — and an unknown answer is never yes.
    // `ENOTDIR` joins `ENOENT`: a path component that is not a directory
    // cannot be holding the file.
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      return unusable(`${path} could not be read (${describe(error)}).`);
    }
    return { config: resolveRuntimeSlotConfig(slot, null, fallback), stored: null, error: null };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return unusable(`${path} is not valid JSON (${describe(error)}).`);
  }

  if (!Value.Check(RuntimeSlotConfigSchema, parsed)) {
    return unusable(`${path} does not match the runtime config schema.`);
  }
  // The stored slot is informational; the directory the file was read from is
  // what a slot means, and a copied file must not relabel where it landed.
  return { config: resolveRuntimeSlotConfig(slot, parsed, fallback), stored: parsed, error: null };
}

/** The resolved config alone, for callers with nothing to do about a bad file. */
export async function readRuntimeSlotConfig(
  slot: RuntimeSlot,
  env?: NodeJS.ProcessEnv
): Promise<ResolvedRuntimeSlotConfig> {
  return (await readRuntimeSlotState(slot, env)).config;
}

/**
 * Merges an update into the stored config and republishes it atomically.
 *
 * Only the fields named are touched. An installer writing `version` and
 * `digest` must not disturb the consent someone answered, and `setup` writing
 * consent must not disturb the hub URL a `connect` remembered.
 *
 * Locked for the same reason the credentials are: read-merge-rename loses the
 * other writer's field when two of them interleave, and the field at stake here
 * is `allow`. A `setup` narrowing a machine to `readonly` while a `connect`
 * records a hub URL must not come back as full permissions.
 */
export async function writeRuntimeSlotConfig(
  slot: RuntimeSlot,
  update: Partial<Omit<RuntimeSlotConfig, 'schemaVersion' | 'slot'>>,
  env?: NodeJS.ProcessEnv
): Promise<void> {
  const path = runtimeSlotConfigPath(slot, homeOptions(env));
  await withSlotLock(slot, CONFIG_LOCK_FILE, env, async () => {
    const stored = await readStoredRuntimeSlotConfig(path);
    const next: RuntimeSlotConfig = { ...stored, ...update, schemaVersion: 1, slot };
    await writeFileAtomically(path, stripUndefined(next));
  });
}

/** The file exactly as written, with no defaults applied — merge input only. */
async function readStoredRuntimeSlotConfig(path: string): Promise<RuntimeSlotConfig> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (Value.Check(RuntimeSlotConfigSchema, parsed)) return parsed;
  } catch {
    // A file this process cannot parse is one this write replaces. The read
    // path reports it; refusing to write here would leave the slot stuck.
  }
  return { schemaVersion: 1, slot: 'host' };
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
  return await withSlotLock(slot, CREDENTIALS_LOCK_FILE, env, async () => {
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
  });
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
  return await withSlotLock(slot, CREDENTIALS_LOCK_FILE, env, async () => {
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
  });
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
  const path = runtimeSlotCredentialsPath(slot, homeOptions(env));
  try {
    return { schemaVersion: 1, ...(JSON.parse(await readFile(path, 'utf8')) as object) };
  } catch {
    // Missing is the common case, and a file this process cannot parse is one
    // a later write replaces; neither is worth failing a connect over.
    return { schemaVersion: 1 };
  }
}

/**
 * Serializes writers of one file in one slot across processes.
 *
 * Every writer here does read-merge-rename, which loses the other's field when
 * two interleave: `connect` and `serve` share one credentials.json, and `setup`
 * and an installer share one runtime.json. Each file gets its own lock, so a
 * credential rotation never waits behind a consent write.
 */
async function withSlotLock<T>(
  slot: RuntimeSlot,
  lockFile: string,
  env: NodeJS.ProcessEnv | undefined,
  run: () => Promise<T>
): Promise<T> {
  const directory = runtimeSlotDir(slot, env);
  await mkdir(directory, { recursive: true });
  const lockPath = join(directory, lockFile);
  const deadline = Date.now() + SLOT_LOCK_TIMEOUT_MS;

  while (true) {
    try {
      const handle = await open(lockPath, 'wx');
      try {
        return await run();
      } finally {
        await handle.close().catch(() => undefined);
        await unlink(lockPath).catch(() => undefined);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for the runtime slot lock at ${lockPath}.`);
      }
      await sleepMs(SLOT_LOCK_POLL_MS);
    }
  }
}

async function writeCredentials(
  slot: RuntimeSlot,
  credentials: RuntimeSlotCredentials,
  env: NodeJS.ProcessEnv | undefined,
  platform: NodeJS.Platform
): Promise<{ readonly restricted: boolean }> {
  const path = runtimeSlotCredentialsPath(slot, homeOptions(env));
  await writeFileAtomically(path, credentials, OWNER_ONLY);
  if (platform === 'win32') return { restricted: false };
  try {
    await chmod(path, OWNER_ONLY);
    return { restricted: true };
  } catch {
    return { restricted: false };
  }
}

/** Drops keys an update explicitly cleared, so they leave the file entirely. */
function stripUndefined(value: RuntimeSlotConfig): RuntimeSlotConfig {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  ) as RuntimeSlotConfig;
}

/**
 * Publishes a document with a rename, so a reader never sees half of one.
 *
 * The temporary name carries a random suffix rather than only the pid: two
 * writes racing inside one process — a `connect` remembering its hub URL while
 * a `setup` in the same binary records consent — would otherwise share a
 * filename, and the first rename would take the second's file out from under
 * it. The pid alone is unique across hubs and not across concurrent callers.
 */
async function writeFileAtomically(path: string, value: unknown, mode?: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      ...(mode === undefined ? {} : { mode }),
    });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as { unref?: () => void }).unref?.();
  });
}
