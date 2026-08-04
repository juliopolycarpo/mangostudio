/**
 * Receives one verified runtime binary over the live protocol connection.
 *
 * The service owns exactly one session. Bytes are staged inside the target
 * version directory, hashed while they arrive, and published only after the
 * declared byte count and digest both match. Closing the host removes an
 * unfinished stage, so a dropped connection cannot poison the next attempt.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  type FileHandle,
  mkdir,
  open,
  readFile,
  readlink,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
  unlink,
} from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import {
  RUNTIME_BINARY_BASENAME,
  RUNTIME_CURRENT_LINK_NAME,
  type RuntimeSlot,
} from '@mangostudio/shared/runtime-home';
import { RuntimeUpdateError } from '../errors';
import type {
  RuntimeUpdateBeginParams,
  RuntimeUpdateBeginResult,
  RuntimeUpdateChunkParams,
  RuntimeUpdateChunkResult,
  RuntimeUpdateCommitParams,
  RuntimeUpdateCommitResult,
} from '../methods';
import { runtimeSlotDir, writeRuntimeSlotConfig } from '../runtime-home';

const RUNTIME_UPDATE_MAX_BYTES = 256 * 1024 * 1024;
const RUNTIME_UPDATE_MAX_CHUNK_BYTES = 32 * 1024;
const RUNTIME_UPDATE_SESSION_TIMEOUT_MS = 120_000;
const RUNTIME_UPDATE_LOCK_FILE = 'runtime-update.lock';
const RUNTIME_UPDATE_LOCK_STALE_FLOOR_MS = 5 * 60_000;
/** Distinct from ordinary failure so a supervisor can identify an intentional restart. */
export const RUNTIME_UPDATE_EXIT_CODE = 75;

const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

export interface RuntimeUpdateServiceOptions {
  readonly slot: RuntimeSlot;
  readonly env?: NodeJS.ProcessEnv;
  /** Whether an outer process manager will start `current` after commit. */
  readonly supervised?: boolean;
  /** Called after the commit response has had time to enter the transport. */
  readonly requestRestart?: () => void;
  readonly sessionTimeoutMs?: number;
  readonly platform?: NodeJS.Platform;
  /** Writes one bounded slice and reports only bytes confirmed by the filesystem. */
  readonly writeChunk?: (handle: FileHandle, bytes: Uint8Array) => Promise<number>;
}

interface UpdateLock {
  readonly path: string;
  readonly token: string;
}

interface UpdateSession {
  readonly id: string;
  readonly version: string;
  readonly expectedDigest: string;
  readonly totalBytes: number;
  readonly versionDir: string;
  readonly incomingPath: string;
  readonly livePath: string;
  readonly handle: FileHandle;
  readonly lock: UpdateLock;
  readonly hash: ReturnType<typeof createHash>;
  nextSeq: number;
  receivedBytes: number;
  timeout?: ReturnType<typeof setTimeout>;
}

export interface RuntimeUpdateService {
  begin(params: RuntimeUpdateBeginParams): Promise<RuntimeUpdateBeginResult>;
  chunk(params: RuntimeUpdateChunkParams): Promise<RuntimeUpdateChunkResult>;
  commit(params: RuntimeUpdateCommitParams): Promise<RuntimeUpdateCommitResult>;
  readonly active: boolean;
  close(): Promise<void>;
}

export function createRuntimeUpdateService(
  options: RuntimeUpdateServiceOptions
): RuntimeUpdateService {
  let session: UpdateSession | null = null;
  let pendingOperations = 0;
  let operationTail = Promise.resolve();

  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    pendingOperations += 1;
    const result = operationTail.then(operation, operation);
    operationTail = result.then(
      () => undefined,
      () => undefined
    );
    void result.then(
      () => {
        pendingOperations -= 1;
      },
      () => {
        pendingOperations -= 1;
      }
    );
    return result;
  };

  const fail = (message: string, data: Readonly<Record<string, unknown>> = {}) =>
    new RuntimeUpdateError(message, data);

  const requireSession = (sessionId: string): UpdateSession => {
    if (!session || session.id !== sessionId) {
      throw fail('Runtime update session is absent or no longer active.', {
        reason: 'session_missing',
        sessionId,
      });
    }
    return session;
  };

  const discard = async (active: UpdateSession): Promise<void> => {
    clearTimeout(active.timeout);
    await active.handle.close().catch(() => undefined);
    await rm(active.incomingPath, { force: true }).catch(() => undefined);
    await rmdir(active.versionDir).catch(() => undefined);
    if (session === active) session = null;
    await releaseUpdateLock(active.lock);
  };

  const touch = (active: UpdateSession): void => {
    clearTimeout(active.timeout);
    const timeout = setTimeout(() => {
      void serialize(async () => {
        if (session === active && active.timeout === timeout) await discard(active);
      });
    }, options.sessionTimeoutMs ?? RUNTIME_UPDATE_SESSION_TIMEOUT_MS);
    active.timeout = timeout;
    timeout.unref?.();
  };

  return {
    get active() {
      return session !== null || pendingOperations > 0;
    },
    begin(params) {
      return serialize(async () => {
        if (session) {
          throw fail('Another runtime update session is already active.', {
            reason: 'session_active',
            sessionId: session.id,
          });
        }
        if ((options.platform ?? process.platform) === 'win32') {
          throw fail(
            'Runtime self-update is not available on Windows until slot publication supports safe running-executable replacement.',
            { reason: 'platform_unsupported', platform: 'win32' }
          );
        }
        if (!VERSION_PATTERN.test(params.version)) {
          throw fail('Runtime update version is not a safe slot directory name.', {
            reason: 'invalid_version',
          });
        }
        if (!DIGEST_PATTERN.test(params.digest)) {
          throw fail('Runtime update digest must be a lowercase sha256 digest.', {
            reason: 'invalid_digest',
          });
        }
        if (
          !Number.isSafeInteger(params.totalBytes) ||
          params.totalBytes <= 0 ||
          params.totalBytes > RUNTIME_UPDATE_MAX_BYTES
        ) {
          throw fail(
            `Runtime update size must be between 1 and ${RUNTIME_UPDATE_MAX_BYTES} bytes.`,
            {
              reason: 'invalid_size',
              totalBytes: params.totalBytes,
            }
          );
        }

        const slotDir = runtimeSlotDir(options.slot, options.env);
        await mkdir(slotDir, { recursive: true });
        const id = randomUUID();
        const lock = await acquireUpdateLock(
          slotDir,
          id,
          options.sessionTimeoutMs ?? RUNTIME_UPDATE_SESSION_TIMEOUT_MS
        );
        const versionDir = join(slotDir, params.version);
        const incomingPath = join(versionDir, `${RUNTIME_BINARY_BASENAME}.incoming`);
        const livePath = join(versionDir, RUNTIME_BINARY_BASENAME);
        let handle: FileHandle;
        try {
          await mkdir(versionDir, { recursive: true });
          await rm(incomingPath, { force: true });
          handle = await open(incomingPath, 'wx', 0o700);
        } catch (error) {
          await rm(incomingPath, { force: true }).catch(() => undefined);
          await rmdir(versionDir).catch(() => undefined);
          await releaseUpdateLock(lock);
          throw error;
        }
        session = {
          id,
          version: params.version,
          expectedDigest: params.digest,
          totalBytes: params.totalBytes,
          versionDir,
          incomingPath,
          livePath,
          handle,
          lock,
          hash: createHash('sha256'),
          nextSeq: 0,
          receivedBytes: 0,
        };
        touch(session);
        return { sessionId: session.id, maxChunkBytes: RUNTIME_UPDATE_MAX_CHUNK_BYTES };
      });
    },

    chunk(params) {
      return serialize(async () => {
        const active = requireSession(params.sessionId);
        if (!Number.isSafeInteger(params.seq) || params.seq !== active.nextSeq) {
          throw fail(`Runtime update expected chunk ${active.nextSeq}, received ${params.seq}.`, {
            reason: 'sequence_mismatch',
            expectedSeq: active.nextSeq,
            actualSeq: params.seq,
          });
        }
        const bytes = decodeBase64(params.bytesBase64);
        if (bytes.byteLength === 0 || bytes.byteLength > RUNTIME_UPDATE_MAX_CHUNK_BYTES) {
          throw fail(
            `Runtime update chunks must be between 1 and ${RUNTIME_UPDATE_MAX_CHUNK_BYTES} bytes.`,
            { reason: 'invalid_chunk_size', chunkBytes: bytes.byteLength }
          );
        }
        if (active.receivedBytes + bytes.byteLength > active.totalBytes) {
          throw fail('Runtime update chunk exceeds the declared total byte count.', {
            reason: 'total_exceeded',
            totalBytes: active.totalBytes,
          });
        }

        const writeChunk =
          options.writeChunk ??
          (async (handle: FileHandle, chunk: Uint8Array) =>
            (await handle.write(chunk)).bytesWritten);
        let offset = 0;
        try {
          while (offset < bytes.byteLength) {
            const remaining = bytes.subarray(offset);
            const written = await writeChunk(active.handle, remaining);
            if (!Number.isSafeInteger(written) || written <= 0 || written > remaining.byteLength) {
              throw fail('Runtime update write did not report a valid byte count.', {
                reason: 'invalid_write_count',
                written,
                remainingBytes: remaining.byteLength,
              });
            }
            active.hash.update(remaining.subarray(0, written));
            active.receivedBytes += written;
            offset += written;
          }
        } catch (error) {
          await discard(active);
          throw error;
        }
        active.nextSeq += 1;
        touch(active);
        return { acceptedBytes: bytes.byteLength, receivedBytes: active.receivedBytes };
      });
    },

    commit(params) {
      return serialize(async () => {
        const active = requireSession(params.sessionId);
        if (active.receivedBytes !== active.totalBytes) {
          throw fail(
            `Runtime update received ${active.receivedBytes} of ${active.totalBytes} bytes.`,
            {
              reason: 'incomplete',
              receivedBytes: active.receivedBytes,
              totalBytes: active.totalBytes,
            }
          );
        }

        try {
          clearTimeout(active.timeout);
          await active.handle.sync();
          await active.handle.close();
        } catch (error) {
          await discard(active);
          throw error;
        }
        const actualDigest = `sha256:${active.hash.digest('hex')}`;
        if (actualDigest !== active.expectedDigest) {
          await discard(active);
          throw fail(
            `Runtime update digest mismatch: expected ${active.expectedDigest}, got ${actualDigest}.`,
            {
              reason: 'digest_mismatch',
              expectedDigest: active.expectedDigest,
              actualDigest,
            }
          );
        }

        const slotDir = runtimeSlotDir(options.slot, options.env);
        const currentPath = join(slotDir, RUNTIME_CURRENT_LINK_NAME);
        const previous = await readlink(currentPath).catch(() => null);
        const nextLink = join(slotDir, `.${RUNTIME_CURRENT_LINK_NAME}.${active.id}`);
        let currentSwapped = false;
        try {
          try {
            await chmod(active.incomingPath, 0o755);
            await rename(active.incomingPath, active.livePath);
            await symlink(active.version, nextLink);
            await rename(nextLink, currentPath);
            currentSwapped = true;
            await writeRuntimeSlotConfig(
              options.slot,
              {
                version: active.version,
                binaryPath: active.livePath,
                digest: active.expectedDigest,
              },
              options.env
            );
          } catch (error) {
            if (currentSwapped) {
              await restoreCurrentLink(currentPath, previous, active.id).catch(() => undefined);
            }
            await rm(nextLink, { force: true }).catch(() => undefined);
            throw error;
          }
          await pruneSlotVersions(slotDir, active.version, previous).catch(() => undefined);
        } finally {
          session = null;
          await releaseUpdateLock(active.lock);
        }

        const restart = options.supervised ? 'scheduled' : 'manual';
        if (restart === 'scheduled' && options.requestRestart) {
          const timer = setTimeout(options.requestRestart, 50);
          timer.unref?.();
        }
        return { version: active.version, digest: active.expectedDigest, restart };
      });
    },

    close() {
      return serialize(async () => {
        if (session) await discard(session);
      });
    },
  };
}

function decodeBase64(encoded: string): Uint8Array {
  if (encoded.length === 0 || encoded.length > Math.ceil(RUNTIME_UPDATE_MAX_CHUNK_BYTES / 3) * 4) {
    throw new RuntimeUpdateError('Runtime update chunk is not valid bounded base64.', {
      reason: 'invalid_base64',
    });
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) {
    throw new RuntimeUpdateError('Runtime update chunk is not canonical base64.', {
      reason: 'invalid_base64',
    });
  }
  return bytes;
}

async function restoreCurrentLink(
  currentPath: string,
  previous: string | null,
  sessionId: string
): Promise<void> {
  if (!previous) {
    await rm(currentPath, { force: true });
    return;
  }
  const rollback = `${currentPath}.rollback.${sessionId}`;
  await symlink(previous, rollback);
  await rename(rollback, currentPath);
}

async function pruneSlotVersions(
  slotDir: string,
  currentVersion: string,
  previousVersion: string | null
): Promise<void> {
  const entries = await Array.fromAsync(new Bun.Glob('*').scan({ cwd: slotDir, onlyFiles: false }));
  await Promise.all(
    entries
      .filter(
        (entry) =>
          entry !== currentVersion &&
          entry !== previousVersion &&
          entry !== RUNTIME_CURRENT_LINK_NAME &&
          !entry.endsWith('.json') &&
          !entry.endsWith('.lock')
      )
      .map((entry) => rm(join(slotDir, entry), { recursive: true, force: true }))
  );
}

/**
 * Claims a slot across runtime processes for the full transfer and publication.
 *
 * A host-local live pid is authoritative. Homes mounted across machines fall
 * back to age, with a floor well beyond the normal session timeout. The token
 * prevents an expired holder from unlinking a replacement holder's lock.
 */
async function acquireUpdateLock(
  slotDir: string,
  token: string,
  sessionTimeoutMs: number
): Promise<UpdateLock> {
  const path = join(slotDir, RUNTIME_UPDATE_LOCK_FILE);
  const reclaimPath = `${path}.reclaim`;
  const staleMs = Math.max(RUNTIME_UPDATE_LOCK_STALE_FLOOR_MS, sessionTimeoutMs * 2);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (
      await stat(reclaimPath).then(
        () => true,
        () => false
      )
    ) {
      throw new RuntimeUpdateError('Another slot update is already active.', {
        reason: 'slot_update_active',
      });
    }
    let handle: FileHandle;
    try {
      handle = await open(path, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (attempt === 0 && (await reclaimAbandonedUpdateLock(path, staleMs))) continue;
      throw new RuntimeUpdateError('Another slot update is already active.', {
        reason: 'slot_update_active',
      });
    }

    try {
      await handle.writeFile(JSON.stringify({ token, pid: process.pid, host: hostname() }));
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(path).catch(() => undefined);
      throw error;
    }
    await handle.close();
    return { path, token };
  }

  throw new RuntimeUpdateError('Another slot update is already active.', {
    reason: 'slot_update_active',
  });
}

async function releaseUpdateLock(lock: UpdateLock): Promise<void> {
  try {
    const owner = JSON.parse(await readFile(lock.path, 'utf8')) as { readonly token?: string };
    if (owner.token === lock.token) await unlink(lock.path);
  } catch {
    // Gone, replaced, or unreadable: never remove a lock we cannot identify.
  }
}

async function reclaimAbandonedUpdateLock(path: string, staleMs: number): Promise<boolean> {
  const reclaimPath = `${path}.reclaim`;
  let reclaimHandle: FileHandle;
  try {
    reclaimHandle = await open(reclaimPath, 'wx', 0o600);
  } catch {
    return false;
  }

  try {
    const [raw, stats] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
    const owner = raw ? (JSON.parse(raw) as { readonly pid?: number; readonly host?: string }) : {};
    const ownedHere = owner.host === hostname() && typeof owner.pid === 'number';
    const abandoned = ownedHere
      ? !isProcessAlive(owner.pid as number)
      : Date.now() - stats.mtimeMs > staleMs;
    if (!abandoned) return false;
    await unlink(path).catch(() => undefined);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  } finally {
    await reclaimHandle.close().catch(() => undefined);
    await unlink(reclaimPath).catch(() => undefined);
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
