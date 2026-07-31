import { describe, expect, it } from 'bun:test';
import type { RuntimeCapabilityManifest } from '@mangostudio/shared/runtime-protocol';
import {
  connectInProcessRuntime,
  createInProcessPortPair,
  RuntimeHost,
  type RuntimeMethodHandler,
  RuntimeProtocolClient,
  RuntimeRemoteError,
} from '../../src';

const manifest: RuntimeCapabilityManifest = {
  platform: 'test',
  arch: 'test',
  pathStyle: 'posix',
  homeDir: '/test',
  shells: [],
  git: { available: false },
  features: {
    tools: true,
    git: false,
    probing: false,
    mcp: false,
    library: false,
    checkpoints: true,
  },
};

function createHost(handlers: ReadonlyMap<string, RuntimeMethodHandler>): RuntimeHost {
  return new RuntimeHost({
    runtimeVersion: 'runtime-test',
    manifest,
    handlers,
  });
}

describe('in-process runtime transport', () => {
  it('handshakes and executes requests through validated protocol frames', async () => {
    const host = createHost(
      new Map([
        [
          'snapshot.hash',
          async (params) => ({
            hash: `hash:${(params as { path: string }).path}`,
          }),
        ],
      ])
    );
    const connection = await connectInProcessRuntime(host, {
      hubVersion: 'hub-test',
      validateFrames: true,
    });

    try {
      expect(connection.client.runtimeVersion).toBe('runtime-test');
      expect(connection.client.manifest).toEqual(manifest);
      await expect(
        connection.client.request('snapshot.hash', { path: '/workspace/file.txt' })
      ).resolves.toEqual({ hash: 'hash:/workspace/file.txt' });
    } finally {
      connection.close();
    }
  });

  it('returns a typed error for unsupported methods', async () => {
    const connection = await connectInProcessRuntime(createHost(new Map()), {
      hubVersion: 'hub-test',
      validateFrames: true,
    });

    try {
      const request = connection.client.request('snapshot.hash', {
        path: '/workspace/file.txt',
      });
      await expect(request).rejects.toMatchObject({
        name: 'RuntimeRemoteError',
        code: 'METHOD_UNSUPPORTED',
      });
    } finally {
      connection.close();
    }
  });

  it('rejects incompatible protocol versions before accepting requests', async () => {
    const ports = createInProcessPortPair({ validateFrames: true });
    const host = createHost(new Map());
    host.attach(ports.runtime);
    const client = new RuntimeProtocolClient(ports.hub, {
      hubVersion: 'hub-test',
      protocolVersion: '2.0',
    });
    host.start();

    try {
      await expect(client.waitUntilReady()).rejects.toMatchObject({
        name: 'RuntimeProtocolError',
        code: 'PROTOCOL_MISMATCH',
      });
    } finally {
      client.close();
      host.close();
    }
  });

  it('translates AbortSignal into a cancel frame without serializing it', async () => {
    let receivedParams: unknown;
    const host = createHost(
      new Map([
        [
          'snapshot.hash',
          (params, { signal }) => {
            receivedParams = params;
            return new Promise((_, reject) => {
              signal.addEventListener(
                'abort',
                () => reject(new DOMException('Cancelled by test', 'AbortError')),
                { once: true }
              );
            });
          },
        ],
      ])
    );
    const connection = await connectInProcessRuntime(host, {
      hubVersion: 'hub-test',
      validateFrames: true,
    });
    const controller = new AbortController();

    try {
      const request = connection.client.request(
        'snapshot.hash',
        { path: '/workspace/file.txt' },
        { signal: controller.signal }
      );
      controller.abort();

      await expect(request).rejects.toBeInstanceOf(RuntimeRemoteError);
      await expect(request).rejects.toMatchObject({ code: 'CANCELLED' });
      expect(receivedParams).toEqual({ path: '/workspace/file.txt' });
      expect(receivedParams).not.toHaveProperty('signal');
    } finally {
      connection.close();
    }
  });
});
