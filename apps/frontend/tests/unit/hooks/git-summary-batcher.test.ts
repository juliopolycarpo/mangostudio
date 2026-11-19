import { describe, expect, it } from 'bun:test';

import { GIT_BATCH_STATE_MAX_CHAT_IDS, type GitSummary } from '@mangostudio/shared/git';

import { createGitSummaryBatcher } from '@/features/workspace/hooks/git-summary-batcher';

function summaryFor(chatId: string): GitSummary {
  return { branch: `branch-${chatId}`, ahead: 0, behind: 0, changedFileCount: 1, workdir: '/r' };
}

/** Records every chunk it is asked for and answers all of them but `unanswered-*` ids. */
function createRecordingChunkFetcher() {
  const chunks: string[][] = [];
  return {
    chunks,
    // eslint-disable-next-line @typescript-eslint/require-await -- Keeps the fetcher's async contract.
    fetchChunk: async (chatIds: readonly string[]) => {
      chunks.push([...chatIds]);
      return Object.fromEntries(
        chatIds.filter((id) => !id.startsWith('unanswered-')).map((id) => [id, summaryFor(id)])
      );
    },
  };
}

describe('createGitSummaryBatcher', () => {
  it('sends reads that start together as one sorted request', async () => {
    const { chunks, fetchChunk } = createRecordingChunkFetcher();
    const batcher = createGitSummaryBatcher(fetchChunk);

    const [b, a] = await Promise.all([batcher.load('b'), batcher.load('a')]);

    expect(chunks).toEqual([['a', 'b']]);
    expect(a).toEqual(summaryFor('a'));
    expect(b).toEqual(summaryFor('b'));
  });

  it('splits at the endpoint limit instead of sending an oversized request', async () => {
    const { chunks, fetchChunk } = createRecordingChunkFetcher();
    const batcher = createGitSummaryBatcher(fetchChunk);
    const total = GIT_BATCH_STATE_MAX_CHAT_IDS * 2 + 5;

    await Promise.all(
      Array.from({ length: total }, (_, index) =>
        batcher.load(`chat-${String(index).padStart(3, '0')}`)
      )
    );

    expect(chunks.map((chunk) => chunk.length)).toEqual([
      GIT_BATCH_STATE_MAX_CHAT_IDS,
      GIT_BATCH_STATE_MAX_CHAT_IDS,
      5,
    ]);
  });

  it('resolves a chat the server left out as null', async () => {
    const { fetchChunk } = createRecordingChunkFetcher();
    const batcher = createGitSummaryBatcher(fetchChunk);

    expect(await batcher.load('unanswered-1')).toBeNull();
  });

  it('shares one request slot between two reads of the same chat', async () => {
    const { chunks, fetchChunk } = createRecordingChunkFetcher();
    const batcher = createGitSummaryBatcher(fetchChunk);

    const [first, second] = await Promise.all([batcher.load('a'), batcher.load('a')]);

    expect(chunks).toEqual([['a']]);
    expect(first).toEqual(second);
  });

  it('starts a new request for a read that arrives after the previous one left', async () => {
    const { chunks, fetchChunk } = createRecordingChunkFetcher();
    const batcher = createGitSummaryBatcher(fetchChunk);

    await batcher.load('a');
    await batcher.load('b');

    expect(chunks).toEqual([['a'], ['b']]);
  });

  it('rejects only the reads whose request failed', async () => {
    const failure = new Error('batch endpoint refused chunk');
    const batcher = createGitSummaryBatcher((chatIds) =>
      chatIds.includes('chat-000')
        ? Promise.reject(failure)
        : Promise.resolve(Object.fromEntries(chatIds.map((id) => [id, summaryFor(id)])))
    );
    const ids = Array.from(
      { length: GIT_BATCH_STATE_MAX_CHAT_IDS + 1 },
      (_, index) => `chat-${String(index).padStart(3, '0')}`
    );

    const settled = await Promise.allSettled(ids.map((id) => batcher.load(id)));

    // `chat-000` sorts into the first chunk; the one id past the limit rides a
    // second request that succeeds.
    expect(settled[0]).toEqual({ status: 'rejected', reason: failure });
    expect(settled.at(-1)).toEqual({
      status: 'fulfilled',
      value: summaryFor(ids.at(-1) as string),
    });
  });
});
