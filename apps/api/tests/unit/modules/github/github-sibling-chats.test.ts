import { afterEach, describe, expect, it } from 'bun:test';

import { RemoteError, RESERVED_ERROR_CODES } from '@mangostudio/protocol';

import type { ChatWorkdirBinding } from '../../../../src/modules/chats/infrastructure/chat-repository';
import { createDirectorySpellingResolver } from '../../../../src/modules/git/infrastructure/runtime-directories';
import {
  findSiblingChatIds,
  type SiblingChatDependencies,
  type SiblingTarget,
} from '../../../../src/modules/github/application/github-sibling-chats';
import { createTargetPaths } from '../../../../src/services/runtime-client/target-paths';
import {
  type FakeWorkspaceRuntime,
  installFakeWorkspaceRuntime,
} from '../../../support/fake-workspace-runtime';

const paths = createTargetPaths({ pathStyle: 'posix', homeDir: '/home/u' } as Parameters<
  typeof createTargetPaths
>[0]);

/** Answers the candidate read from a fixed list, and records what it was asked for. */
class FakeBindingIndex {
  readonly excluded: string[] = [];

  constructor(private readonly bindings: readonly ChatWorkdirBinding[]) {}

  /** Real path rules and the real resolver, over the fake runtime installed by the test. */
  get dependencies(): SiblingChatDependencies {
    return {
      listBindings: (_userId, _environmentId, excludeChatId) => {
        this.excluded.push(excludeChatId);
        return Promise.resolve(this.bindings);
      },
      readPaths: () => Promise.resolve(paths),
      createResolver: createDirectorySpellingResolver,
    };
  }
}

const TARGET: SiblingTarget = {
  userId: 'user-1',
  chatId: 'writer',
  environmentId: 'devbox',
  workdir: '/real/repo',
};

let runtime: FakeWorkspaceRuntime | undefined;

afterEach(() => {
  runtime?.restore();
  runtime = undefined;
});

describe('findSiblingChatIds', () => {
  it('finds a sibling bound through a symlinked path to the written workdir (#950)', async () => {
    runtime = installFakeWorkspaceRuntime({
      '/real/repo': '/real/repo',
      '/link/repo': '/real/repo',
      '/real/other': '/real/other',
    });
    const index = new FakeBindingIndex([
      { chatId: 'via-symlink', workdir: '/link/repo' },
      { chatId: 'same-string', workdir: '/real/repo' },
      { chatId: 'elsewhere', workdir: '/real/other' },
    ]);

    const ids = await findSiblingChatIds(TARGET, undefined, index.dependencies);

    expect(ids.sort()).toEqual(['same-string', 'via-symlink']);
    expect(index.excluded).toEqual(['writer']);
  });

  it('finds a sibling when the written workdir is the symlinked spelling', async () => {
    runtime = installFakeWorkspaceRuntime({
      '/link/repo': '/real/repo',
      '/real/repo': '/real/repo',
    });
    const index = new FakeBindingIndex([{ chatId: 'on-target', workdir: '/real/repo' }]);

    const ids = await findSiblingChatIds(
      { ...TARGET, workdir: '/link/repo' },
      undefined,
      index.dependencies
    );

    expect(ids).toEqual(['on-target']);
  });

  it('does not treat a subdirectory or a similarly named directory as the same workdir', async () => {
    runtime = installFakeWorkspaceRuntime({
      '/real/repo': '/real/repo',
      '/real/repo/pkg': '/real/repo/pkg',
      '/real/repo-two': '/real/repo-two',
    });
    const index = new FakeBindingIndex([
      { chatId: 'subdir', workdir: '/real/repo/pkg' },
      { chatId: 'prefix', workdir: '/real/repo-two' },
    ]);

    const ids = await findSiblingChatIds(TARGET, undefined, index.dependencies);

    expect(ids).toEqual([]);
  });

  it('widens to chats at or under a resolved root, however they reach it', async () => {
    runtime = installFakeWorkspaceRuntime({
      '/real/repo': '/real/repo',
      '/link/repo': '/real/repo',
      '/link/repo/apps/api': '/real/repo/apps/api',
      '/real/repo/apps/web': '/real/repo/apps/web',
      '/real/repo-two': '/real/repo-two',
    });
    const index = new FakeBindingIndex([
      { chatId: 'root-via-symlink', workdir: '/link/repo' },
      { chatId: 'subdir-via-symlink', workdir: '/link/repo/apps/api' },
      { chatId: 'subdir', workdir: '/real/repo/apps/web' },
      { chatId: 'prefix', workdir: '/real/repo-two' },
    ]);

    const ids = await findSiblingChatIds(
      { ...TARGET, root: '/real/repo' },
      undefined,
      index.dependencies
    );

    expect(ids.sort()).toEqual(['root-via-symlink', 'subdir', 'subdir-via-symlink']);
  });

  it('resolves nothing when the writer is the only chat bound on the machine', async () => {
    runtime = installFakeWorkspaceRuntime({});
    const index = new FakeBindingIndex([]);

    const ids = await findSiblingChatIds(TARGET, undefined, index.dependencies);

    expect(ids).toEqual([]);
    expect(runtime.validated).toEqual([]);
  });

  it('resolves each distinct directory once, however many chats share it', async () => {
    runtime = installFakeWorkspaceRuntime({
      '/real/repo': '/real/repo',
      '/link/repo': '/real/repo',
    });
    const index = new FakeBindingIndex([
      { chatId: 'a', workdir: '/link/repo' },
      { chatId: 'b', workdir: '/link/repo' },
      { chatId: 'c', workdir: '/real/repo' },
    ]);

    await findSiblingChatIds(TARGET, undefined, index.dependencies);

    expect([...runtime.validated].sort()).toEqual(['/link/repo', '/real/repo']);
  });

  it('falls back to the stored strings when the runtime cannot be asked', async () => {
    runtime = installFakeWorkspaceRuntime({
      '/real/repo': new RemoteError(RESERVED_ERROR_CODES.UNAVAILABLE, 'runtime went away'),
      '/link/repo': new RemoteError(RESERVED_ERROR_CODES.UNAVAILABLE, 'runtime went away'),
    });
    const index = new FakeBindingIndex([
      { chatId: 'via-symlink', workdir: '/link/repo' },
      { chatId: 'same-string', workdir: '/real/repo/' },
    ]);

    const ids = await findSiblingChatIds(TARGET, undefined, index.dependencies);

    // The symlinked binding is unreachable without the runtime; the lexical one
    // (trailing separator and all) still hears about the write.
    expect(ids).toEqual(['same-string']);
  });

  it('keeps matching when the runtime fails on one directory', async () => {
    runtime = installFakeWorkspaceRuntime({
      '/real/repo': '/real/repo',
      '/link/repo': '/real/repo',
      '/broken/loop': new RemoteError('INTERNAL', 'ELOOP: too many levels of symbolic links'),
    });
    const index = new FakeBindingIndex([
      { chatId: 'broken', workdir: '/broken/loop' },
      { chatId: 'via-symlink', workdir: '/link/repo' },
    ]);

    const ids = await findSiblingChatIds(TARGET, undefined, index.dependencies);

    expect(ids).toEqual(['via-symlink']);
  });
});
