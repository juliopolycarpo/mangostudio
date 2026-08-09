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

  it('keeps an old connection usable after an unsupported external-agent method', async () => {
    const connection = await connectInProcessRuntime(
      createHost(new Map([['snapshot.hash', async () => ({ hash: 'still-connected' })]])),
      {
        hubVersion: 'hub-test',
        validateFrames: true,
      }
    );

    try {
      const request = connection.client.request('external-agent.discover', {
        targetIds: ['codex'],
        timeoutMs: 1_000,
      });
      await expect(request).rejects.toMatchObject({
        name: 'RuntimeRemoteError',
        code: 'METHOD_UNSUPPORTED',
      });
      await expect(
        connection.client.request('snapshot.hash', { path: '/workspace/file.txt' })
      ).resolves.toEqual({ hash: 'still-connected' });
    } finally {
      await connection.close();
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

  it('fails the runtime handshake when the hub acknowledges another protocol version', async () => {
    // The mismatch arrives inside the transport's frame listener, which on a
    // websocket is the socket's `message` event — a throw there escapes into
    // the event loop and leaves `waitUntilReady()` hanging until its caller
    // times out and blames the hub for saying nothing.
    const ports = createInProcessPortPair({ validateFrames: true });
    const host = createHost(new Map());
    host.attach(ports.runtime);
    host.start();

    try {
      ports.hub.send({
        type: 'hello_ack',
        protocolVersion: '2.0',
        hubVersion: 'hub-test',
      });
      await expect(host.waitUntilReady()).rejects.toMatchObject({
        code: 'PROTOCOL_MISMATCH',
      });
    } finally {
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

  it('settles a pending readiness promise when the client closes first', async () => {
    const ports = createInProcessPortPair({ validateFrames: true });
    const client = new RuntimeProtocolClient(ports.hub, { hubVersion: 'hub-test' });
    // No host is attached, so the hello frame never arrives.
    const ready = client.waitUntilReady();
    const request = client.request('snapshot.hash', { path: '/workspace/file.txt' });

    client.close();

    await expect(ready).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' });
    await expect(request).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' });
  });

  it('releases the host and the port when the handshake fails', async () => {
    // A host one major version ahead makes the client reject the hello frame.
    const host = new RuntimeHost({
      runtimeVersion: 'runtime-test',
      manifest,
      handlers: new Map(),
      protocolVersion: '2.0',
    });

    await expect(
      connectInProcessRuntime(host, { hubVersion: 'hub-test', validateFrames: true })
    ).rejects.toMatchObject({ code: 'PROTOCOL_MISMATCH' });

    // Nothing is left attached, so the failed attempt leaked no port pair.
    expect(() => host.start()).toThrow('Runtime host is not attached to a transport.');
  });

  it('does not reject into the void when a request settles after close', async () => {
    let releaseHandler: (() => void) | undefined;
    const host = createHost(
      new Map([
        [
          'snapshot.hash',
          (_params, { signal }) =>
            new Promise((_, reject) => {
              // Cancellation completes a tick after teardown clears the port,
              // exactly like a killed child process reaping asynchronously.
              releaseHandler = () =>
                reject(new DOMException('Cancelled by teardown', 'AbortError'));
              signal.addEventListener('abort', () => setTimeout(() => releaseHandler?.(), 0), {
                once: true,
              });
            }),
        ],
      ])
    );
    const connection = await connectInProcessRuntime(host, {
      hubVersion: 'hub-test',
      validateFrames: true,
    });

    const unhandled: unknown[] = [];
    const captureUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', captureUnhandled);

    try {
      const request = connection.client.request('snapshot.hash', { path: '/workspace/file.txt' });
      // Let the request register before teardown so the handler is genuinely
      // in flight rather than never dispatched.
      await Bun.sleep(0);
      connection.close();

      await expect(request).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' });
      // Long enough for the handler's deferred rejection to reach the detached
      // host, which is where the send used to throw.
      await Bun.sleep(20);
      expect(unhandled).toEqual([]);
      expect(releaseHandler).toBeDefined();
    } finally {
      process.off('unhandledRejection', captureUnhandled);
    }
  });

  it('answers with an error frame when a result cannot be encoded', async () => {
    const host = createHost(
      new Map([
        [
          'snapshot.hash',
          // `ok` is Type.Unknown, so a BigInt clears schema validation and then
          // fails at JSON.stringify — the same shape of failure as a result past
          // the frame-size limit, without allocating 16 MiB in a unit test.
          async () => ({ hash: 1n }),
        ],
      ])
    );
    const connection = await connectInProcessRuntime(host, {
      hubVersion: 'hub-test',
      validateFrames: true,
    });

    try {
      await expect(
        connection.client.request('snapshot.hash', { path: '/workspace/file.txt' })
      ).rejects.toMatchObject({
        name: 'RuntimeRemoteError',
        code: 'INTERNAL',
      });
    } finally {
      connection.close();
    }
  });
});
