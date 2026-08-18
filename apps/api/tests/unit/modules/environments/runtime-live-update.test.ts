import { describe, expect, it } from 'bun:test';
import type {
  RuntimeUpdateBeginParams,
  RuntimeUpdateChunkParams,
  RuntimeUpdateCommitParams,
} from '@mangostudio/runtime';
import {
  type RuntimeUpdateProtocol,
  streamRuntimeUpdate,
} from '../../../../src/modules/environments/domain/runtime-live-update';

describe('streamRuntimeUpdate', () => {
  it('paces bounded sequential chunks before commit', async () => {
    const calls: string[] = [];
    const chunks: RuntimeUpdateChunkParams[] = [];
    const progress: number[] = [];
    const client: RuntimeUpdateProtocol = {
      begin(params: RuntimeUpdateBeginParams) {
        calls.push(`begin:${params.totalBytes}`);
        return Promise.resolve({ sessionId: 'update-1', maxChunkBytes: 4 });
      },
      chunk(params: RuntimeUpdateChunkParams) {
        calls.push(`chunk:${params.seq}`);
        chunks.push(params);
        return Promise.resolve({
          acceptedBytes: Buffer.from(params.bytesBase64, 'base64').byteLength,
          receivedBytes: chunks.reduce(
            (total, chunk) => total + Buffer.from(chunk.bytesBase64, 'base64').byteLength,
            0
          ),
        });
      },
      commit(params: RuntimeUpdateCommitParams) {
        calls.push(`commit:${params.sessionId}`);
        return Promise.resolve({
          version: '1.1.0',
          digest: `sha256:${'a'.repeat(64)}`,
          restart: 'scheduled',
        });
      },
    };

    const result = await streamRuntimeUpdate({
      client,
      version: '1.1.0',
      digest: `sha256:${'a'.repeat(64)}`,
      bytes: new TextEncoder().encode('abcdefghij'),
      onProgress: (written) => progress.push(written),
    });

    expect(calls).toEqual(['begin:10', 'chunk:0', 'chunk:1', 'chunk:2', 'commit:update-1']);
    expect(chunks.map((chunk) => Buffer.from(chunk.bytesBase64, 'base64').toString())).toEqual([
      'abcd',
      'efgh',
      'ij',
    ]);
    expect(progress).toEqual([4, 8, 10]);
    expect(result.restart).toBe('scheduled');
  });

  // #799: the peer's slot config is written by merge, so a build with no commit
  // has to say so rather than stay quiet — silence keeps the previous one.
  it('sends the source commit, and an explicit null when there is none', async () => {
    const begun: RuntimeUpdateBeginParams[] = [];
    const client: RuntimeUpdateProtocol = {
      begin(params: RuntimeUpdateBeginParams) {
        begun.push(params);
        return Promise.resolve({ sessionId: 'update-1', maxChunkBytes: 64 });
      },
      chunk: () => Promise.resolve({ acceptedBytes: 2, receivedBytes: 2 }),
      commit: () =>
        Promise.resolve({
          version: '1.1.0',
          digest: `sha256:${'a'.repeat(64)}`,
          restart: 'manual' as const,
        }),
    };
    const base = {
      client,
      version: '1.1.0',
      digest: `sha256:${'a'.repeat(64)}`,
      bytes: new TextEncoder().encode('ab'),
    };

    await streamRuntimeUpdate({ ...base, sourceSha: 'abc1234' });
    await streamRuntimeUpdate(base);

    expect(begun.map((params) => params.sourceSha)).toEqual(['abc1234', null]);
  });

  // A peer that predates the field ignores it; the update still completes,
  // just without provenance.
  it('completes against a peer that ignores the source commit', async () => {
    const client: RuntimeUpdateProtocol = {
      begin: () => Promise.resolve({ sessionId: 'update-1', maxChunkBytes: 64 }),
      chunk: () => Promise.resolve({ acceptedBytes: 2, receivedBytes: 2 }),
      commit: () =>
        Promise.resolve({
          version: '1.1.0',
          digest: `sha256:${'a'.repeat(64)}`,
          restart: 'manual' as const,
        }),
    };

    const result = await streamRuntimeUpdate({
      client,
      version: '1.1.0',
      digest: `sha256:${'a'.repeat(64)}`,
      bytes: new TextEncoder().encode('ab'),
      sourceSha: 'abc1234',
    });

    expect(result.version).toBe('1.1.0');
  });

  it('stops before begin when already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    let began = false;
    const client = {
      begin: () => {
        began = true;
        return Promise.resolve({ sessionId: 'never', maxChunkBytes: 4 });
      },
      chunk: () => Promise.reject(new Error('unreachable')),
      commit: () => Promise.reject(new Error('unreachable')),
    } satisfies RuntimeUpdateProtocol;

    await expect(
      streamRuntimeUpdate({
        client,
        version: '1.1.0',
        digest: `sha256:${'a'.repeat(64)}`,
        bytes: new Uint8Array([1]),
        signal: controller.signal,
      })
    ).rejects.toThrow('cancelled');
    expect(began).toBe(false);
  });
});
