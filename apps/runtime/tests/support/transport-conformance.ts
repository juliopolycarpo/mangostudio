/**
 * One suite every runtime transport has to pass.
 *
 * A transport is a framing plus a way to lose a connection, and both halves are
 * easy to get subtly wrong in ways only the slowest tool call reveals. Rather
 * than write a bespoke test per transport and discover later that only one of
 * them covers cancellation, the behaviour lives here once and each transport
 * supplies a fixture. 012 and 013 add their transport as one more fixture.
 */

import { expect, it } from 'bun:test';
import {
  RUNTIME_HEARTBEAT_TOPIC,
  RUNTIME_MAX_FRAME_BYTES,
  type RuntimeCapabilityManifest,
  type RuntimeEventFrame,
} from '@mangostudio/shared/runtime-protocol';
import {
  RuntimeHost,
  type RuntimeMethodHandler,
  type RuntimeProtocolClient,
  RuntimeRemoteError,
  type RuntimeRequestOptions,
} from '../../src';

const CONFORMANCE_MANIFEST: RuntimeCapabilityManifest = {
  platform: 'conformance',
  arch: 'test',
  pathStyle: 'posix',
  homeDir: '/home/conformance',
  shells: ['bash'],
  git: { available: true, version: '2.44.0' },
  features: {
    tools: true,
    git: true,
    probing: false,
    mcp: false,
    library: false,
    checkpoints: true,
  },
};

const CONFORMANCE_RUNTIME_VERSION = 'conformance-runtime';
export const CONFORMANCE_HUB_VERSION = 'conformance-hub';

/**
 * The methods below are not in `RuntimeMethodMap`, which is the point: this
 * suite exercises the transport, not the method catalog. The client's typed
 * surface is narrowed to the catalog, so calls go through this view instead of
 * a cast at every call site.
 */
interface UntypedRuntimeClient {
  request(method: string, params: unknown, options?: RuntimeRequestOptions): Promise<unknown>;
  onEvent(listener: (event: RuntimeEventFrame) => void): () => void;
  onPong(listener: () => void): () => void;
  ping(): void;
  readonly manifest: RuntimeCapabilityManifest;
  readonly runtimeVersion: string;
}

function untyped(client: RuntimeProtocolClient): UntypedRuntimeClient {
  return client as unknown as UntypedRuntimeClient;
}

/** Echoes its params back so a test can prove what crossed the wire. */
const echo: RuntimeMethodHandler = (params) => Promise.resolve(params);

/** Produces a result of a requested byte size, to exercise chunking. */
const bulk: RuntimeMethodHandler = (params) => {
  const { bytes } = params as { bytes: number };
  return Promise.resolve({ blob: 'x'.repeat(bytes) });
};

/** Never settles until it is cancelled, so `cancel` has something to abort. */
const forever: RuntimeMethodHandler = (_params, context) =>
  new Promise((_resolve, reject) => {
    context.signal.addEventListener(
      'abort',
      () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
      { once: true }
    );
  });

function createConformanceHost(): RuntimeHost {
  return new RuntimeHost({
    runtimeVersion: CONFORMANCE_RUNTIME_VERSION,
    manifest: CONFORMANCE_MANIFEST,
    handlers: new Map<string, RuntimeMethodHandler>([
      ['test.echo', echo],
      ['test.bulk', bulk],
      ['test.forever', forever],
    ]),
  });
}

export interface ConformanceConnection {
  readonly client: RuntimeProtocolClient;
  readonly host: RuntimeHost;
  /** Severs the connection the way a crash or a cut network would. */
  drop(): void | Promise<void>;
  close(): void | Promise<void>;
}

export interface ConformanceFixture {
  connect(host: RuntimeHost): Promise<ConformanceConnection>;
  /**
   * True when the transport splits frames across several messages, which makes
   * interleaving and reassembly bounds observable rather than theoretical.
   */
  readonly chunked?: boolean;
}

// A request that has to survive a chunked round trip of several megabytes needs
// more headroom than a normal per-call budget.
const BULK_TIMEOUT_MS = 30_000;

/**
 * Registers the shared cases. Call it inside a `describe` naming the transport
 * so a failure says which one broke.
 */
export function itBehavesLikeARuntimeTransport(fixture: ConformanceFixture): void {
  async function withConnection(
    run: (connection: ConformanceConnection) => Promise<void>
  ): Promise<void> {
    const connection = await fixture.connect(createConformanceHost());
    try {
      await run(connection);
    } finally {
      await connection.close();
    }
  }

  it('completes the handshake and exposes the runtime manifest', async () => {
    await withConnection(({ client }) => {
      expect(client.runtimeVersion).toBe(CONFORMANCE_RUNTIME_VERSION);
      expect(client.manifest).toEqual(CONFORMANCE_MANIFEST);
      return Promise.resolve();
    });
  });

  it('round-trips a request and its response', async () => {
    await withConnection(async ({ client }) => {
      const result = await untyped(client).request('test.echo', {
        nested: { list: [1, 2, 3], text: 'héllo · ünicode · 🥭' },
      });

      expect(result).toEqual({ nested: { list: [1, 2, 3], text: 'héllo · ünicode · 🥭' } });
    });
  });

  it('reports an unsupported method without ending the connection', async () => {
    await withConnection(async ({ client }) => {
      await expect(untyped(client).request('test.absent', {})).rejects.toMatchObject({
        code: 'METHOD_UNSUPPORTED',
      });
      expect(await untyped(client).request('test.echo', { ok: true })).toEqual({ ok: true });
    });
  });

  it('delivers an event stream and its end marker in order', async () => {
    await withConnection(async ({ client, host }) => {
      const received: { seq: number; payload: unknown; end?: true }[] = [];
      const detach = untyped(client).onEvent((event) => {
        if (event.streamId !== 'stream-1') return;
        received.push({
          seq: event.seq,
          payload: event.payload,
          ...(event.end ? { end: true as const } : {}),
        });
      });

      host.emit({ topic: 'test.stream', streamId: 'stream-1', payload: { line: 'first' } });
      host.emit({ topic: 'test.stream', streamId: 'stream-1', payload: { line: 'second' } });
      host.emit({
        topic: 'test.stream',
        streamId: 'stream-1',
        payload: { line: 'last' },
        end: true,
      });
      // One round trip after the last emit guarantees every event landed,
      // whatever the transport's delivery timing is.
      await untyped(client).request('test.echo', {});
      detach();

      expect(received).toEqual([
        { seq: 0, payload: { line: 'first' } },
        { seq: 1, payload: { line: 'second' } },
        { seq: 2, payload: { line: 'last' }, end: true },
      ]);
    });
  });

  it('numbers heartbeat events per topic when no stream id is given', async () => {
    await withConnection(async ({ client, host }) => {
      const sequences: number[] = [];
      const detach = untyped(client).onEvent((event) => {
        if (event.topic === RUNTIME_HEARTBEAT_TOPIC) sequences.push(event.seq);
      });

      host.emit({ topic: RUNTIME_HEARTBEAT_TOPIC, payload: { at: 1 } });
      host.emit({ topic: RUNTIME_HEARTBEAT_TOPIC, payload: { at: 2 } });
      await untyped(client).request('test.echo', {});
      detach();

      expect(sequences).toEqual([0, 1]);
    });
  });

  it('answers a protocol ping with a pong in both directions', async () => {
    await withConnection(async ({ client, host }) => {
      const clientPong = new Promise<void>((resolve) => {
        const detach = untyped(client).onPong(() => {
          detach();
          resolve();
        });
      });
      const hostPong = new Promise<void>((resolve) => {
        const detach = host.onPong(() => {
          detach();
          resolve();
        });
      });

      untyped(client).ping();
      host.ping();

      await Promise.all([clientPong, hostPong]);
    });
  });

  it('cancels an in-flight request and reports it as cancelled', async () => {
    await withConnection(async ({ client }) => {
      const controller = new AbortController();
      const pending = untyped(client).request('test.forever', {}, { signal: controller.signal });
      // The abort has to reach the host as a `cancel` frame, so it cannot be
      // raised before the request itself was written.
      await Promise.resolve();
      controller.abort();

      await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    });
  });

  it('fails an in-flight request when the connection drops mid-call', async () => {
    await withConnection(async (connection) => {
      const pending = untyped(connection.client).request('test.forever', {});
      await Promise.resolve();
      await connection.drop();

      await expect(pending).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' });
    });
  });

  it('refuses a response past the frame limit without killing the connection', async () => {
    await withConnection(async ({ client }) => {
      await expect(
        untyped(client).request(
          'test.bulk',
          { bytes: RUNTIME_MAX_FRAME_BYTES + 1 },
          { timeoutMs: BULK_TIMEOUT_MS }
        )
      ).rejects.toBeInstanceOf(RuntimeRemoteError);

      // The refusal belongs to the frame, not the connection: the next call works.
      expect(await untyped(client).request('test.echo', { ok: true })).toEqual({ ok: true });
    });
  });

  if (fixture.chunked) {
    it('keeps two concurrent oversized responses from interleaving', async () => {
      await withConnection(async ({ client }) => {
        const size = 512 * 1024;
        const [first, second] = await Promise.all([
          untyped(client).request('test.bulk', { bytes: size }, { timeoutMs: BULK_TIMEOUT_MS }),
          untyped(client).request('test.bulk', { bytes: size + 1 }, { timeoutMs: BULK_TIMEOUT_MS }),
        ]);

        expect((first as { blob: string }).blob).toHaveLength(size);
        expect((second as { blob: string }).blob).toHaveLength(size + 1);
      });
    });
  }
}
