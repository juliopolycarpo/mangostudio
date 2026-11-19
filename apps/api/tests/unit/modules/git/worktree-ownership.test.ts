import { afterEach, describe, expect, it } from 'bun:test';

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
});
