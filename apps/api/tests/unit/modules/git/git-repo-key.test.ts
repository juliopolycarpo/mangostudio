import { describe, expect, it } from 'bun:test';

import { REPO_KEY_MAX_LENGTH, repoTopic } from '@mangostudio/shared/realtime';

import {
  createRepoKeyResolver,
  deriveRepoKey,
  type ResolveRepoLockScope,
} from '../../../../src/modules/git/application/git-repo-key';

const SELECTION = { userId: 'user-1', environmentId: 'local' } as const;

/** Answers lock scopes from a table and counts how often Git would have been spawned. */
class FakeLockScopes {
  calls = 0;

  constructor(private readonly scopes: Record<string, string>) {}

  resolve: ResolveRepoLockScope = (root) => {
    this.calls += 1;
    const scope = this.scopes[root];
    return scope === undefined
      ? Promise.reject(new Error(`no scope for ${root}`))
      : Promise.resolve(scope);
  };
}

describe('deriveRepoKey', () => {
  it('is deterministic, URL-safe and a valid topic key', () => {
    const key = deriveRepoKey('local', '/repo/.git');

    expect(deriveRepoKey('local', '/repo/.git')).toBe(key);
    expect(key).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(key.length).toBeLessThanOrEqual(REPO_KEY_MAX_LENGTH);
    expect(repoTopic(key)).toBe(`repo:${key}`);
  });

  it('keeps the same path on two environments apart', () => {
    expect(deriveRepoKey('local', '/repo/.git')).not.toBe(deriveRepoKey('devbox', '/repo/.git'));
  });

  it('does not leak the path into the key', () => {
    expect(deriveRepoKey('local', '/home/someone/secret-project/.git')).not.toContain('secret');
  });
});

describe('createRepoKeyResolver', () => {
  it('gives every worktree of one repository the key of its shared common directory', async () => {
    // The main worktree and a linked one report the same common directory.
    const scopes = new FakeLockScopes({ '/repo': '/repo/.git', '/repo-wt': '/repo/.git' });
    const resolveRepoKey = createRepoKeyResolver({ resolveLockScope: scopes.resolve });

    expect(await resolveRepoKey(SELECTION, '/repo')).toBe(
      await resolveRepoKey(SELECTION, '/repo-wt')
    );
  });

  it('gives unrelated repositories different keys', async () => {
    const scopes = new FakeLockScopes({ '/a': '/a/.git', '/b': '/b/.git' });
    const resolveRepoKey = createRepoKeyResolver({ resolveLockScope: scopes.resolve });

    expect(await resolveRepoKey(SELECTION, '/a')).not.toBe(await resolveRepoKey(SELECTION, '/b'));
  });

  it('resolves a root once while its key is fresh and again after the ttl', async () => {
    let clock = 1_000;
    const scopes = new FakeLockScopes({ '/repo': '/repo/.git' });
    const resolveRepoKey = createRepoKeyResolver({
      resolveLockScope: scopes.resolve,
      now: () => clock,
    });

    await resolveRepoKey(SELECTION, '/repo');
    await resolveRepoKey(SELECTION, '/repo');
    expect(scopes.calls).toBe(1);

    clock += 61_000;
    await resolveRepoKey(SELECTION, '/repo');
    expect(scopes.calls).toBe(2);
  });

  it('shares one lookup between concurrent callers', async () => {
    const scopes = new FakeLockScopes({ '/repo': '/repo/.git' });
    const resolveRepoKey = createRepoKeyResolver({ resolveLockScope: scopes.resolve });

    const keys = await Promise.all([
      resolveRepoKey(SELECTION, '/repo'),
      resolveRepoKey(SELECTION, '/repo'),
      resolveRepoKey(SELECTION, '/repo'),
    ]);

    expect(scopes.calls).toBe(1);
    expect(new Set(keys).size).toBe(1);
  });

  it('answers undefined, without rejecting or caching, when the scope cannot be read', async () => {
    const scopes = new FakeLockScopes({});
    const resolveRepoKey = createRepoKeyResolver({ resolveLockScope: scopes.resolve });

    expect(await resolveRepoKey(SELECTION, '/gone')).toBeUndefined();
    expect(await resolveRepoKey(SELECTION, '/gone')).toBeUndefined();
    // A failure is retried on the next ask rather than remembered.
    expect(scopes.calls).toBe(2);
  });

  it('answers undefined when the lookup throws synchronously', async () => {
    const resolveRepoKey = createRepoKeyResolver({
      resolveLockScope: () => {
        throw new Error('runtime offline');
      },
    });

    expect(await resolveRepoKey(SELECTION, '/repo')).toBeUndefined();
    expect(await resolveRepoKey(SELECTION, '/repo')).toBeUndefined();
  });
});
