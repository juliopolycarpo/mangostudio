import { afterEach, describe, expect, it } from 'bun:test';
import type { RealtimeServerMessage } from '@mangostudio/shared/realtime';
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

/** Answers the sibling enumeration from a fixed list, without a database. */
class FakeSiblingIndex {
  readonly queries: Array<{ userId: string; environmentId: string; workdir: string }> = [];

  constructor(private readonly chatIds: readonly string[]) {}

  list = (userId: string, environmentId: string, workdir: string): Promise<string[]> => {
    this.queries.push({ userId, environmentId, workdir });
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

    await publishGithubWriteInvalidation(TARGET, 'create', { listSiblingChatIds: siblings.list });
    await publishGithubWriteInvalidation(TARGET, 'ready', { listSiblingChatIds: siblings.list });

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

    await publishGithubWriteInvalidation(TARGET, 'checkout', { listSiblingChatIds: siblings.list });

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

    await publishGithubWriteInvalidation(TARGET, 'checkout', { listSiblingChatIds: siblings.list });

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

  it('still invalidates the initiating chat when the sibling enumeration fails', async () => {
    // The write already happened by publish time; a broken lookup must not
    // reject up into the write response nor swallow the one publish that
    // definitely applies.
    const bus = installBus();
    const listSiblingChatIds = () => Promise.reject(new Error('db unavailable'));

    await expect(
      publishGithubWriteInvalidation(TARGET, 'ready', { listSiblingChatIds })
    ).resolves.toBeUndefined();

    expect(bus.published).toEqual([
      {
        userId: 'user-1',
        message: { type: 'invalidate', topic: 'git:chat-1', scopes: ['github'] },
      },
    ]);
  });
});
