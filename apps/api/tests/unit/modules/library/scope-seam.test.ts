/**
 * The workspace-scope seam is reserved, not implemented: no location resolves
 * under a repository root in v1. These tests pin the invariants that make
 * adding the first one a table edit rather than a reshape, and that make a
 * scope-blind bug fail loudly instead of serving the wrong file.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_APP_SETTINGS, withLibraryLocations } from '@mangostudio/shared/app-settings';
import { LIBRARY_SCOPES, LibraryScopeSchema } from '@mangostudio/shared/library';
import {
  LIBRARY_LOCATION_DEFINITIONS,
  type LocationDefinition,
} from '@mangostudio/shared/library/host';
import { DEFAULT_PROFILE_ID } from '@mangostudio/shared/profiles';
import type { PathEnv } from '@mangostudio/shared/runtime-env';
import { Value } from '@sinclair/typebox/value';
import { getDb } from '../../../../src/db/database';
import { discoverLibraryResources } from '../../../../src/modules/library/application/library-discovery';
import { LibraryCache } from '../../../../src/modules/library/infrastructure/library-cache';

const LINUX_ENV: PathEnv = { platform: 'linux', homeDir: '/home/ada', env: {} };

/**
 * Stand-in for the first real workspace location. It is defined here rather
 * than in the registry so the totality test below stays honest: the registry
 * must contain no workspace row until someone deliberately adds one.
 */
const WORKSPACE_FIXTURE: Pick<LocationDefinition, 'scope' | 'resolvePath'> = {
  scope: 'workspace',
  resolvePath: (env) =>
    env.workspaceRoot === undefined ? null : join(env.workspaceRoot, '.claude', 'skills'),
};

describe('library scope contract', () => {
  it('keeps the runtime scope list and the schema literals in step', () => {
    expect([...LIBRARY_SCOPES].sort()).toEqual(['home', 'workspace']);
    for (const scope of LIBRARY_SCOPES) {
      expect(Value.Check(LibraryScopeSchema, scope)).toBe(true);
    }
    expect(Value.Check(LibraryScopeSchema, 'project')).toBe(false);
  });

  it('declares every v1 location home-scoped', () => {
    const nonHome = LIBRARY_LOCATION_DEFINITIONS.filter((location) => location.scope !== 'home');

    // Adding a workspace location is a deliberate act. If this fails because
    // you added one, the seam has to grow up with it: settings toggles under
    // the workspace scope, and a cross-scope precedence order in the target
    // that reads it.
    expect(nonHome.map((location) => location.id)).toEqual([]);
  });
});

describe('workspace-scoped resolution', () => {
  it('reports unsupported instead of resolving against the home directory', () => {
    expect(WORKSPACE_FIXTURE.resolvePath(LINUX_ENV)).toBeNull();
  });

  it('resolves under the workspace root once the env carries one', () => {
    expect(WORKSPACE_FIXTURE.resolvePath({ ...LINUX_ENV, workspaceRoot: '/repos/app' })).toBe(
      '/repos/app/.claude/skills'
    );
  });

  it('never lets a home location move with the workspace root', () => {
    const rooted = { ...LINUX_ENV, workspaceRoot: '/repos/app' };

    for (const location of LIBRARY_LOCATION_DEFINITIONS) {
      expect(location.resolvePath(rooted)).toBe(location.resolvePath(LINUX_ENV));
    }
  });
});

describe('scope-aware cache keys', () => {
  let root: string;
  let skillsDir: string;
  let otherSkillsDir: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'library-scope-seam-'));
    skillsDir = join(root, 'a', 'skills');
    otherSkillsDir = join(root, 'b', 'skills');
    for (const dir of [skillsDir, otherSkillsDir]) {
      mkdirSync(join(dir, 'gh'), { recursive: true });
      writeFileSync(join(dir, 'gh', 'SKILL.md'), '---\nname: gh\ndescription: GitHub skill\n---\n');
    }
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function scan(cache: LibraryCache, pathEnv: PathEnv, rootDir: string, now: number) {
    return discoverLibraryResources(getDb(), 'scope-seam-user', {
      cache,
      now: () => now,
      pathEnv,
      settings: withLibraryLocations(DEFAULT_APP_SETTINGS, DEFAULT_PROFILE_ID, {
        home: { 'mango-skills': true },
        workspace: {},
      }),
      locationPathOverrides: { 'mango-skills': rootDir },
    });
  }

  it('memoizes a repeat scan of the same roots', async () => {
    const cache = new LibraryCache();
    const first = await scan(cache, LINUX_ENV, skillsDir, 1_000);

    expect(await scan(cache, LINUX_ENV, skillsDir, 1_000)).toBe(first);
  });

  it('does not serve one root a scan taken under another', async () => {
    const cache = new LibraryCache();
    const first = await scan(cache, LINUX_ENV, skillsDir, 1_000);
    const second = await scan(cache, LINUX_ENV, otherSkillsDir, 1_000);

    // Same location id, same relative layout, identical bytes — and still two
    // memo entries pointing at their own root, because the key carries the
    // resolved path. This is the mechanism that will keep a workspace copy from
    // being served as the home one; it has to hold before there is a workspace
    // location to rely on it.
    expect(second).not.toBe(first);
    expect(first[0]?.instances[0]?.path).toBe(join(skillsDir, 'gh'));
    expect(second[0]?.instances[0]?.path).toBe(join(otherSkillsDir, 'gh'));
  });

  it('shares one entry across workspace roots while the seam is inert', async () => {
    const cache = new LibraryCache();
    const first = await scan(cache, { ...LINUX_ENV, workspaceRoot: '/repos/a' }, skillsDir, 1_000);

    // Correct, not an oversight: no location resolves under `workspaceRoot`, so
    // it cannot change what a scan finds. The day one does, its resolved path
    // moves with the root and the key above separates the two on its own.
    expect(await scan(cache, { ...LINUX_ENV, workspaceRoot: '/repos/b' }, skillsDir, 1_000)).toBe(
      first
    );
  });

  it('keys instance hashes by absolute path, so equal relative paths under two roots differ', () => {
    const cache = new LibraryCache();
    const fingerprint = 'size:1|mtime:1';
    const hashed = (path: string) =>
      cache.getOrComputeInstanceHash(path, fingerprint, false, async () => ({
        contentHash: path,
        sizeBytes: 1,
        whitespaceHash: path,
        display: {},
      }));

    const underA = hashed('/repos/a/.claude/skills/gh');
    const underB = hashed('/repos/b/.claude/skills/gh');

    expect(underB).not.toBe(underA);
    expect(hashed('/repos/a/.claude/skills/gh')).toBe(underA);
  });
});
