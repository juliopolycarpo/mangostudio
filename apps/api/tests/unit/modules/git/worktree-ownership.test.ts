import { afterEach, describe, expect, it } from 'bun:test';

import { RemoteError } from '@mangostudio/protocol';

import { createWorktreeOwnership } from '../../../../src/modules/git/application/worktree-ownership';
import type { ParsedWorktree } from '../../../../src/modules/git/domain/worktree-parser';
import { createTargetPaths } from '../../../../src/services/runtime-client/target-paths';
import {
  type FakeWorkspaceRuntime,
  installFakeWorkspaceRuntime,
} from '../../../support/fake-workspace-runtime';

const paths = createTargetPaths({ pathStyle: 'posix', homeDir: '/home/u' } as Parameters<
  typeof createTargetPaths
>[0]);
const selection = { userId: 'user-1', environmentId: 'devbox' };
let runtime: FakeWorkspaceRuntime | undefined;

afterEach(() => {
  runtime?.restore();
  runtime = undefined;
});

function parsed(path: string, overrides: Partial<ParsedWorktree> = {}): ParsedWorktree {
  return {
    path,
    head: '0a44a0f9bbf9a15117d5bbc4d543442f2b169d87',
    branch: 'main',
    isMain: false,
    isBare: false,
    isDetached: false,
    isLocked: false,
    isPrunable: false,
    ...overrides,
  };
}

const main = parsed('/real/main', { isMain: true });
const feature = parsed('/real/feature');

describe('createWorktreeOwnership', () => {
  it('flags a worktree a sibling chat reaches only through a symlinked spelling', async () => {
    runtime = installFakeWorkspaceRuntime({
      '/link/feature': '/real/feature',
      '/link/feature/packages/ui': '/real/feature/packages/ui',
      '/real/feature': '/real/feature',
      '/real/main': '/real/main',
    });

    for (const workdir of ['/link/feature', '/link/feature/packages/ui']) {
      const ownership = createWorktreeOwnership(paths, selection, () => Promise.resolve([workdir]));

      const annotated = await ownership.annotate([main, feature], '/real/main');

      expect(annotated.map(({ path, boundByOtherChat }) => [path, boundByOtherChat])).toEqual([
        ['/real/main', false],
        ['/real/feature', true],
      ]);
    }
  });

  it('flags a worktree whose own listed path is the symlinked spelling', async () => {
    runtime = installFakeWorkspaceRuntime({
      '/link/feature': '/real/feature',
      '/real/feature': '/real/feature',
    });
    const ownership = createWorktreeOwnership(paths, selection, () =>
      Promise.resolve(['/real/feature'])
    );

    const annotated = await ownership.annotate([parsed('/link/feature')], '/real/main');

    expect(annotated[0]?.boundByOtherChat).toBe(true);
  });

  it('leaves a neighbour that only shares a name prefix unflagged', async () => {
    runtime = installFakeWorkspaceRuntime({
      '/real/feature': '/real/feature',
      '/real/feature-2': '/real/feature-2',
    });
    const ownership = createWorktreeOwnership(paths, selection, () =>
      Promise.resolve(['/real/feature-2'])
    );

    const annotated = await ownership.annotate([feature], '/real/main');

    expect(annotated[0]?.boundByOtherChat).toBe(false);
  });

  it('compares a workdir that no longer exists as written', async () => {
    runtime = installFakeWorkspaceRuntime({ '/real/feature': '/real/feature' });
    const ownership = createWorktreeOwnership(paths, selection, () =>
      Promise.resolve(['/real/feature/packages/ui/'])
    );

    const annotated = await ownership.annotate([feature], '/real/main');

    expect(annotated[0]?.boundByOtherChat).toBe(true);
  });

  it('keeps isCurrent and boundByOtherChat independent', async () => {
    runtime = installFakeWorkspaceRuntime({});
    const ownership = createWorktreeOwnership(paths, selection, () =>
      Promise.resolve(['/real/feature'])
    );

    const annotated = await ownership.annotate([main, feature], '/real/main');

    expect(
      annotated.map(({ path, isCurrent, boundByOtherChat }) => [path, isCurrent, boundByOtherChat])
    ).toEqual([
      ['/real/main', true, false],
      ['/real/feature', false, true],
    ]);
  });

  it('makes no runtime request when no other chat is bound', async () => {
    runtime = installFakeWorkspaceRuntime({});
    const ownership = createWorktreeOwnership(paths, selection, () => Promise.resolve([]));

    const annotated = await ownership.annotate([main, feature], '/real/main');

    expect(annotated.map((worktree) => worktree.boundByOtherChat)).toEqual([false, false]);
    expect(runtime.validated).toEqual([]);
  });

  it('reads and resolves the sibling workdirs once however many lists it builds', async () => {
    runtime = installFakeWorkspaceRuntime({ '/link/feature': '/real/feature' });
    let reads = 0;
    const ownership = createWorktreeOwnership(paths, selection, () => {
      reads += 1;
      return Promise.resolve(['/link/feature']);
    });

    await ownership.annotate([main, feature], '/real/main');
    await ownership.annotate([main, feature], '/real/main');

    expect(reads).toBe(1);
    expect(runtime.validated.filter((path) => path === '/link/feature')).toEqual(['/link/feature']);
  });

  it('validates each worktree path once however many lists the request builds', async () => {
    runtime = installFakeWorkspaceRuntime({
      '/link/feature': '/real/feature',
      '/real/feature': '/real/feature',
      '/real/main': '/real/main',
    });
    const ownership = createWorktreeOwnership(paths, selection, () =>
      Promise.resolve(['/link/feature'])
    );

    await ownership.annotate([main, feature], '/real/main');
    await ownership.annotate([main, feature], '/real/main');

    // `removeWorktree` annotates twice, the second time inside the repository lock.
    expect([...runtime.validated].sort()).toEqual(['/link/feature', '/real/feature', '/real/main']);
  });

  describe('a directory the runtime fails on', () => {
    const brokenWorkdir = '/broken/loop';
    const failure = new RemoteError('INTERNAL', 'Too many levels of symbolic links (ELOOP)');

    it('keeps the list answering and flags the other siblings correctly', async () => {
      runtime = installFakeWorkspaceRuntime({
        [brokenWorkdir]: failure,
        '/link/feature': '/real/feature',
        '/real/feature': '/real/feature',
        '/real/main': '/real/main',
      });
      const ownership = createWorktreeOwnership(paths, selection, () =>
        Promise.resolve([brokenWorkdir, '/link/feature'])
      );

      const annotated = await ownership.annotate([main, feature], '/real/main');

      expect(annotated.map(({ path, boundByOtherChat }) => [path, boundByOtherChat])).toEqual([
        ['/real/main', false],
        ['/real/feature', true],
      ]);
    });

    it('compares the broken sibling as written', async () => {
      runtime = installFakeWorkspaceRuntime({
        '/real/feature/sub': failure,
        '/real/feature': '/real/feature',
      });
      const ownership = createWorktreeOwnership(paths, selection, () =>
        Promise.resolve(['/real/feature/sub'])
      );

      const annotated = await ownership.annotate([feature], '/real/main');

      expect(annotated[0]?.boundByOtherChat).toBe(true);
    });

    it('keeps a worktree whose own path the runtime fails on in the list', async () => {
      runtime = installFakeWorkspaceRuntime({ '/real/feature': failure });
      const ownership = createWorktreeOwnership(paths, selection, () =>
        Promise.resolve(['/real/feature'])
      );

      const annotated = await ownership.annotate([feature], '/real/main');

      expect(annotated[0]?.boundByOtherChat).toBe(true);
    });
  });

  it('fails closed when the runtime is unreachable instead of reporting nothing bound', async () => {
    runtime = installFakeWorkspaceRuntime({
      '/link/feature': new RemoteError('UNAVAILABLE', 'runtime connection closed'),
    });
    const ownership = createWorktreeOwnership(paths, selection, () =>
      Promise.resolve(['/link/feature'])
    );

    const outcome = await ownership
      .annotate([main, feature], '/real/main')
      .catch((e: unknown) => e);

    expect(outcome).toBeInstanceOf(RemoteError);
    expect((outcome as RemoteError).code).toBe('UNAVAILABLE');
  });

  describe('when the request is aborted', () => {
    it('hands the request signal to every validate call', async () => {
      runtime = installFakeWorkspaceRuntime({
        '/link/feature': '/real/feature',
        '/real/feature': '/real/feature',
      });
      const controller = new AbortController();
      const ownership = createWorktreeOwnership(
        paths,
        selection,
        () => Promise.resolve(['/link/feature']),
        controller.signal
      );

      await ownership.annotate([feature], '/real/main');

      expect(runtime.signals.length).toBeGreaterThan(0);
      expect(runtime.signals.every((signal) => signal === controller.signal)).toBe(true);
    });

    it('stops waiting on a lookup the runtime never answers', async () => {
      runtime = installFakeWorkspaceRuntime(
        { '/link/feature': '/real/feature' },
        { hanging: ['/real/feature'] }
      );
      const controller = new AbortController();
      const ownership = createWorktreeOwnership(
        paths,
        selection,
        () => Promise.resolve(['/link/feature']),
        controller.signal
      );

      const pending = ownership.annotate([feature], '/real/main');
      setTimeout(() => controller.abort(), 10);
      const outcome = await Promise.race([
        pending.catch((e: unknown) => e),
        new Promise<string>((resolve) => setTimeout(() => resolve('still pending'), 1_000)),
      ]);

      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).name).toBe('AbortError');
    });

    it('starts no lookup for a request that is already aborted', async () => {
      runtime = installFakeWorkspaceRuntime({ '/link/feature': '/real/feature' });
      const controller = new AbortController();
      controller.abort();
      const ownership = createWorktreeOwnership(
        paths,
        selection,
        () => Promise.resolve(['/link/feature']),
        controller.signal
      );

      const outcome = await ownership.annotate([feature], '/real/main').catch((e: unknown) => e);

      expect((outcome as Error).name).toBe('AbortError');
      expect(runtime.validated).toEqual([]);
    });
  });
});
