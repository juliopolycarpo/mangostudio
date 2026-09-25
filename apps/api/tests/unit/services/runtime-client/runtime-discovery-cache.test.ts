import { describe, expect, it } from 'bun:test';
import type {
  RuntimeCapabilityManifest,
  RuntimeDiscoverResult,
} from '@mangostudio/shared/runtime-contract';
import type { DiagnosticLogger } from '../../../../src/lib/logger';
import {
  RUNTIME_DISCOVER_TIMEOUT_MS,
  RuntimeDiscoveryCache,
  type RuntimeDiscoverySource,
  runtimeDiscoveryKey,
} from '../../../../src/services/runtime-client/runtime-discovery-cache';

const FEATURES = {
  git: true,
  probing: true,
  mcp: true,
  library: true,
  checkpoints: true,
  fsRead: true,
  fsWrite: true,
  shell: true,
  update: true,
  externalAgents: true,
  terminal: true,
};

function manifestWith(fingerprint?: string): RuntimeCapabilityManifest {
  return {
    platform: 'linux',
    arch: 'x64',
    pathStyle: 'posix',
    homeDir: '/home/peer',
    shells: ['bash'],
    git: { available: true },
    features: {
      tools: true,
      git: true,
      probing: true,
      mcp: true,
      library: true,
      checkpoints: true,
    },
    ...(fingerprint ? { implementation: { schema: 1, fingerprint, features: FEATURES } } : {}),
  };
}

/** A runtime whose build answers `runtime.discover` and counts how often it was asked. */
class FakeDiscoverySource implements RuntimeDiscoverySource {
  calls = 0;
  readonly timeouts: (number | undefined)[] = [];
  readonly manifest: RuntimeCapabilityManifest;
  readonly #answer: RuntimeDiscoverResult;

  constructor(fingerprint: string | undefined, answeredFingerprint = fingerprint) {
    this.manifest = manifestWith(fingerprint);
    this.#answer = {
      schema: 1,
      fingerprint: answeredFingerprint ?? '0'.repeat(64),
      features: FEATURES,
      methods: ['runtime.discover', 'runtime.health'],
    };
  }

  discoverImplementation(options?: {
    readonly timeoutMs?: number;
  }): Promise<RuntimeDiscoverResult> {
    this.calls += 1;
    this.timeouts.push(options?.timeoutMs);
    return Promise.resolve(this.#answer);
  }
}

/** A connection whose `runtime.discover` never answers until the test fails it. */
class StalledDiscoverySource implements RuntimeDiscoverySource {
  readonly manifest: RuntimeCapabilityManifest;
  readonly #pending = Promise.withResolvers<RuntimeDiscoverResult>();

  constructor(fingerprint: string) {
    this.manifest = manifestWith(fingerprint);
  }

  discoverImplementation(): Promise<RuntimeDiscoverResult> {
    return this.#pending.promise;
  }

  fail(error: Error): void {
    this.#pending.reject(error);
  }
}

/** A diagnostic logger that keeps the warnings it was given. */
class RecordingLogger implements DiagnosticLogger {
  readonly warnings: { event: string; metadata: unknown }[] = [];
  readonly ignored: string[] = [];
  debug(event: string): void {
    this.ignored.push(event);
  }
  info(event: string): void {
    this.ignored.push(event);
  }
  error(event: string): void {
    this.ignored.push(event);
  }
  warn(event: string, metadata?: unknown): void {
    this.warnings.push({ event, metadata });
  }
}

const KEY = runtimeDiscoveryKey('user-1', 'env-1');
const BUILD_A = 'a'.repeat(64);
const BUILD_B = 'b'.repeat(64);

describe('RuntimeDiscoveryCache', () => {
  it('fetches runtime.discover once per fingerprint', async () => {
    const cache = new RuntimeDiscoveryCache();
    const peer = new FakeDiscoverySource(BUILD_A);

    const first = await cache.resolve(KEY, peer);
    const second = await cache.resolve(KEY, peer);

    expect(first?.fingerprint).toBe(BUILD_A);
    expect(second).toEqual(first);
    expect(peer.calls).toBe(1);
  });

  it('refetches after a reconnect announces a different fingerprint', async () => {
    const cache = new RuntimeDiscoveryCache();
    const before = new FakeDiscoverySource(BUILD_A);
    await cache.resolve(KEY, before);

    const upgraded = new FakeDiscoverySource(BUILD_B);
    cache.observe(KEY, upgraded.manifest);
    const after = await cache.resolve(KEY, upgraded);

    expect(after?.fingerprint).toBe(BUILD_B);
    expect(upgraded.calls).toBe(1);
  });

  it('keeps the cached surface across a reconnect with the same fingerprint', async () => {
    const cache = new RuntimeDiscoveryCache();
    await cache.resolve(KEY, new FakeDiscoverySource(BUILD_A));

    const reconnected = new FakeDiscoverySource(BUILD_A);
    cache.observe(KEY, reconnected.manifest);
    await cache.resolve(KEY, reconnected);

    expect(reconnected.calls).toBe(0);
  });

  it('drops the cached surface when a reconnect announces no implementation', async () => {
    const cache = new RuntimeDiscoveryCache();
    await cache.resolve(KEY, new FakeDiscoverySource(BUILD_A));

    const downgraded = new FakeDiscoverySource(undefined);
    cache.observe(KEY, downgraded.manifest);

    expect(await cache.resolve(KEY, downgraded)).toBeUndefined();
    const returned = new FakeDiscoverySource(BUILD_A);
    await cache.resolve(KEY, returned);
    expect(returned.calls).toBe(1);
  });

  it('never asks a peer that announced no implementation', async () => {
    const cache = new RuntimeDiscoveryCache();
    const older = new FakeDiscoverySource(undefined);

    expect(await cache.resolve(KEY, older)).toBeUndefined();
    expect(older.calls).toBe(0);
  });

  it('refuses an answer whose fingerprint contradicts hello', async () => {
    const cache = new RuntimeDiscoveryCache();
    const inconsistent = new FakeDiscoverySource(BUILD_A, BUILD_B);

    await expect(cache.resolve(KEY, inconsistent)).rejects.toThrow(
      `runtime.discover answered implementation fingerprint "${BUILD_B}"; expected the fingerprint announced in hello: "${BUILD_A}".`
    );
  });

  it('remembers a failure for its connection until a reconnect or forget', async () => {
    const cache = new RuntimeDiscoveryCache();
    const broken = new FakeDiscoverySource(BUILD_A, BUILD_B);
    await expect(cache.resolve(KEY, broken)).rejects.toThrow();

    await expect(cache.resolve(KEY, broken)).rejects.toThrow();
    expect(broken.calls).toBe(1);

    cache.forget(KEY);
    await expect(cache.resolve(KEY, broken)).rejects.toThrow();
    expect(broken.calls).toBe(2);

    const reconnected = new FakeDiscoverySource(BUILD_A);
    cache.observe(KEY, reconnected.manifest);
    expect((await cache.resolve(KEY, reconnected))?.fingerprint).toBe(BUILD_A);
  });

  it('logs a failure once per failed connection, however often it is read', async () => {
    const logger = new RecordingLogger();
    const cache = new RuntimeDiscoveryCache({ logger });
    const broken = new FakeDiscoverySource(BUILD_A, BUILD_B);
    const subject = { userId: 'user-1', environmentId: 'env-1' };

    await expect(cache.resolve(KEY, broken, subject)).rejects.toThrow();
    await expect(cache.resolve(KEY, broken, subject)).rejects.toThrow();
    await expect(cache.resolve(KEY, broken, subject)).rejects.toThrow();

    expect(logger.warnings).toEqual([
      {
        event: 'runtime_discover_failed',
        metadata: {
          userId: 'user-1',
          environmentId: 'env-1',
          fingerprint: BUILD_A,
          error: `runtime.discover answered implementation fingerprint "${BUILD_B}"; expected the fingerprint announced in hello: "${BUILD_A}".`,
        },
      },
    ]);
  });

  it('bounds every runtime.discover with the configured timeout', async () => {
    const peer = new FakeDiscoverySource(BUILD_A);
    await new RuntimeDiscoveryCache().resolve(KEY, peer);
    await new RuntimeDiscoveryCache({ timeoutMs: 25 }).resolve(KEY, peer);

    expect(peer.timeouts).toEqual([RUNTIME_DISCOVER_TIMEOUT_MS, 25]);
  });
});

describe('RuntimeDiscoveryCache lifetime', () => {
  it('forgets a cached surface', async () => {
    const cache = new RuntimeDiscoveryCache();
    await cache.resolve(KEY, new FakeDiscoverySource(BUILD_A));

    cache.forget(KEY);
    const again = new FakeDiscoverySource(BUILD_A);
    await cache.resolve(KEY, again);

    expect(again.calls).toBe(1);
  });

  it("does not hand a same-fingerprint reconnect the old connection's pending fetch", async () => {
    const cache = new RuntimeDiscoveryCache();
    const stalled = new StalledDiscoverySource(BUILD_A);
    const abandoned = cache.resolve(KEY, stalled);

    const reconnected = new FakeDiscoverySource(BUILD_A);
    cache.observe(KEY, reconnected.manifest);
    const surface = await cache.resolve(KEY, reconnected);

    expect({ calls: reconnected.calls, fingerprint: surface?.fingerprint }).toEqual({
      calls: 1,
      fingerprint: BUILD_A,
    });
    stalled.fail(new Error('connection closed'));
    await expect(abandoned).rejects.toThrow('connection closed');
    // The old connection's failure must not evict the new connection's answer.
    await cache.resolve(KEY, reconnected);
    expect(reconnected.calls).toBe(1);
  });
});

describe('runtimeDiscoveryKey', () => {
  it('joins the user and environment ids', () => {
    expect(runtimeDiscoveryKey('user-1', 'local')).toBe('user-1:local');
  });
});
