/** Hub-side sender for the runtime.update begin/chunk/commit protocol. */

import type {
  RuntimeRequestOptions,
  RuntimeUpdateBeginParams,
  RuntimeUpdateBeginResult,
  RuntimeUpdateChunkParams,
  RuntimeUpdateChunkResult,
  RuntimeUpdateCommitParams,
  RuntimeUpdateCommitResult,
} from '@mangostudio/runtime';

const HUB_UPDATE_CHUNK_BYTES = 32 * 1024;
const UPDATE_REQUEST_TIMEOUT_MS = 60_000;
const UPDATE_COMMIT_TIMEOUT_MS = 300_000;

export interface RuntimeUpdateProtocol {
  begin(
    params: RuntimeUpdateBeginParams,
    options?: RuntimeRequestOptions
  ): Promise<RuntimeUpdateBeginResult>;
  chunk(
    params: RuntimeUpdateChunkParams,
    options?: RuntimeRequestOptions
  ): Promise<RuntimeUpdateChunkResult>;
  commit(
    params: RuntimeUpdateCommitParams,
    options?: RuntimeRequestOptions
  ): Promise<RuntimeUpdateCommitResult>;
}

export interface StreamRuntimeUpdateOptions {
  readonly client: RuntimeUpdateProtocol;
  readonly version: string;
  readonly digest: string;
  /**
   * Commit these bytes were built from, when the release said. Sent even when
   * absent, as an explicit null: the peer's slot config is written by merge,
   * and omitting the field is what leaves the previous build's commit next to
   * the new binary.
   */
  readonly sourceSha?: string | undefined;
  readonly bytes: Uint8Array;
  readonly signal?: AbortSignal;
  /** Fires once the peer holds a staged session, which only closing can release. */
  readonly onSessionOpen?: (sessionId: string) => void;
  readonly onProgress?: (written: number, total: number) => void;
  readonly beforeCommit?: () => void;
}

/**
 * Sends one request at a time. Awaiting every chunk is the backpressure rule:
 * the next frame is not enqueued until the peer accepted the previous bytes.
 */
export async function streamRuntimeUpdate(
  options: StreamRuntimeUpdateOptions
): Promise<RuntimeUpdateCommitResult> {
  throwIfAborted(options.signal);
  const begun = await options.client.begin(
    {
      version: options.version,
      digest: options.digest,
      totalBytes: options.bytes.byteLength,
      sourceSha: options.sourceSha ?? null,
    },
    { signal: options.signal, timeoutMs: UPDATE_REQUEST_TIMEOUT_MS }
  );
  options.onSessionOpen?.(begun.sessionId);
  if (!Number.isSafeInteger(begun.maxChunkBytes) || begun.maxChunkBytes <= 0) {
    throw new Error('Runtime update peer returned an invalid chunk-size limit.');
  }

  const chunkBytes = Math.min(HUB_UPDATE_CHUNK_BYTES, begun.maxChunkBytes);
  let written = 0;
  let seq = 0;
  while (written < options.bytes.byteLength) {
    throwIfAborted(options.signal);
    const end = Math.min(options.bytes.byteLength, written + chunkBytes);
    const chunk = options.bytes.subarray(written, end);
    await options.client.chunk(
      {
        sessionId: begun.sessionId,
        seq,
        bytesBase64: Buffer.from(chunk).toString('base64'),
      },
      { signal: options.signal, timeoutMs: UPDATE_REQUEST_TIMEOUT_MS }
    );
    written = end;
    seq += 1;
    options.onProgress?.(written, options.bytes.byteLength);
  }

  throwIfAborted(options.signal);
  options.beforeCommit?.();
  return await options.client.commit(
    { sessionId: begun.sessionId },
    { signal: options.signal, timeoutMs: UPDATE_COMMIT_TIMEOUT_MS }
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw new DOMException('Runtime update was cancelled.', 'AbortError');
}
