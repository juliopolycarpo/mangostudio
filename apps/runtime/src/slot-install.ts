/**
 * Puts the runtime you are already running into a slot.
 *
 * The missing first step for a hand-downloaded binary. `setup`, `connect` and
 * `serve` all run happily from a binary sitting anywhere, but a service unit
 * points at `current` so that upgrades never strand it — and until something
 * publishes bytes there, `service install` has nothing to point at and refuses.
 * A hub push fills the slot over ssh or WSL; on a machine the hub cannot reach
 * first, nothing did, and Windows has no ssh push to fall back on.
 *
 * This is the same publication a live update performs, minus the transfer:
 * copy, verify, publish `current`, record what landed. It shares the slot lock
 * with the update service because they are two processes writing one slot.
 */

import { createHash } from 'node:crypto';
import { chmod, mkdir, open, rm, rmdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  type RuntimeSlot,
  runtimeBinaryName,
  runtimeSlotCurrentBinaryPath,
  runtimeSlotForPath,
} from '@mangostudio/shared/runtime-home';
import { loadRuntimeConfig } from './config';
import { RuntimeUpdateError } from './errors';
import { readRuntimeSlotConfig, runtimeSlotDir, writeRuntimeSlotConfig } from './runtime-home';
import {
  isSafeSlotVersion,
  moveSlotFile,
  pruneSlotVersions,
  publishSlotCurrent,
  readSlotCurrentTarget,
  restoreSlotCurrent,
  type SlotPublishOptions,
  slotCurrentPath,
  slotVersionFromPointer,
} from './services/slot-publish';
import { acquireSlotUpdateLock, releaseSlotUpdateLock } from './services/slot-update-lock';

/** How long a stalled install may hold the slot before another writer reclaims it. */
const SLOT_INSTALL_LOCK_TIMEOUT_MS = 120_000;

export interface RuntimeSlotInstallOptions {
  readonly slot: RuntimeSlot;
  readonly version: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  /** The binary to copy in. Defaults to the one this process is. */
  readonly sourcePath?: string;
  /** Pointer filesystem and backoff; see the update service's own note. */
  readonly slotPublish?: Omit<SlotPublishOptions, 'platform'>;
}

export interface RuntimeSlotInstallResult {
  readonly slot: RuntimeSlot;
  readonly version: string;
  readonly digest: `sha256:${string}`;
  /** Where the bytes landed, under `<slot>/<version>/`. */
  readonly binaryPath: string;
  /** What a unit and a launcher should name — through `current`, never the version. */
  readonly currentBinaryPath: string;
  /** The version `current` named before this ran, if any. */
  readonly replacedVersion: string | null;
  /** True when the slot already held these exact bytes under this version. */
  readonly unchanged: boolean;
}

/**
 * Copies a runtime binary into a slot and points `current` at it.
 * // Usage: await installRuntimeIntoSlot({ slot: 'remote', version: getRuntimeVersion() })
 */
export async function installRuntimeIntoSlot(
  options: RuntimeSlotInstallOptions
): Promise<RuntimeSlotInstallResult> {
  const platform = options.platform ?? process.platform;
  const publish: SlotPublishOptions = { ...options.slotPublish, platform };
  const sourcePath = options.sourcePath ?? process.execPath;
  // Every path below hangs off this one, so the whole command spells them the
  // way the host does. `platform` decides only what the platform decides: the
  // binary's name, and how a pointer is published.
  const slotDir = runtimeSlotDir(options.slot, options.env);

  assertInstallable(sourcePath, options.version, slotDir, options.env);

  const digest = await digestOfFile(sourcePath);
  const versionDir = join(slotDir, options.version);
  const binaryPath = join(versionDir, runtimeBinaryName(platform));
  const currentBinaryPath = join(slotCurrentPath(slotDir), runtimeBinaryName(platform));

  const previousTarget = await readSlotCurrentTarget(slotDir, publish);
  const previousVersion = slotVersionFromPointer(previousTarget);
  if (await slotAlreadyHolds(options, binaryPath, digest, previousVersion)) {
    return {
      slot: options.slot,
      version: options.version,
      digest,
      binaryPath,
      currentBinaryPath,
      replacedVersion: previousVersion,
      unchanged: true,
    };
  }

  await mkdir(slotDir, { recursive: true });
  const lock = await acquireSlotUpdateLock(
    slotDir,
    `install-${process.pid}`,
    SLOT_INSTALL_LOCK_TIMEOUT_MS
  );
  const incomingPath = `${binaryPath}.incoming`;
  let published = false;
  try {
    await mkdir(versionDir, { recursive: true });
    await rm(incomingPath, { force: true });
    try {
      await copyVerified(sourcePath, incomingPath, digest);
      await chmod(incomingPath, 0o755);
      await moveSlotFile(incomingPath, binaryPath, publish);
      await publishSlotCurrent(slotDir, options.version, `install-${process.pid}`, publish);
      published = true;
      await writeRuntimeSlotConfig(
        options.slot,
        { version: options.version, binaryPath, digest },
        options.env
      );
    } catch (error) {
      if (published) {
        await restoreSlotCurrent(slotDir, previousTarget, `install-${process.pid}`, publish).catch(
          () => undefined
        );
      }
      await rm(incomingPath, { force: true }).catch(() => undefined);
      if (!published) await rmdir(versionDir).catch(() => undefined);
      throw error;
    }
    await pruneSlotVersions(slotDir, options.version, previousVersion).catch(() => undefined);
  } finally {
    await releaseSlotUpdateLock(lock);
  }

  return {
    slot: options.slot,
    version: options.version,
    digest,
    binaryPath,
    currentBinaryPath,
    replacedVersion: previousVersion === options.version ? null : previousVersion,
    unchanged: false,
  };
}

/**
 * Everything that makes this install impossible rather than merely unlucky.
 *
 * Checked before a byte is read, because each of these leaves the slot in a
 * state no later step could recover from — and the self-copy in particular
 * would truncate its own source.
 */
function assertInstallable(
  sourcePath: string,
  version: string,
  slotDir: string,
  env: NodeJS.ProcessEnv | undefined
): void {
  const name = basename(sourcePath).toLowerCase();
  if (name === 'bun' || name === 'bun.exe') {
    throw new RuntimeUpdateError(
      'This is a source checkout running under Bun, not a compiled runtime. Build or download a mangostudio-runtime binary and run install from that.',
      { reason: 'source_checkout' }
    );
  }
  if (!isSafeSlotVersion(version)) {
    throw new RuntimeUpdateError(
      `Runtime version "${version}" is not a safe slot directory name.`,
      { reason: 'invalid_version', version }
    );
  }
  const owningSlot = runtimeSlotForPath(sourcePath, {
    mangoHome: loadRuntimeConfig(env).mangoHome,
    platform: process.platform,
  });
  if (owningSlot !== null) {
    throw new RuntimeUpdateError(
      `This runtime already runs from the ${owningSlot} slot (${sourcePath}). Installing it into ${slotDir} would copy the file over itself; upgrade it from its environment card instead.`,
      { reason: 'already_in_slot', sourcePath, slot: owningSlot }
    );
  }
}

/**
 * Whether the slot already holds exactly these bytes under this version.
 *
 * Cheap because the digest is needed regardless, and worth asking: a
 * re-install that overwrites the binary a running service is executing fails
 * on Windows, and there is nothing to gain by trying.
 */
async function slotAlreadyHolds(
  options: RuntimeSlotInstallOptions,
  binaryPath: string,
  digest: string,
  currentVersion: string | null
): Promise<boolean> {
  if (currentVersion !== options.version) return false;
  if (
    !(await stat(binaryPath).then(
      () => true,
      () => false
    ))
  )
    return false;
  const config = await readRuntimeSlotConfig(options.slot, options.env);
  return config.version === options.version && config.digest === digest;
}

/** Streams a file through sha256 without holding it in memory. */
async function digestOfFile(path: string): Promise<`sha256:${string}`> {
  const hash = createHash('sha256');
  for await (const chunk of Bun.file(path).stream()) hash.update(chunk);
  return `sha256:${hash.digest('hex')}`;
}

/**
 * Copies bytes and refuses if they are not the ones already accounted for.
 *
 * The digest was taken from a separate read, so a source that changed between
 * the two — a download still being written, a scanner quarantining it midway —
 * is caught here rather than published as this version.
 */
async function copyVerified(
  sourcePath: string,
  destinationPath: string,
  expectedDigest: string
): Promise<void> {
  const hash = createHash('sha256');
  const handle = await open(destinationPath, 'wx', 0o700);
  try {
    for await (const chunk of Bun.file(sourcePath).stream()) {
      hash.update(chunk);
      await handle.write(chunk);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  const actual = `sha256:${hash.digest('hex')}`;
  if (actual !== expectedDigest) {
    throw new RuntimeUpdateError(
      `${sourcePath} changed while it was being copied: expected ${expectedDigest}, read ${actual}.`,
      { reason: 'digest_mismatch', expectedDigest, actualDigest: actual }
    );
  }
}
