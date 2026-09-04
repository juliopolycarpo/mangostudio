import { describe, expect, it } from 'bun:test';
import type {
  AgentCliStatus,
  RuntimeId,
  RuntimeStatus,
  ToolchainSelection,
  VersionManagerId,
  VersionManagerStatus,
} from '@mangostudio/shared/environments';
import { DEFAULT_TOOLCHAIN_SELECTION } from '@mangostudio/shared/environments';
import type { LibraryLocationStatus, LibraryTargetId } from '@mangostudio/shared/library';
import type { RuntimeCapabilityManifest } from '@mangostudio/shared/runtime-protocol';
import type {
  EnvironmentProbingService,
  ProbeOptions,
  ProbeScope,
} from '../../../../src/modules/environments/application/probing-service';
import {
  createToolchainService,
  resolveToolchainParams,
  toolchainParams,
} from '../../../../src/modules/environments/application/toolchain-service';
import { EnvironmentServiceError } from '../../../../src/modules/environments/domain/environment-error';
import type { EnvironmentToolchainRepository } from '../../../../src/modules/environments/infrastructure/environment-toolchain-repository';

/**
 * In-memory (userId, environmentId) -> selection store; no DB, no network.
 *
 * `upsert` merges the patch into the stored row the way the SQL statement
 * does, so a caller that hands it a whole selection overwrites both runtimes
 * here exactly as it would in SQLite.
 */
class FakeEnvironmentToolchainRepository implements EnvironmentToolchainRepository {
  readonly #rows = new Map<string, ToolchainSelection>();
  readonly upserts: Array<{
    userId: string;
    environmentId: string;
    patch: Partial<ToolchainSelection>;
  }> = [];
  /** Set while a test needs every read to land before the first write. */
  #readGate: Promise<void> | null = null;
  #openGate: (() => void) | null = null;

  /** Holds every `get` until {@link releaseReads}, to stage two racing updates. */
  holdReads(): void {
    this.#readGate = new Promise<void>((resolve) => {
      this.#openGate = resolve;
    });
  }

  releaseReads(): void {
    this.#openGate?.();
    this.#readGate = null;
    this.#openGate = null;
  }

  #key(userId: string, environmentId: string): string {
    return `${userId}\u0000${environmentId}`;
  }

  async get(userId: string, environmentId: string): Promise<ToolchainSelection | null> {
    await this.#readGate;
    return this.#rows.get(this.#key(userId, environmentId)) ?? null;
  }

  upsert(
    userId: string,
    environmentId: string,
    patch: Partial<ToolchainSelection>
  ): Promise<ToolchainSelection> {
    const key = this.#key(userId, environmentId);
    const merged: ToolchainSelection = {
      ...DEFAULT_TOOLCHAIN_SELECTION,
      ...this.#rows.get(key),
      ...patch,
    };
    this.#rows.set(key, merged);
    this.upserts.push({ userId, environmentId, patch });
    return Promise.resolve(merged);
  }

  remove(userId: string, environmentId: string): Promise<void> {
    this.#rows.delete(this.#key(userId, environmentId));
    return Promise.resolve();
  }
}

/** Answers `getRuntimeStatus` with a fixed installation list per runtime; every other member throws. */
class FakeEnvironmentProbingService implements EnvironmentProbingService {
  constructor(private readonly installedPaths: Partial<Record<RuntimeId, readonly string[]>>) {}

  getRuntimeStatus(
    _scope: ProbeScope,
    id: RuntimeId,
    _options?: ProbeOptions
  ): Promise<RuntimeStatus | null> {
    const paths = this.installedPaths[id];
    if (!paths) return Promise.resolve(null);
    return Promise.resolve({
      id,
      health: 'ok',
      installations: paths.map((path) => ({
        path,
        rawPath: path,
        version: null,
        origin: 'path',
        effective: true,
      })),
      findings: [],
      installable: true,
      probedAtMs: 1_700_000_000_000,
    });
  }

  listRuntimeStatuses(): Promise<RuntimeStatus[]> {
    throw new Error('not implemented');
  }
  listVersionManagerStatuses(): Promise<VersionManagerStatus[]> {
    throw new Error('not implemented');
  }
  getVersionManagerStatus(
    _scope: ProbeScope,
    _id: VersionManagerId
  ): Promise<VersionManagerStatus | null> {
    throw new Error('not implemented');
  }
  listAgentCliStatuses(): Promise<AgentCliStatus[]> {
    throw new Error('not implemented');
  }
  getAgentCliStatus(
    _scope: ProbeScope,
    _targetId: LibraryTargetId
  ): Promise<AgentCliStatus | null> {
    throw new Error('not implemented');
  }
  listLocationStatuses(): Promise<LibraryLocationStatus[]> {
    throw new Error('not implemented');
  }
  resetCache(): void {
    // No cache in this fake; nothing to drop.
  }
  resetLocationCache(): void {
    // No cache in this fake; nothing to drop.
  }
}

const USER_ID = 'toolchain-service-user';
const ENVIRONMENT_ID = 'dev-box';

describe('toolchain service', () => {
  it('resolves the default selection when nothing is stored', async () => {
    const service = createToolchainService(
      new FakeEnvironmentToolchainRepository(),
      new FakeEnvironmentProbingService({})
    );

    expect(await service.resolve(USER_ID, ENVIRONMENT_ID)).toEqual(DEFAULT_TOOLCHAIN_SELECTION);
  });

  it('resolves whatever selection is stored', async () => {
    const repository = new FakeEnvironmentToolchainRepository();
    await repository.upsert(USER_ID, ENVIRONMENT_ID, {
      node: '/opt/node/bin/node',
      bun: 'auto',
    });
    const service = createToolchainService(repository, new FakeEnvironmentProbingService({}));

    expect(await service.resolve(USER_ID, ENVIRONMENT_ID)).toEqual({
      node: '/opt/node/bin/node',
      bun: 'auto',
    });
  });

  it('accepts a probed path and stores it', async () => {
    const repository = new FakeEnvironmentToolchainRepository();
    const service = createToolchainService(
      repository,
      new FakeEnvironmentProbingService({ node: ['/opt/node/bin/node', '/usr/bin/node'] })
    );

    const result = await service.update(USER_ID, ENVIRONMENT_ID, { node: '/opt/node/bin/node' });

    expect(result).toEqual({ node: '/opt/node/bin/node', bun: 'auto' });
    expect(await repository.get(USER_ID, ENVIRONMENT_ID)).toEqual(result);
  });

  it('accepts auto without probing', async () => {
    const service = createToolchainService(
      new FakeEnvironmentToolchainRepository(),
      new FakeEnvironmentProbingService({})
    );

    await expect(service.update(USER_ID, ENVIRONMENT_ID, { node: 'auto' })).resolves.toEqual({
      node: 'auto',
      bun: 'auto',
    });
  });

  it('rejects a path the probe never reported, naming the received and expected values', async () => {
    const service = createToolchainService(
      new FakeEnvironmentToolchainRepository(),
      new FakeEnvironmentProbingService({ node: ['/a/node', '/b/node'] })
    );

    await expect(
      service.update(USER_ID, ENVIRONMENT_ID, { node: '/tmp/evil' })
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('expected one of: /a/node, /b/node | received: /tmp/evil'),
    });
  });

  it('rejects an unprobed path as "(none probed)" rather than storing it', async () => {
    const repository = new FakeEnvironmentToolchainRepository();
    const service = createToolchainService(
      repository,
      new FakeEnvironmentProbingService({}) // getRuntimeStatus answers null for bun
    );

    await expect(
      service.update(USER_ID, ENVIRONMENT_ID, { bun: '/opt/bun/bin/bun' })
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining(
        'expected one of: (none probed) | received: /opt/bun/bin/bun'
      ),
    });
    expect(await repository.get(USER_ID, ENVIRONMENT_ID)).toBeNull();
  });

  it('rejection is an EnvironmentServiceError instance', async () => {
    const service = createToolchainService(
      new FakeEnvironmentToolchainRepository(),
      new FakeEnvironmentProbingService({})
    );

    await expect(
      service.update(USER_ID, ENVIRONMENT_ID, { node: '/tmp/evil' })
    ).rejects.toBeInstanceOf(EnvironmentServiceError);
  });

  it('merges a partial update onto the stored selection instead of resetting the other field', async () => {
    const repository = new FakeEnvironmentToolchainRepository();
    await repository.upsert(USER_ID, ENVIRONMENT_ID, {
      node: '/opt/node/bin/node',
      bun: '/opt/bun/bin/bun',
    });
    const service = createToolchainService(
      repository,
      new FakeEnvironmentProbingService({ bun: ['/opt/other-bun/bin/bun'] })
    );

    const result = await service.update(USER_ID, ENVIRONMENT_ID, {
      bun: '/opt/other-bun/bin/bun',
    });

    expect(result).toEqual({
      node: '/opt/node/bin/node',
      bun: '/opt/other-bun/bin/bun',
    });
  });

  it('validates before writing: a rejected field leaves the stored selection untouched', async () => {
    const repository = new FakeEnvironmentToolchainRepository();
    await repository.upsert(USER_ID, ENVIRONMENT_ID, {
      node: '/opt/node/bin/node',
      bun: 'auto',
    });
    const service = createToolchainService(
      repository,
      new FakeEnvironmentProbingService({ bun: ['/opt/bun/bin/bun'] })
    );

    await expect(
      service.update(USER_ID, ENVIRONMENT_ID, { bun: '/tmp/evil' })
    ).rejects.toBeInstanceOf(EnvironmentServiceError);
    expect(await repository.get(USER_ID, ENVIRONMENT_ID)).toEqual({
      node: '/opt/node/bin/node',
      bun: 'auto',
    });
  });

  // The Node and Bun cards each autosave on their own mutation, so two updates
  // for one environment overlap whenever a person picks both. A service that
  // reads the row, merges its own field and writes the whole selection back
  // lets the later write revert the earlier one; the write has to name only
  // the runtime it was asked to change.
  it('a concurrent update of the other runtime does not revert this one', async () => {
    const repository = new FakeEnvironmentToolchainRepository();
    const service = createToolchainService(
      repository,
      new FakeEnvironmentProbingService({
        node: ['/opt/node/bin/node'],
        bun: ['/opt/bun/bin/bun'],
      })
    );

    // Both requests observe the row as it was before either of them wrote.
    repository.holdReads();
    const both = Promise.all([
      service.update(USER_ID, ENVIRONMENT_ID, { node: '/opt/node/bin/node' }),
      service.update(USER_ID, ENVIRONMENT_ID, { bun: '/opt/bun/bin/bun' }),
    ]);
    repository.releaseReads();
    await both;

    expect(await repository.get(USER_ID, ENVIRONMENT_ID)).toEqual({
      node: '/opt/node/bin/node',
      bun: '/opt/bun/bin/bun',
    });
  });

  it('writes only the runtime it was asked to change', async () => {
    const repository = new FakeEnvironmentToolchainRepository();
    const service = createToolchainService(
      repository,
      new FakeEnvironmentProbingService({ bun: ['/opt/bun/bin/bun'] })
    );

    await service.update(USER_ID, ENVIRONMENT_ID, { bun: '/opt/bun/bin/bun' });

    expect(repository.upserts).toEqual([
      { userId: USER_ID, environmentId: ENVIRONMENT_ID, patch: { bun: '/opt/bun/bin/bun' } },
    ]);
  });

  it('reports an unreachable environment as 503, not as an invalid path', async () => {
    const repository = new FakeEnvironmentToolchainRepository();
    class UnreachableProbingService extends FakeEnvironmentProbingService {
      override getRuntimeStatus(): Promise<RuntimeStatus | null> {
        return Promise.reject(new Error('runtime unavailable: ssh exited 255'));
      }
    }
    const service = createToolchainService(repository, new UnreachableProbingService({}));

    const failure = await service
      .update('user-1', 'remote-box', { node: '/opt/node/bin/node' })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(EnvironmentServiceError);
    expect((failure as EnvironmentServiceError).status).toBe(503);
    expect((failure as EnvironmentServiceError).message).toContain('runtime unavailable');
    expect(repository.upserts).toHaveLength(0);
  });

  // Regression: the selection is a field of `Environment`, so a write left
  // every other session holding the environments list showing a stale pin —
  // the same signal `environment-service` publishes for any other change to
  // that shape was never sent from here.
  it('publishes an environments invalidation once a selection is committed', async () => {
    const published: string[] = [];
    const service = createToolchainService(
      new FakeEnvironmentToolchainRepository(),
      new FakeEnvironmentProbingService({ node: ['/opt/node/bin/node'] }),
      () => 1_000,
      (userId) => published.push(userId)
    );

    await service.resolve(USER_ID, ENVIRONMENT_ID);
    expect(published).toEqual([]);

    await service.update(USER_ID, ENVIRONMENT_ID, { node: '/opt/node/bin/node' });
    expect(published).toEqual([USER_ID]);
  });

  it('publishes nothing when the update is refused', async () => {
    const published: string[] = [];
    const service = createToolchainService(
      new FakeEnvironmentToolchainRepository(),
      new FakeEnvironmentProbingService({ node: ['/opt/node/bin/node'] }),
      () => 1_000,
      (userId) => published.push(userId)
    );

    await service.update(USER_ID, ENVIRONMENT_ID, { node: '/nowhere/node' }).catch(() => undefined);

    expect(published).toEqual([]);
  });
});

/** Only `features.toolchain` matters here; the rest of a manifest is noise. */
function manifestWithToolchain(toolchain: boolean): RuntimeCapabilityManifest {
  return { features: { toolchain } } as RuntimeCapabilityManifest;
}

describe('toolchainParams', () => {
  const selection: ToolchainSelection = { node: '/opt/node/bin/node', bun: 'auto' };

  it('carries the selection for a peer that advertises the feature', () => {
    expect(toolchainParams(manifestWithToolchain(true), selection)).toEqual({
      toolchain: selection,
    });
  });

  it('omits the field entirely for a peer that predates it', () => {
    // Not `{ toolchain: undefined }` — every spawn method validates strictly,
    // so an unknown key present at all is refused outright.
    expect(toolchainParams(manifestWithToolchain(false), selection)).toEqual({});
    expect('toolchain' in toolchainParams(manifestWithToolchain(false), selection)).toBe(false);
  });

  it('omits the field when there is no selection to send', () => {
    expect(toolchainParams(manifestWithToolchain(true), undefined)).toEqual({});
  });
});

describe('resolveToolchainParams', () => {
  it('resolves the selection only for a peer that can accept one', async () => {
    let resolveCalls = 0;
    const resolve = () => {
      resolveCalls += 1;
      return Promise.resolve(DEFAULT_TOOLCHAIN_SELECTION);
    };

    expect(await resolveToolchainParams(manifestWithToolchain(false), resolve)).toEqual({});
    expect(resolveCalls).toBe(0);

    expect(await resolveToolchainParams(manifestWithToolchain(true), resolve)).toEqual({
      toolchain: DEFAULT_TOOLCHAIN_SELECTION,
    });
    expect(resolveCalls).toBe(1);
  });
});
