/**
 * Receives one verified runtime binary over the live protocol connection.
 *
 * The service owns exactly one session. Bytes are staged inside the target
 * version directory, hashed while they arrive, and published only after the
 * declared byte count and digest both match. Closing the host removes an
 * unfinished stage, so a dropped connection cannot poison the next attempt.
 */

import { createHash, randomUUID } from 'node:crypto';
import { chmod, type FileHandle, mkdir, open, rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type RuntimeSlot,
  runtimeBinaryName,
  SOURCE_SHA_PATTERN,
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
import {
  isLockedFileError,
  moveSlotFile,
  pruneSlotVersions,
  publishSlotCurrent,
  readSlotCurrentTarget,
  restoreSlotCurrent,
  type SlotPublishOptions,
  slotVersionFromPointer,
} from './slot-publish';
import {
  acquireSlotUpdateLock,
  releaseSlotUpdateLock,
  type SlotUpdateLock,
} from './slot-update-lock';

const RUNTIME_UPDATE_MAX_BYTES = 256 * 1024 * 1024;
const RUNTIME_UPDATE_MAX_CHUNK_BYTES = 32 * 1024;
const RUNTIME_UPDATE_SESSION_TIMEOUT_MS = 120_000;
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
  /**
   * Pointer filesystem and backoff, so a test can drive the Windows branch off
   * Windows — a junction is the one operation a Linux runner cannot perform.
   */
  readonly slotPublish?: Omit<SlotPublishOptions, 'platform'>;
}

interface UpdateSession {
  readonly id: string;
  readonly version: string;
  readonly expectedDigest: string;
  /** Undefined clears whatever the slot recorded; see the param's own note. */
  readonly sourceSha: string | undefined;
  readonly totalBytes: number;
  readonly versionDir: string;
  readonly incomingPath: string;
  readonly livePath: string;
  readonly handle: FileHandle;
  readonly lock: SlotUpdateLock;
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
  const platform = options.platform ?? process.platform;
  const publish: SlotPublishOptions = { ...options.slotPublish, platform };
  const binaryName = runtimeBinaryName(platform);

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
    await releaseSlotUpdateLock(active.lock);
  };

  /**
   * Moves the verified stage onto the version's live name.
   *
   * POSIX replaces the file under any reader; Windows refuses while anything
   * holds it open, which after a fresh write is usually a scanner and passes.
   * When it does not, the honest answer names the lock rather than surfacing a
   * bare `EPERM` from a path nobody can place.
   */
  const publishLiveBinary = async (active: UpdateSession): Promise<void> => {
    try {
      await moveSlotFile(active.incomingPath, active.livePath, publish);
    } catch (error) {
      if (platform !== 'win32' || !isLockedFileError(error)) throw error;
      throw fail(
        `Runtime update could not replace ${active.livePath}: the file is locked. A virus scanner or a process still running that exact version holds it; stop the service for this slot and retry.`,
        { reason: 'binary_locked', path: active.livePath }
      );
    }
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
          params.sourceSha !== undefined &&
          params.sourceSha !== null &&
          (typeof params.sourceSha !== 'string' || !SOURCE_SHA_PATTERN.test(params.sourceSha))
        ) {
          throw fail('Runtime update source commit is not a git commit sha.', {
            reason: 'invalid_source_sha',
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
        const lock = await acquireSlotUpdateLock(
          slotDir,
          id,
          options.sessionTimeoutMs ?? RUNTIME_UPDATE_SESSION_TIMEOUT_MS
        );
        const versionDir = join(slotDir, params.version);
        // The live name carries the platform's suffix, because `current` is a
        // link to this directory and the launcher resolves through it: a
        // Windows slot holding an extensionless file is a slot nothing can run.
        const incomingPath = join(versionDir, `${binaryName}.incoming`);
        const livePath = join(versionDir, binaryName);
        let handle: FileHandle;
        try {
          await mkdir(versionDir, { recursive: true });
          await rm(incomingPath, { force: true });
          handle = await open(incomingPath, 'wx', 0o700);
        } catch (error) {
          await rm(incomingPath, { force: true }).catch(() => undefined);
          await rmdir(versionDir).catch(() => undefined);
          await releaseSlotUpdateLock(lock);
          throw error;
        }
        session = {
          id,
          version: params.version,
          expectedDigest: params.digest,
          sourceSha: params.sourceSha ?? undefined,
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
          // Discarded rather than left open: there is no resume, so the session
          // could only sit there refusing every ordinary call until it expires.
          // Every typed commit refusal ends the session for the same reason.
          await discard(active);
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
        // Two readings of one pointer. The raw target is what a rollback has to
        // write back — a version name on POSIX, an absolute directory on
        // Windows — and the version inside it is what the prune must spare.
        const previousTarget = await readSlotCurrentTarget(slotDir, publish);
        const previousVersion = slotVersionFromPointer(previousTarget);
        let currentSwapped = false;
        try {
          try {
            await chmod(active.incomingPath, 0o755);
            await publishLiveBinary(active);
            await publishSlotCurrent(slotDir, active.version, active.id, publish);
            currentSwapped = true;
            await writeRuntimeSlotConfig(
              options.slot,
              {
                version: active.version,
                binaryPath: active.livePath,
                digest: active.expectedDigest,
                // Always written, never omitted: the write merges, so leaving
                // the key out keeps the commit of the build these bytes just
                // replaced. `undefined` is how this file clears a field.
                sourceSha: active.sourceSha,
              },
              options.env
            );
          } catch (error) {
            if (currentSwapped) {
              await restoreSlotCurrent(slotDir, previousTarget, active.id, publish).catch(
                () => undefined
              );
            }
            throw error;
          }
          await pruneSlotVersions(slotDir, active.version, previousVersion).catch(() => undefined);
        } finally {
          session = null;
          await releaseSlotUpdateLock(active.lock);
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
