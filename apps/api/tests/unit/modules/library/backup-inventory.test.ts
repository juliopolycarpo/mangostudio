/**
 * The backups page assembled from two sources that must not contradict.
 *
 * The hub-side index exists so an offline machine's history stays on the page.
 * The machine itself is authoritative whenever it can be asked. Everything here
 * pins which one wins in each case, because the failure the index invites is a
 * listing that promises a restore the disk cannot honour.
 */

import { describe, expect, it } from 'bun:test';
import type { LibraryBackupSet } from '@mangostudio/shared/library';
import {
  type BackupInventoryDeps,
  describeBackupUsage,
  purgeEnvironmentBackup,
} from '../../../../src/modules/library/application/backup-inventory';
import type {
  LibraryBackupIndex,
  LibraryBackupIndexRow,
} from '../../../../src/modules/library/infrastructure/backup-index-repository';
import type { RuntimeClient } from '../../../../src/services/runtime-client/runtime-client';

function liveSet(overrides: Partial<LibraryBackupSet> = {}): LibraryBackupSet {
  return {
    backupId: 'set-1',
    createdAtMs: 10,
    sizeBytes: 2048,
    entryCount: 2,
    pinned: false,
    lastCopyResourceKeys: [],
    operation: 'propagation',
    resourceKeys: ['skill:gh'],
    evictsNext: false,
    manifestReadable: true,
    ...overrides,
  };
}

function indexRow(overrides: Partial<LibraryBackupIndexRow> = {}): LibraryBackupIndexRow {
  return {
    environmentId: 'local',
    backupId: 'set-1',
    createdAtMs: 10,
    sizeBytes: 2048,
    pinned: false,
    operation: 'propagation',
    ...overrides,
  };
}

interface FakeIndex extends LibraryBackupIndex {
  readonly recorded: LibraryBackupIndexRow[];
  readonly forgotten: { environmentId: string; backupIds: string[] }[];
}

function fakeIndex(rows: LibraryBackupIndexRow[]): FakeIndex {
  const recorded: LibraryBackupIndexRow[] = [];
  const forgotten: { environmentId: string; backupIds: string[] }[] = [];
  return {
    recorded,
    forgotten,
    list: () => Promise.resolve(rows),
    record: (_userId, incoming) => {
      recorded.push(...incoming);
      return Promise.resolve();
    },
    forget: (_userId, environmentId, backupIds) => {
      forgotten.push({ environmentId, backupIds: [...backupIds] });
      return Promise.resolve();
    },
  };
}

function fakeClient(sets: LibraryBackupSet[], homeDir = '/home/tester'): RuntimeClient {
  return {
    manifest: { features: { library: true }, homeDir, pathStyle: 'posix' },
    paths: {
      homeDir,
      join: (base: string, path: string) => `${base}/${path}`,
    },
    library: {
      backups: () => Promise.resolve({ sets }),
      gc: () => Promise.resolve({ purged: [], pruned: [] }),
    },
  } as unknown as RuntimeClient;
}

function deps(overrides: Partial<BackupInventoryDeps>): Partial<BackupInventoryDeps> {
  return {
    environmentIds: () => Promise.resolve([]),
    isReachable: () => false,
    client: () => Promise.reject(new Error('unreachable')),
    ...overrides,
  };
}

describe('describeBackupUsage', () => {
  it('believes the machine over the index for an environment it can reach', async () => {
    // The machine is the only thing that knows what retention did since the
    // last look, so its numbers replace the row's rather than being merged.
    const index = fakeIndex([indexRow({ sizeBytes: 1, pinned: true })]);
    const usage = await describeBackupUsage(
      'user-1',
      deps({ index, client: () => Promise.resolve(fakeClient([liveSet({ sizeBytes: 4096 })])) })
    );

    expect(usage.sets).toHaveLength(1);
    expect(usage.sets[0].sizeBytes).toBe(4096);
    expect(usage.sets[0].pinned).toBe(false);
    expect(usage.sets[0].availability).toBe('available');
    expect(usage.sets[0].environmentId).toBe('local');
    expect(usage.unreachableEnvironmentIds).toEqual([]);
  });

  it('keeps an offline environment on the page and says restore cannot run', async () => {
    const index = fakeIndex([
      indexRow({ environmentId: 'local' }),
      indexRow({ environmentId: 'wsl-ubuntu', backupId: 'set-remote', sizeBytes: 512 }),
    ]);

    const usage = await describeBackupUsage(
      'user-1',
      deps({
        index,
        environmentIds: () => Promise.resolve(['wsl-ubuntu']),
        client: (_userId, environmentId) =>
          environmentId === 'local'
            ? Promise.resolve(fakeClient([liveSet()]))
            : Promise.reject(new Error('disconnected')),
      })
    );

    const remote = usage.sets.find((set) => set.environmentId === 'wsl-ubuntu');
    expect(remote?.availability).toBe('environment-offline');
    expect(remote?.sizeBytes).toBe(512);
    // Nothing can be predicted about a retention pass on a disk the hub cannot
    // see, and the contents are the manifest's to report, not the index's.
    expect(remote?.evictsNext).toBe(false);
    expect(remote?.resourceKeys).toEqual([]);
    expect(usage.unreachableEnvironmentIds).toEqual(['wsl-ubuntu']);
    // The row it could not confirm is never dropped as stale.
    expect(index.forgotten).toEqual([]);
  });

  it('drops index rows for sets a reachable machine no longer has', async () => {
    const index = fakeIndex([indexRow({ backupId: 'kept' }), indexRow({ backupId: 'evicted' })]);

    const usage = await describeBackupUsage(
      'user-1',
      deps({ index, client: () => Promise.resolve(fakeClient([liveSet({ backupId: 'kept' })])) })
    );

    expect(usage.sets.map((set) => set.backupId)).toEqual(['kept']);
    expect(index.forgotten).toEqual([{ environmentId: 'local', backupIds: ['evicted'] }]);
  });

  it('backfills a row for a set that was on disk before the index existed', async () => {
    const index = fakeIndex([]);

    const usage = await describeBackupUsage(
      'user-1',
      deps({ index, client: () => Promise.resolve(fakeClient([liveSet({ backupId: 'pre-043' })])) })
    );

    expect(usage.sets.map((set) => set.backupId)).toEqual(['pre-043']);
    expect(index.recorded).toEqual([
      {
        environmentId: 'local',
        backupId: 'pre-043',
        createdAtMs: 10,
        sizeBytes: 2048,
        pinned: false,
        operation: 'propagation',
      },
    ]);
  });

  it('reports a set whose manifest is gone as unrestorable rather than hiding it', async () => {
    const usage = await describeBackupUsage(
      'user-1',
      deps({
        index: fakeIndex([]),
        client: () => Promise.resolve(fakeClient([liveSet({ manifestReadable: false })])),
      })
    );

    expect(usage.sets[0].availability).toBe('manifest-missing');
  });

  it('never dials a disconnected machine that has no history to reconcile', async () => {
    const asked: string[] = [];

    await describeBackupUsage(
      'user-1',
      deps({
        index: fakeIndex([]),
        environmentIds: () => Promise.resolve(['ssh-box']),
        isReachable: () => false,
        client: (_userId, environmentId) => {
          asked.push(environmentId);
          return Promise.resolve(fakeClient([]));
        },
      })
    );

    expect(asked).toEqual(['local']);
  });

  it('sums bytes across machines while keeping the bounds per machine', async () => {
    const usage = await describeBackupUsage(
      'user-1',
      deps({
        index: fakeIndex([]),
        environmentIds: () => Promise.resolve(['wsl-ubuntu']),
        isReachable: () => true,
        client: (_userId, environmentId) =>
          Promise.resolve(
            fakeClient([
              liveSet({
                backupId: `set-${environmentId}`,
                sizeBytes: environmentId === 'local' ? 1000 : 3000,
              }),
            ])
          ),
      })
    );

    expect(usage.setCount).toBe(2);
    expect(usage.sizeBytes).toBe(4000);
    expect(new Set(usage.sets.map((set) => set.environmentId))).toEqual(
      new Set(['local', 'wsl-ubuntu'])
    );
  });
});

describe('purgeEnvironmentBackup', () => {
  it('drops the index row only for what the machine confirmed it deleted', async () => {
    const index = fakeIndex([]);
    const client = {
      manifest: { features: { library: true } },
      paths: { homeDir: '/home/tester', join: (base: string, path: string) => `${base}/${path}` },
      library: {
        gc: () => Promise.resolve({ purged: ['set-1'], pruned: ['set-old'] }),
      },
    } as unknown as RuntimeClient;

    await purgeEnvironmentBackup(
      'user-1',
      'wsl-ubuntu',
      'set-1',
      deps({ index, client: () => Promise.resolve(client) })
    );

    // Retention runs in the same pass, so the sweep it performs is reconciled
    // here rather than lingering as rows pointing at bytes that are gone.
    expect(index.forgotten).toEqual([
      { environmentId: 'wsl-ubuntu', backupIds: ['set-1', 'set-old'] },
    ]);
  });

  it('leaves the row alone when the machine could not be reached', async () => {
    const index = fakeIndex([]);

    await expect(
      purgeEnvironmentBackup(
        'user-1',
        'wsl-ubuntu',
        'set-1',
        deps({ index, client: () => Promise.reject(new Error('disconnected')) })
      )
    ).rejects.toThrow('disconnected');

    // The bytes are still there. A row that vanished while its backup survived
    // would tell the user they reclaimed disk they did not.
    expect(index.forgotten).toEqual([]);
  });
});
