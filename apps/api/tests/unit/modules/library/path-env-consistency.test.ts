/**
 * Writes, undos, and removals that reach mango-skills must land in the
 * configured skills directory, and describeLocation must report that same path.
 * Both write engines share the destination because they share one PathEnv
 * factory rather than one engine reading config and the other reading
 * process.env.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLibraryService } from '@mangostudio/runtime';
import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import type {
  PropagationApplyRequest,
  PropagationPreview,
  RemovalApplyRequest,
  RemovalPreview,
} from '@mangostudio/shared/library';
import { createPathEnv } from '@mangostudio/shared/runtime-env';
import {
  applyLibraryPropagation,
  undoLibraryPropagation,
} from '../../../../src/modules/library/application/propagation-apply';
import { applyLibraryRemoval } from '../../../../src/modules/library/application/removal-apply';
import {
  type BackupStoreDeps,
  defaultBackupStoreDeps,
} from '../../../../src/modules/library/infrastructure/backup-store';
import { hashResourceAt } from '../../../../src/modules/library/infrastructure/instance-reader';
import {
  createLibraryPathEnv,
  describeLocation,
} from '../../../../src/modules/library/infrastructure/location-probe';

let home: string;
let backupRoot: string;
let skillsDir: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mango-path-env-'));
  backupRoot = join(home, 'backups');
  skillsDir = join(home, 'custom-skills');
  mkdirSync(skillsDir, { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function hostEnv() {
  return createLibraryPathEnv({
    homeDir: home,
    env: { SKILLS_DIR: skillsDir },
  });
}

function backupDeps(): BackupStoreDeps {
  return {
    ...defaultBackupStoreDeps,
    backupDir: () => backupRoot,
    retentionCount: () => 10,
    retentionBytes: () => 1024 ** 3,
  };
}

function seedSource(): { sourceDir: string; contentHash: Promise<string> } {
  const sourceDir = join(home, 'source', 'gh');
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(join(sourceDir, 'SKILL.md'), '---\nname: gh\ndescription: d\n---\nbody\n');
  return { sourceDir, contentHash: hashResourceAt(sourceDir, 'directory') };
}

function previewFor(sourceDir: string, contentHash: string): PropagationPreview {
  return {
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
            contentHash,
            contentPath: sourceDir,
            contentLocationId: 'agents-skills',
            contentEnvironmentId: LOCAL_ENVIRONMENT_ID,
            locationIds: ['agents-skills'],
            environmentIds: [LOCAL_ENVIRONMENT_ID],
            instanceCount: 1,
            formats: ['markdown-frontmatter'],
            newestModifiedAtMs: 0,
            sizeBytes: 1,
          },
        ],
        destinations: [
          {
            environmentId: LOCAL_ENVIRONMENT_ID,
            locationId: 'mango-skills',
            targetIds: ['mangostudio'],
            toFormat: 'skill-md',
            path: skillsDir,
            outcomes: [{ winnerContentHash: contentHash, operation: 'create' }],
          },
        ],
      },
    ],
  } as unknown as PropagationPreview;
}

function applyRequest(contentHash: string): PropagationApplyRequest {
  return {
    previewToken: 'token',
    stateHash: 'hash',
    request: { resourceKeys: ['skill:gh'], targetLocationIds: ['mango-skills'] },
    decisions: [
      {
        resourceKey: 'skill:gh',
        resolution: 'adopt-group',
        winnerContentHash: contentHash,
        destinations: [{ locationId: 'mango-skills', action: 'apply' }],
      },
    ],
  };
}

function removalPreview(path: string, contentHash: string): RemovalPreview {
  return {
    previewToken: 'token',
    stateHash: 'hash',
    entries: [
      {
        resourceKey: 'skill:gh',
        ref: { kind: 'skill', slug: 'gh' },
        divergence: 'uniform',
        locations: [
          {
            environmentId: LOCAL_ENVIRONMENT_ID,
            locationId: 'mango-skills',
            targetIds: ['mangostudio'],
            operation: 'remove',
            path,
            contentHash,
            modifiedAtMs: 1,
            eliminatesContentGroup: true,
          },
        ],
        instancePlacements: [{ environmentId: LOCAL_ENVIRONMENT_ID, locationId: 'mango-skills' }],
        wouldRemoveLastCopy: true,
      },
    ],
    staleStagedRemovals: [],
  };
}

function removalRequest(): RemovalApplyRequest {
  return {
    previewToken: 'token',
    stateHash: 'hash',
    request: { resourceKeys: ['skill:gh'], locationIds: ['mango-skills'] },
    decisions: [
      {
        resourceKey: 'skill:gh',
        locations: [
          {
            environmentId: LOCAL_ENVIRONMENT_ID,
            locationId: 'mango-skills',
            action: 'remove',
          },
        ],
      },
    ],
    acknowledgeLastCopy: ['skill:gh'],
  };
}

function writtenPath(): string {
  return join(skillsDir, 'gh');
}

function defaultHomePath(): string {
  return join(home, '.mango', 'skills', 'gh');
}

function runtimeHost() {
  const env = hostEnv();
  return createLibraryService({
    createPathEnv: (overrides) =>
      createPathEnv({
        platform: env.platform,
        homeDir: env.homeDir,
        env: { ...env.env, ...overrides?.env },
        ...(overrides?.workspaceRoot !== undefined && { workspaceRoot: overrides.workspaceRoot }),
      }),
  });
}

describe('configured mango-skills writes', () => {
  it('describes the configured skills directory rather than ~/.mango/skills', () => {
    expect(describeLocation('mango-skills', hostEnv()).path).toBe(skillsDir);
  });

  for (const writeEngine of ['in-process', 'runtime'] as const) {
    it(`lands apply, undo, and removal in the configured directory via ${writeEngine}`, async () => {
      const { sourceDir, contentHash: hashPromise } = seedSource();
      const contentHash = await hashPromise;
      const preview = previewFor(sourceDir, contentHash);
      const runtime = writeEngine === 'runtime' ? runtimeHost() : undefined;
      const captured: unknown[] = [];

      const applyDeps = {
        preview: () => Promise.resolve(preview),
        pathEnv: () => hostEnv(),
        writeEngine,
        backup: backupDeps(),
        recordBackup: () => Promise.resolve(),
        resetCaches: () => undefined,
        ...(runtime && {
          runtimeApply: (params: Parameters<NonNullable<typeof runtime>['apply']>[0]) => {
            captured.push(params.pathEnv);
            return runtime.apply(params);
          },
          runtimeUndo: (params: Parameters<NonNullable<typeof runtime>['undo']>[0]) =>
            runtime.undo(params),
        }),
      };

      const applied = await applyLibraryPropagation('user-1', applyRequest(contentHash), applyDeps);

      expect(applied.failed).toEqual([]);
      expect(existsSync(join(writtenPath(), 'SKILL.md'))).toBe(true);
      expect(readFileSync(join(writtenPath(), 'SKILL.md'), 'utf8')).toContain('body');
      expect(existsSync(defaultHomePath())).toBe(false);
      expect(describeLocation('mango-skills', hostEnv()).path).toBe(skillsDir);
      if (writeEngine === 'runtime') {
        expect(captured[0]).toEqual(
          expect.objectContaining({ env: expect.objectContaining({ SKILLS_DIR: skillsDir }) })
        );
      }

      const undone = await undoLibraryPropagation(applied.backupId ?? '', applyDeps, 'user-1');
      expect(undone.removed).toHaveLength(1);
      expect(existsSync(writtenPath())).toBe(false);

      const reapplied = await applyLibraryPropagation(
        'user-1',
        applyRequest(contentHash),
        applyDeps
      );
      expect(reapplied.failed).toEqual([]);
      expect(existsSync(join(writtenPath(), 'SKILL.md'))).toBe(true);

      const removed = await applyLibraryRemoval('user-1', removalRequest(), {
        preview: () => Promise.resolve(removalPreview(writtenPath(), contentHash)),
        pathEnv: () => hostEnv(),
        writeEngine,
        backup: backupDeps(),
        recordBackup: () => Promise.resolve(),
        resetCaches: () => undefined,
        ...(runtime && {
          runtimeRemove: (params) => runtime.remove(params),
        }),
      });

      expect(removed.failed).toEqual([]);
      expect(removed.removed).toHaveLength(1);
      expect(existsSync(writtenPath())).toBe(false);
      expect(existsSync(defaultHomePath())).toBe(false);
    });
  }
});
