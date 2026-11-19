import { describe, expect, it } from 'bun:test';

import type { GitScope } from '@mangostudio/shared/realtime';

import { createGitInvalidationCoalescer } from '@/features/workspace/hooks/git-invalidation-coalescer';

interface Applied {
  readonly chatId: string;
  readonly scopes: readonly GitScope[];
}

/** Records what the coalescer applies, sorted so the assertion ignores merge order. */
function recordingApply() {
  const applied: Applied[] = [];
  const apply = (chatId: string, scopes: ReadonlySet<GitScope>) => {
    applied.push({ chatId, scopes: [...scopes].sort() });
    return Promise.resolve();
  };
  return { applied, apply };
}

describe('createGitInvalidationCoalescer', () => {
  it('applies the frames of one window once per chat with their scopes merged', async () => {
    const { applied, apply } = recordingApply();
    const coalescer = createGitInvalidationCoalescer(apply, 5);

    // One write announced on the per-chat topic and again on the repo topic.
    const first = coalescer.schedule('chat-a', ['state', 'diffs']);
    const second = coalescer.schedule('chat-a', ['state', 'github']);
    await Promise.all([first, second]);

    expect(applied).toEqual([{ chatId: 'chat-a', scopes: ['diffs', 'github', 'state'] }]);
  });

  it('applies every chat of a window in one pass', async () => {
    const { applied, apply } = recordingApply();
    const coalescer = createGitInvalidationCoalescer(apply, 5);

    await Promise.all(
      ['chat-a', 'chat-b', 'chat-c'].map((chatId) => coalescer.schedule(chatId, ['state']))
    );

    expect(applied.map((entry) => entry.chatId)).toEqual(['chat-a', 'chat-b', 'chat-c']);
  });

  it('starts a new window once the previous one was applied', async () => {
    const { applied, apply } = recordingApply();
    const coalescer = createGitInvalidationCoalescer(apply, 5);

    await coalescer.schedule('chat-a', ['state']);
    await coalescer.schedule('chat-a', ['state']);

    expect(applied).toHaveLength(2);
  });

  it('does not extend the window while frames keep arriving', async () => {
    const { applied, apply } = recordingApply();
    const coalescer = createGitInvalidationCoalescer(apply, 20);

    const first = coalescer.schedule('chat-a', ['state']);
    await Bun.sleep(12);
    coalescer.schedule('chat-a', ['branches']).catch(() => undefined);
    await first;

    // The window was fixed by the first frame, so the later one merged into it
    // rather than pushing the refresh out.
    expect(applied).toEqual([{ chatId: 'chat-a', scopes: ['branches', 'state'] }]);
  });

  it('resolves, and keeps working, when applying a window fails', async () => {
    const applied: string[] = [];
    let failNext = true;
    const coalescer = createGitInvalidationCoalescer((chatId) => {
      applied.push(chatId);
      if (failNext) {
        failNext = false;
        return Promise.reject(new Error('refetch failed'));
      }
      return Promise.resolve();
    }, 5);

    await expect(coalescer.schedule('chat-a', ['state'])).resolves.toBeUndefined();
    await coalescer.schedule('chat-b', ['state']);

    expect(applied).toEqual(['chat-a', 'chat-b']);
  });
});
