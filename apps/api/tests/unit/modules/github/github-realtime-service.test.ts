import { afterEach, describe, expect, it } from 'bun:test';
import type { RealtimeServerMessage } from '@mangostudio/shared/realtime';
import { publishGithubWriteInvalidation } from '../../../../src/modules/github/application/github-realtime-service';
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

function installBus(): RecordingRealtimeBus {
  const bus = new RecordingRealtimeBus();
  setRealtimeBusForTests(bus as unknown as ReturnType<typeof getRealtimeBus>);
  return bus;
}

afterEach(() => {
  setRealtimeBusForTests(undefined);
});

describe('GitHub write invalidation', () => {
  it('invalidates only the github slice after opening or readying a pull request', () => {
    const bus = installBus();

    publishGithubWriteInvalidation({ userId: 'user-1', chatId: 'chat-1' }, 'create');
    publishGithubWriteInvalidation({ userId: 'user-1', chatId: 'chat-1' }, 'ready');

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

  it('invalidates the working tree too after a checkout', () => {
    // `gh pr checkout` fetches a ref and switches branches, so the state, the
    // branch list, the history and every open diff are about a different
    // commit afterwards — not just the GitHub lists.
    const bus = installBus();

    publishGithubWriteInvalidation({ userId: 'user-1', chatId: 'chat-1' }, 'checkout');

    expect(bus.published[0]?.message).toEqual({
      type: 'invalidate',
      topic: 'git:chat-1',
      scopes: ['state', 'branches', 'history', 'diffs', 'github'],
    });
  });
});
