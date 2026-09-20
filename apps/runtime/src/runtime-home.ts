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

import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { RUNTIME_SETUP_PENDING_SIGNATURE } from '@mangostudio/shared/runtime-contract';
import {
  type ResolvedRuntimeSlotConfig,
  RUNTIME_CONFIG_LOCK_FILE_NAME,
  RUNTIME_CONSENT_PRESETS,
  type RuntimeCapabilityAllow,
  type RuntimeInstallSource,
  type RuntimeSlot,
  type RuntimeSlotConfig,
  RuntimeSlotConfigSchema,
  type RuntimeSlotCredentials,
  RuntimeSlotCredentialsSchema,
  resolveRuntimeSlotConfig,
  runtimeSlotConfigPath,
  runtimeSlotCredentialsPath,
  runtimeSlotForPath,
  runtimeSlotDir as sharedRuntimeSlotDir,
} from '@mangostudio/shared/runtime-home';
import Value from 'typebox/value';
import { loadRuntimeConfig } from './config';
import { defaultOwnerOnlyDeps, type OwnerOnlyDeps, restrictToOwner } from './services/owner-only';

export type { RuntimeSlot } from '@mangostudio/shared/runtime-home';

/**
 * The signature a hub greps this runtime's stderr for is a shared contract, not
 * a runtime detail — it lives in `@mangostudio/shared/runtime-contract` and is
 * re-exported here for the callers that already name this module. The sentence
 * built around it stays local: only the signature crosses.
 */
export { RUNTIME_SETUP_PENDING_SIGNATURE };
export const RUNTIME_SETUP_PENDING_MESSAGE = `${RUNTIME_SETUP_PENDING_SIGNATURE}. Run "mangostudio-runtime setup" there before connecting it.`;

const CONFIG_LOCK_FILE = RUNTIME_CONFIG_LOCK_FILE_NAME;
const CREDENTIALS_LOCK_FILE = 'credentials.lock';
/** The only `credentials.json` shape this build reads or writes. */
const CREDENTIALS_SCHEMA_VERSION = 1;
const OWNER_ONLY = 0o600;
/** How long a writer waits for another process before failing the lock. */
const SLOT_LOCK_TIMEOUT_MS = 5_000;
const SLOT_LOCK_POLL_MS = 25;
/**
 * When a lock whose owner cannot be identified counts as abandoned. Every
 * holder writes one small document, so this is orders of magnitude past any
 * honest hold; it only ever applies when the pid check cannot.
 */
const SLOT_LOCK_STALE_MS = 60_000;

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
  await withSlotLock(slot, CONFIG_LOCK_FILE, env, () => mergeRuntimeSlotConfig(path, slot, update));
}

/** The merge itself, for callers already holding the lock. */
async function mergeRuntimeSlotConfig(
  path: string,
  slot: RuntimeSlot,
  update: Partial<Omit<RuntimeSlotConfig, 'schemaVersion' | 'slot'>>
): Promise<void> {
  const stored = await readStoredRuntimeSlotConfig(path);
  const next: RuntimeSlotConfig = { ...stored, ...update, schemaVersion: 1, slot };
  await writeFileAtomically(path, stripUndefined(next));
}

/** Whether an invocation may serve, and whether answering it wrote anything. */
export interface RuntimeInvocationConsent {
  readonly granted: boolean;
  readonly recorded: boolean;
  readonly reason?: string;
  /**
   * What was granted, for the gate the host installs over its handlers. Empty
   * on a refusal: nothing is served, so nothing is permitted.
   */
  readonly allow: RuntimeCapabilityAllow;
}

/**
 * Consent for the two entry points a person starts by hand.
 *
 * Refuses when a config on disk says `pending` — somebody staged this machine
 * for an answer and has not given one — and when the config cannot be read at
 * all. An unreadable consent file is an unknown answer, and an unknown answer
 * must never resolve to yes: the file it replaced may well have narrowed this
 * machine to `readonly`, and rewriting it here would widen that silently.
 *
 * A slot with genuinely no config is answered here and written down, so that
 * `health` afterwards says what this machine allows rather than leaving it to
 * be inferred.
 *
 * It lives beside the lock because reading, deciding and writing have to be one
 * transaction. Split across the lock's edge, a `setup` narrowing this slot in
 * the gap between the read and the write would complete, and then be overwritten
 * with `full` by a decision taken before it ran.
 */
export async function consentByInvocation(
  slot: RuntimeSlot,
  runtimeVersion: string,
  env?: NodeJS.ProcessEnv
): Promise<RuntimeInvocationConsent> {
  const path = runtimeSlotConfigPath(slot, homeOptions(env));

  return await withSlotLock(slot, CONFIG_LOCK_FILE, env, async () => {
    const { config, stored, error } = await readRuntimeSlotState(slot, env);
    if (error) {
      return {
        granted: false,
        recorded: false,
        reason: error,
        allow: RUNTIME_CONSENT_PRESETS.none,
      };
    }
    if (stored?.setup) {
      const granted = config.setup.state === 'configured';
      return {
        granted,
        recorded: false,
        allow: granted ? config.allow : RUNTIME_CONSENT_PRESETS.none,
      };
    }
    if (config.setup.state === 'configured') {
      return { granted: true, recorded: false, allow: config.allow };
    }

    await mergeRuntimeSlotConfig(path, slot, {
      profile: 'full',
      allow: RUNTIME_CONSENT_PRESETS.full,
      setup: { state: 'configured', at: new Date().toISOString(), by: 'launch' },
      source: resolveRuntimeSource(env),
      version: runtimeVersion,
    });
    return { granted: true, recorded: true, allow: RUNTIME_CONSENT_PRESETS.full };
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

/**
 * Raised when a writer may not replace `credentials.json` outright (see
 * `readRuntimeSlotCredentialsState`): the file names a `schemaVersion` this
 * build does not speak, or this process could not read it at all. Every other
 * unusable shape — missing, corrupt JSON, wrong field types — is tolerated by
 * the writers below exactly as before #1056 published the schema: the next
 * write replaces it. Both refused cases share a reason: this process cannot
 * see what would be lost, either because it does not speak the format or
 * because it could not open the file, so it refuses instead of guessing.
 * Callers that would otherwise crash the process on this (`connect`, `serve`)
 * catch it and print `message`, which names the path and the reason but never
 * a token value.
 */
export class RuntimeCredentialsRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeCredentialsRefusedError';
  }
}

export async function readPairingToken(
  slot: RuntimeSlot,
  env?: NodeJS.ProcessEnv
): Promise<string | null> {
  const { credentials } = await readRuntimeSlotCredentialsState(slot, env);
  return credentials.pairingToken ?? null;
}

/**
 * Persists the credential owner-only. On a filesystem that cannot express that
 * — a Windows volume, a mounted share — the write still happens and the caller
 * is told, rather than the runtime pretending the file is protected.
 *
 * Windows gets an ACL rather than a mode, because `chmod` there sets the
 * read-only attribute and reports success — a `restricted: true` from it would
 * mean "the call did not throw" rather than "no other account can read this",
 * and the flag exists to answer the second question. See `owner-only.ts`.
 */
export async function writePairingToken(
  slot: RuntimeSlot,
  token: string,
  env?: NodeJS.ProcessEnv,
  ownerOnly?: OwnerOnlyDeps
): Promise<{ readonly restricted: boolean }> {
  return await withSlotLock(slot, CREDENTIALS_LOCK_FILE, env, async () => {
    const current = await requireReplaceableCredentials(slot, env);
    return await writeCredentials(
      slot,
      {
        schemaVersion: CREDENTIALS_SCHEMA_VERSION,
        pairingToken: token,
        ...(current.serveToken ? { serveToken: current.serveToken } : {}),
      },
      env,
      ownerOnly
    );
  });
}

export async function readServeToken(
  slot: RuntimeSlot,
  env?: NodeJS.ProcessEnv
): Promise<string | null> {
  const { credentials } = await readRuntimeSlotCredentialsState(slot, env);
  return credentials.serveToken ?? null;
}

/**
 * Persists the serve credential the same way as the pairing token: owner-only
 * when the filesystem allows it, and never in the pasteable config file.
 */
export async function writeServeToken(
  slot: RuntimeSlot,
  token: string,
  env?: NodeJS.ProcessEnv,
  ownerOnly?: OwnerOnlyDeps
): Promise<{ readonly restricted: boolean }> {
  return await withSlotLock(slot, CREDENTIALS_LOCK_FILE, env, async () => {
    const current = await requireReplaceableCredentials(slot, env);
    return await writeCredentials(
      slot,
      {
        schemaVersion: CREDENTIALS_SCHEMA_VERSION,
        serveToken: token,
        ...(current.pairingToken ? { pairingToken: current.pairingToken } : {}),
      },
      env,
      ownerOnly
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
  ownerOnly?: OwnerOnlyDeps
): Promise<{ readonly token: string; readonly restricted: boolean }> {
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
  const { restricted } = await writeServeToken(slot, token, env, ownerOnly);
  return { token, restricted };
}

/**
 * What was in `credentials.json`, plus why it could not be trusted when that
 * happened. A union rather than an `error` string paired with an independent
 * `mayReplaceOnWrite` flag, because those two were never actually independent
 * — `error: null` only ever meant `usable`, and typing them separately let a
 * fourth, meaningless combination compile.
 */
export type RuntimeSlotCredentialsState =
  | {
      /** The file was absent, or present and fully valid. Nothing to tell anybody. */
      readonly kind: 'usable';
      readonly credentials: RuntimeSlotCredentials;
      readonly error: null;
    }
  | {
      /**
       * Present but unusable in a way that carries no information worth
       * keeping — corrupt JSON, or a document that fails the schema for a
       * reason other than its `schemaVersion`. The next write may discard it
       * outright, the same tolerant recovery the pre-#1056 `catch` gave every
       * unusable file.
       */
      readonly kind: 'replaceable';
      readonly credentials: RuntimeSlotCredentials;
      readonly error: string;
    }
  | {
      /**
       * Present but this process refuses to touch it: either it could not be
       * read at all, or it names a `schemaVersion` this build does not speak.
       * In both cases this process cannot see what a silent replace would
       * destroy, which is exactly the loss #1060 reported.
       */
      readonly kind: 'refused';
      readonly credentials: RuntimeSlotCredentials;
      readonly error: string;
    };

/**
 * Reads `credentials.json` and says whether it can be trusted or replaced.
 *
 * Exported for the same reason `readRuntimeSlotState` is: a caller with a
 * better diagnostic to offer than "no token stored" — `resolveToken` in
 * `cli.ts`, `assertServicePreconditions` — needs `error` and `kind` alongside
 * the tokens themselves, not just the pass/fail `readPairingToken` gives.
 */
export async function readRuntimeSlotCredentialsState(
  slot: RuntimeSlot,
  env?: NodeJS.ProcessEnv
): Promise<RuntimeSlotCredentialsState> {
  const path = runtimeSlotCredentialsPath(slot, homeOptions(env));
  const empty: RuntimeSlotCredentials = { schemaVersion: CREDENTIALS_SCHEMA_VERSION };
  const usable = (): RuntimeSlotCredentialsState => ({
    kind: 'usable',
    credentials: empty,
    error: null,
  });
  const replaceable = (error: string): RuntimeSlotCredentialsState => ({
    kind: 'replaceable',
    credentials: empty,
    error,
  });
  const refused = (error: string): RuntimeSlotCredentialsState => ({
    kind: 'refused',
    credentials: empty,
    error,
  });

  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return usable();
    // Present but unreadable is not absent, and unlike absent it must not be
    // silently replaceable either: this process cannot see what is in the
    // file, so it cannot rule out that a rename would destroy a version it
    // has never heard of — the exact risk a future schemaVersion carries.
    // The error code, not the full message: Node's message already repeats
    // `path` inside itself, and printing both would say it twice.
    return refused(`${path} could not be read (${code ?? describe(error)}).`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Never echoes the parser's message: it can quote back a fragment of
    // `raw`, and `raw` is exactly the file that must never be pasted anywhere.
    return replaceable(`${path} is not valid JSON.`);
  }

  if (Value.Check(RuntimeSlotCredentialsSchema, parsed)) {
    return { kind: 'usable', credentials: parsed, error: null };
  }

  const futureVersion = unsupportedCredentialsSchemaVersion(parsed);
  if (futureVersion !== null) {
    return refused(
      `${path} is schemaVersion ${futureVersion}, which this build of the runtime does not understand.`
    );
  }
  return replaceable(`${path} does not match the runtime credentials schema.`);
}

/**
 * The file's `schemaVersion`, when it is a number this build does not speak —
 * null for everything else, including a document whose only problem is a
 * wrong-shaped token, and including a document that is not an object at all
 * (`null`, an array, a bare string): `schemaVersion` is only ever read off a
 * plain object, so anything else answers "not a version mismatch" and falls
 * through to the generic schema-mismatch diagnostic instead of throwing here.
 */
function unsupportedCredentialsSchemaVersion(parsed: unknown): number | null {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const version = (parsed as Record<string, unknown>).schemaVersion;
  return typeof version === 'number' && version !== CREDENTIALS_SCHEMA_VERSION ? version : null;
}

/**
 * What to tell an operator once `error` has already been shown, or `null` for
 * `usable` — there is nothing to add to a message that was never printed.
 *
 * `replaceable` only needs the command repeated: passing a token (or letting
 * one generate) already replaces the file. `refused` needs a person, because
 * this process will not touch the file itself — moving it aside is what lets
 * the same command write a fresh one in its place.
 */
export function credentialsRemedy(state: RuntimeSlotCredentialsState): string | null {
  switch (state.kind) {
    case 'usable':
      return null;
    case 'replaceable':
      return 'Rerun this command with a token (or let it generate one); that replaces the file.';
    case 'refused':
      return 'Move it aside, then rerun this command; it will write a fresh credentials.json in its place.';
  }
}

/**
 * `state.error` plus its remedy, on one line, or `fallback` when the file was
 * absent or fine. The single place every caller — the thrown refusal below,
 * `resolveToken`/`resolveServeToken`, `assertServicePreconditions` — builds
 * its message, so the wording only has to be right once.
 */
export function credentialsUnusableMessage(
  state: RuntimeSlotCredentialsState,
  fallback: string
): string {
  if (!state.error) return fallback;
  const remedy = credentialsRemedy(state);
  return remedy ? `${state.error} ${remedy}` : state.error;
}

/**
 * The credentials a writer may merge its new token into, or a refusal.
 *
 * `replaceable` collapses to `{ schemaVersion: 1 }` here, which is what makes
 * rotating a pairing or serve token double as the repair for a corrupt or
 * wrong-shaped file — the same tolerant behaviour the pre-#1056 `catch` gave
 * every unusable file, preserved because a `connect` or `serve` failing over
 * a file it cannot use would be worse than replacing it. `refused` is the one
 * exception: only an operator can judge whether it is safe to discard, so
 * this throws instead of guessing, under the same lock a deliberate repair
 * would need anyway.
 */
async function requireReplaceableCredentials(
  slot: RuntimeSlot,
  env?: NodeJS.ProcessEnv
): Promise<RuntimeSlotCredentials> {
  const state = await readRuntimeSlotCredentialsState(slot, env);
  if (state.kind === 'refused') {
    throw new RuntimeCredentialsRefusedError(credentialsUnusableMessage(state, state.error));
  }
  return state.credentials;
}

/**
 * Serializes writers of one file in one slot across processes.
 *
 * Every writer here does read-merge-rename, which loses the other's field when
 * two interleave: `connect` and `serve` share one credentials.json, and `setup`
 * and an installer share one runtime.json. Each file gets its own lock, so a
 * credential rotation never waits behind a consent write.
 *
 * The lock is only removed by the `finally` below, so a holder that is killed —
 * a SIGKILL, a lost machine, a container torn down mid-write — leaves the file
 * behind and every later writer would wait out the timeout forever. Since
 * consent writes now go through here, that would mean a slot nobody can repair
 * without deleting a file they have no reason to know about. So a lock names
 * its owner and is reclaimed when that owner is provably gone.
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
        await handle.write(JSON.stringify({ pid: process.pid, host: hostname() }));
        return await run();
      } finally {
        await handle.close().catch(() => undefined);
        await unlink(lockPath).catch(() => undefined);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;
      if (await reclaimAbandonedLock(lockPath)) continue;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for the runtime slot lock at ${lockPath}.`);
      }
      await sleepMs(SLOT_LOCK_POLL_MS);
    }
  }
}

/**
 * Removes a lock whose owner is gone, and says whether it did.
 *
 * Two questions, because neither alone is sound. A dead pid is the fast answer,
 * but a pid means nothing unless it was recorded on this machine — a runtime
 * home can sit on a mounted share — so it is only trusted when the hostnames
 * agree. Age covers the rest, including a lock whose owner's pid has since been
 * handed to something unrelated: every holder does one small write, so a lock
 * that has survived far longer than any of them could is a leftover.
 *
 * Racing to reclaim is safe. Both callers unlink and both retry `wx`; exactly
 * one of them creates the file, which is what the lock is.
 */
async function reclaimAbandonedLock(lockPath: string): Promise<boolean> {
  let owner: { readonly pid?: number; readonly host?: string } = {};
  let age = 0;
  try {
    const [raw, stats] = await Promise.all([readFile(lockPath, 'utf8'), stat(lockPath)]);
    age = Date.now() - stats.mtimeMs;
    // An empty file is a holder between `open` and its first write, not a
    // leftover; a parse failure lands on the same answer as no owner at all.
    owner = raw ? (JSON.parse(raw) as typeof owner) : {};
  } catch {
    // Gone already, or unreadable: either way this process has nothing to
    // reclaim, and the caller retries the create.
    return false;
  }

  const ownedHere = owner.host === hostname() && typeof owner.pid === 'number';
  const abandoned = ownedHere ? !isProcessAlive(owner.pid as number) : age > SLOT_LOCK_STALE_MS;
  if (!abandoned) return false;

  await unlink(lockPath).catch(() => undefined);
  return true;
}

/** Signal 0 tests for existence; `EPERM` means it exists and is not ours. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function writeCredentials(
  slot: RuntimeSlot,
  credentials: RuntimeSlotCredentials,
  env: NodeJS.ProcessEnv | undefined,
  ownerOnly: OwnerOnlyDeps | undefined
): Promise<{ readonly restricted: boolean }> {
  const path = runtimeSlotCredentialsPath(slot, homeOptions(env));
  // Restricted after every write, not only the first: the publication is a
  // rename over the old file, and the file that arrives is a new one carrying
  // whatever the directory hands down.
  await writeFileAtomically(path, credentials, OWNER_ONLY);
  return { restricted: await restrictToOwner(path, ownerOnly ?? defaultOwnerOnlyDeps(env)) };
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
