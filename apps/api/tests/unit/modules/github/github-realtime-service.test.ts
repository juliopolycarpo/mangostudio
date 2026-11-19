import { afterEach, describe, expect, it } from 'bun:test';

import type { RealtimeServerMessage } from '@mangostudio/shared/realtime';

import type {
  RepoInvalidationOptions,
  RepoInvalidationTarget,
} from '../../../../src/modules/git/application/repo-invalidation';
import {
  type GithubInvalidationTarget,
  publishGithubWriteInvalidation,
} from '../../../../src/modules/github/application/github-realtime-service';
import {
  type getRealtimeBus,
  setRealtimeBusForTests,
} from '../../../../src/services/realtime/realtime-bus';

interface Published {
  readonly userId: string;
  readonly message: RealtimeServerMessage;
}

/** Records what a write publishes, without a socket on the other end. */
class RecordingRealtimeBus {
  readonly published: Published[] = [];

  publish(userId: string, message: RealtimeServerMessage): void {
    this.published.push({ userId, message });
  }
}

/** A repository whose key cannot be resolved: no repo-wide frame is published. */
const UNRESOLVED_REPOSITORY: RepoInvalidationOptions = {
  resolveRepoKeyForTarget: () => Promise.resolve(undefined),
};

/** Answers the sibling enumeration from a fixed list, without a database. */
class FakeSiblingIndex {
  readonly queries: Array<{
    userId: string;
    environmentId: string;
    workdir: string;
    root?: string;
  }> = [];

  constructor(private readonly chatIds: readonly string[]) {}

  /** Options that also keep the repo-wide frame out of the way of per-chat assertions. */
  get options() {
    return { listSiblingChatIds: this.list, repoInvalidation: UNRESOLVED_REPOSITORY };
  }

  list = (target: GithubInvalidationTarget): Promise<string[]> => {
    const { userId, environmentId, workdir, root } = target;
    this.queries.push({ userId, environmentId, workdir, ...(root ? { root } : {}) });
    return Promise.resolve([...this.chatIds]);
  };
}

const TARGET: GithubInvalidationTarget = {
  userId: 'user-1',
  chatId: 'chat-1',
  environmentId: 'devbox',
  workdir: '/remote/repo',
};

function installBus(): RecordingRealtimeBus {
  const bus = new RecordingRealtimeBus();
  setRealtimeBusForTests(bus as unknown as ReturnType<typeof getRealtimeBus>);
  return bus;
}

afterEach(() => {
  setRealtimeBusForTests(undefined);
});

describe('GitHub write invalidation', () => {
  it('invalidates only the github slice after opening or readying a pull request', async () => {
    const bus = installBus();
    const siblings = new FakeSiblingIndex(['chat-1']);

    await publishGithubWriteInvalidation(TARGET, 'create', { ...siblings.options });
    await publishGithubWriteInvalidation(TARGET, 'ready', { ...siblings.options });

    expect(bus.published).toEqual([
      {
        userId: 'user-1',
        message: { type: 'invalidate', topic: 'git:chat-1', scopes: ['github'] },
      },
      {
        userId: 'user-1',
        message: { type: 'invalidate', topic: 'git:chat-1', scopes: ['github'] },
      },
    ]);
  });

  it('invalidates the working tree too after a checkout', async () => {
    // `gh pr checkout` fetches a ref and switches branches, so the state, the
    // branch list, the history and every open diff are about a different
    // commit afterwards — not just the GitHub lists.
    const bus = installBus();
    const siblings = new FakeSiblingIndex(['chat-1']);

    await publishGithubWriteInvalidation(TARGET, 'checkout', { ...siblings.options });

    expect(bus.published[0]?.message).toEqual({
      type: 'invalidate',
      topic: 'git:chat-1',
      scopes: ['state', 'branches', 'history', 'diffs', 'github'],
    });
  });

  it('fans the same scopes out to every chat on the same workdir and machine (#943)', async () => {
    // A second chat open on the repository reads the same GitHub state and the
    // same working tree, so it is exactly as stale as the chat that wrote.
    const bus = installBus();
    const siblings = new FakeSiblingIndex(['chat-2', 'chat-1', 'chat-3', 'chat-3']);

    await publishGithubWriteInvalidation(TARGET, 'checkout', { ...siblings.options });

    expect(siblings.queries).toEqual([
      { userId: 'user-1', environmentId: 'devbox', workdir: '/remote/repo' },
    ]);
    // The initiator first and exactly once, each sibling once despite the
    // duplicate row, all with the operation's own scopes.
    expect(
      bus.published.map((entry) =>
        entry.message.type === 'invalidate' ? entry.message.topic : entry.message.type
      )
    ).toEqual(['git:chat-1', 'git:chat-2', 'git:chat-3']);
    for (const entry of bus.published) {
      expect(entry.userId).toBe('user-1');
      expect(entry.message).toMatchObject({
        type: 'invalidate',
        scopes: ['state', 'branches', 'history', 'diffs', 'github'],
      });
    }
  });

  it('widens the checkout fan-out to chats under a resolved worktree root (#944)', async () => {
    // A chat bound to a package subdirectory of the same checkout shares the
    // same HEAD, index and working tree as one bound to the root.
    const bus = installBus();
    const siblings = new FakeSiblingIndex(['chat-2']);
    const target: GithubInvalidationTarget = { ...TARGET, root: '/remote/repo' };

    await publishGithubWriteInvalidation(target, 'checkout', { ...siblings.options });

    expect(siblings.queries).toEqual([
      { userId: 'user-1', environmentId: 'devbox', workdir: '/remote/repo', root: '/remote/repo' },
    ]);
    expect(
      bus.published.map((entry) =>
        entry.message.type === 'invalidate' ? entry.message.topic : entry.message.type
      )
    ).toEqual(['git:chat-1', 'git:chat-2']);
  });

  it('still invalidates the initiating chat when the sibling enumeration fails', async () => {
    // The write already happened by publish time; a broken lookup must not
    // reject up into the write response nor swallow the one publish that
    // definitely applies.
    const bus = installBus();
    const listSiblingChatIds = () => Promise.reject(new Error('db unavailable'));

    await expect(
      publishGithubWriteInvalidation(TARGET, 'ready', {
        listSiblingChatIds,
        repoInvalidation: UNRESOLVED_REPOSITORY,
      })
    ).resolves.toBeUndefined();

    expect(bus.published).toEqual([
      {
        userId: 'user-1',
        message: { type: 'invalidate', topic: 'git:chat-1', scopes: ['github'] },
      },
    ]);
  });
});

describe('GitHub write repo-wide invalidation (#945)', () => {
  /** Names one repository and records what it was asked to resolve. */
  class FakeRepositoryIndex {
    readonly targets: RepoInvalidationTarget[] = [];

    constructor(private readonly repoKey: string | undefined) {}

    get options(): RepoInvalidationOptions {
      return {
        resolveRepoKeyForTarget: (target) => {
          this.targets.push(target);
          return Promise.resolve(this.repoKey);
        },
      };
    }
  }

  it('publishes one repo frame with the write scopes next to the per-chat frame', async () => {
    const bus = installBus();
    const siblings = new FakeSiblingIndex([]);
    const repositories = new FakeRepositoryIndex('repoKeyAbc');

    await publishGithubWriteInvalidation(TARGET, 'create', {
      listSiblingChatIds: siblings.list,
      repoInvalidation: repositories.options,
    });

    // The per-chat frame stays: a tab that never learned a repo key relies on it.
    expect(bus.published).toEqual([
      {
        userId: 'user-1',
        message: { type: 'invalidate', topic: 'git:chat-1', scopes: ['github'] },
      },
      {
        userId: 'user-1',
        message: { type: 'invalidate', topic: 'repo:repoKeyAbc', scopes: ['github'] },
      },
    ]);
    expect(repositories.targets).toEqual([
      { userId: 'user-1', environmentId: 'devbox', workdir: '/remote/repo' },
    ]);
  });

  it('hands the resolved checkout root to the key lookup so it does not resolve it twice', async () => {
    installBus();
    const repositories = new FakeRepositoryIndex('repoKeyAbc');

    await publishGithubWriteInvalidation({ ...TARGET, root: '/remote/repo' }, 'checkout', {
      listSiblingChatIds: new FakeSiblingIndex([]).list,
      repoInvalidation: repositories.options,
    });

    expect(repositories.targets).toEqual([
      { userId: 'user-1', environmentId: 'devbox', workdir: '/remote/repo', root: '/remote/repo' },
    ]);
  });

  it('publishes no repo frame when the repository has no key', async () => {
    const bus = installBus();

    await publishGithubWriteInvalidation(TARGET, 'ready', {
      ...new FakeSiblingIndex([]).options,
    });

    expect(bus.published.map((entry) => entry.message)).toEqual([
      { type: 'invalidate', topic: 'git:chat-1', scopes: ['github'] },
    ]);
  });

  it('keeps the publish from rejecting when the key lookup throws', async () => {
    const bus = installBus();

    await expect(
      publishGithubWriteInvalidation(TARGET, 'ready', {
        listSiblingChatIds: new FakeSiblingIndex([]).list,
        repoInvalidation: {
          resolveRepoKeyForTarget: () => Promise.reject(new Error('git unavailable')),
        },
      })
    ).resolves.toBeUndefined();

    expect(bus.published).toHaveLength(1);
  });
});
