import { describe, expect, it } from 'bun:test';
import {
  connectInProcessRuntime,
  createLibraryService,
  createLocalRuntimeManifest,
  LIBRARY_BACKUP_MISSING_KIND,
  RuntimeHost,
  type RuntimeLibraryUndoParams,
  type RuntimeMethodHandler,
  RuntimeRemoteError,
  RuntimeServiceError,
} from '@mangostudio/runtime';
import type { PropagationApplyRequest, PropagationPreview } from '@mangostudio/shared/library';
import {
  applyLibraryPropagation,
  undoLibraryPropagation,
} from '../../../../src/modules/library/application/propagation-apply';
import { RuntimeClient } from '../../../../src/services/runtime-client/runtime-client';

const manifest = {
  ...createLocalRuntimeManifest(),
  features: {
    ...createLocalRuntimeManifest().features,
    library: true,
  },
};

describe('library.apply transport failures', () => {
  it('refuses before any write when runtimeApply rejects as disconnected', async () => {
    let wrote = false;
    const request: PropagationApplyRequest = {
      previewToken: 'token',
      stateHash: 'hash',
      request: { resourceKeys: ['skill:gh'], targetLocationIds: ['claude-skills'] },
      decisions: [
        {
          resourceKey: 'skill:gh',
          resolution: 'adopt-group',
          winnerContentHash: 'winner',
          destinations: [{ locationId: 'claude-skills', action: 'apply' }],
        },
      ],
    };

    await expect(
      applyLibraryPropagation('user-1', request, {
        preview: () =>
          Promise.resolve({
            previewToken: 'token',
            stateHash: 'hash',
            entries: [
              {
                resourceKey: 'skill:gh',
                ref: { kind: 'skill', slug: 'gh' },
                divergence: 'single',
                acknowledgedDivergence: false,
                requiresWinnerSelection: false,
                sourceGroups: [
                  {
                    contentHash: 'winner',
                    contentPath: '/tmp/source',
                    contentLocationId: 'mango-skills',
                    locationIds: ['mango-skills'],
                    instanceCount: 1,
                    formats: ['markdown-frontmatter'],
                    newestModifiedAtMs: 0,
                    sizeBytes: 1,
                  },
                ],
                destinations: [
                  {
                    locationId: 'claude-skills',
                    targetIds: ['claude'],
                    toFormat: 'skill-md',
                    path: '/tmp/dest',
                    outcomes: [
                      {
                        winnerContentHash: 'winner',
                        operation: 'create',
                      },
                    ],
                  },
                ],
              },
            ],
          } as unknown as PropagationPreview),
        pathEnv: () => ({ platform: 'linux', homeDir: '/tmp', env: {} }),
        readSourceFile: () => {
          wrote = true;
          return Promise.resolve(new Uint8Array());
        },
        runtimeApply: () =>
          Promise.reject(
            new RuntimeRemoteError(
              'RUNTIME_UNAVAILABLE',
              'Environment "local" is unavailable; the next connection attempt is allowed in 5s.'
            )
          ),
        // Force the injected-engine branch without calling real writers.
        backup: {
          fs: {} as never,
          backupDir: () => '/tmp/backups',
          retentionCount: () => 10,
          retentionBytes: () => 1024,
          now: () => new Date(),
          randomSuffix: () => 'x',
        },
      })
    ).rejects.toBeInstanceOf(RuntimeRemoteError);

    expect(wrote).toBe(false);
  });

  it('answers 404 when the runtime reports the backup set is gone', async () => {
    const host = new RuntimeHost({
      runtimeVersion: 'runtime-test',
      manifest,
      handlers: new Map<string, RuntimeMethodHandler>([
        [
          'library.undo',
          (params) => createLibraryService().undo(params as RuntimeLibraryUndoParams),
        ],
      ]),
    });
    const connection = await connectInProcessRuntime(host, {
      hubVersion: 'hub-test',
      validateFrames: true,
    });
    const client = new RuntimeClient(connection.client);

    try {
      // The error class does not cross the frame, so the 404 has to survive on
      // the kind the payload carries rather than on the message text.
      await expect(
        undoLibraryPropagation('2020-01-01T00-00-00.000Z-deadbeef', {
          pathEnv: () => ({ platform: 'linux', homeDir: '/tmp', env: {} }),
          runtimeUndo: (params) => client.library.undo(params, { timeoutMs: 5_000 }),
        })
      ).rejects.toMatchObject({ status: 404 });
    } finally {
      connection.close();
    }
  });

  it('keys the missing-backup 404 on the payload kind, not the message', async () => {
    const host = new RuntimeHost({
      runtimeVersion: 'runtime-test',
      manifest,
      handlers: new Map<string, RuntimeMethodHandler>([
        [
          'library.undo',
          () => {
            // Deliberately worded nothing like the engine's own message: this
            // is what a reworded or localised refusal looks like on the wire,
            // and it must still be the 404 the frontend keys its undo on.
            throw new RuntimeServiceError(LIBRARY_BACKUP_MISSING_KIND, 'that set is gone');
          },
        ],
      ]),
    });
    const connection = await connectInProcessRuntime(host, {
      hubVersion: 'hub-test',
      validateFrames: true,
    });
    const client = new RuntimeClient(connection.client);

    try {
      await expect(
        undoLibraryPropagation('2020-01-01T00-00-00.000Z-deadbeef', {
          pathEnv: () => ({ platform: 'linux', homeDir: '/tmp', env: {} }),
          runtimeUndo: (params) => client.library.undo(params, { timeoutMs: 5_000 }),
        })
      ).rejects.toMatchObject({ status: 404, message: 'that set is gone' });
    } finally {
      connection.close();
    }
  });

  it('propagates an in-process host close mid-request as a transport error', async () => {
    const hangingApply: RuntimeMethodHandler = (_params, context) =>
      new Promise((_resolve, reject) => {
        context.signal.addEventListener(
          'abort',
          () => reject(new DOMException('Runtime closed', 'AbortError')),
          { once: true }
        );
      });

    const host = new RuntimeHost({
      runtimeVersion: 'runtime-test',
      manifest,
      handlers: new Map([['library.apply', hangingApply]]),
    });
    const connection = await connectInProcessRuntime(host, {
      hubVersion: 'hub-test',
      validateFrames: true,
    });
    const client = new RuntimeClient(connection.client);

    try {
      const pending = client.library.apply(
        {
          backupRoot: '/tmp/backups',
          operations: [],
        },
        { timeoutMs: 5_000 }
      );
      connection.close();
      await expect(pending).rejects.toMatchObject({
        name: 'RuntimeRemoteError',
        message: expect.stringMatching(/closed|unavailable|Abort/i),
      });
    } finally {
      connection.close();
    }
  });
});
