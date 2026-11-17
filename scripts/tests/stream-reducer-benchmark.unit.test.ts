import { describe, expect, it } from 'bun:test';

import {
  type BenchedCache,
  buildChunks,
  countIdentityChanges,
  legacyPatchMessageInCache,
  median,
  runStream,
  seedCache,
  STREAM_KINDS,
  type StreamModules,
} from '../bench/stream-reducer';
/**
 * A reducer that appends each chunk's text to a one-part message: the same
 * shape of update as the shipped reducer, without importing the frontend.
 */
const appendingFakeModules: StreamModules = {
  createState: () => ({ aiMessageUpdate: null, text: '' }) as never,
  reduce: (state, chunk) => {
    const text = `${(state as unknown as { text: string }).text}${chunk.text as string}`;
    return {
      text,
      aiMessageUpdate: {
        targetMessageId: 'message-live',
        patch: { text, parts: [{ type: 'text', text }] },
      },
    } as never;
  },
  patch: (cache, messageId, updates) => {
    // Replaces only the newest page and the named row, like `patchMessageInCache`.
    const page = cache.pages[0];
    if (!page) return cache;
    const messages = page.messages.map((m) => (m.id === messageId ? { ...m, ...updates } : m));
    return { ...cache, pages: [{ ...page, messages }, ...cache.pages.slice(1)] };
  },
  patchSource: 'module',
};

describe('buildChunks', () => {
  it('builds the requested number of chunks of about 40 characters', () => {
    for (const kind of STREAM_KINDS) {
      const chunks = buildChunks(kind, 7);

      expect(chunks).toHaveLength(7);
      expect(chunks.every((chunk) => chunk.type === kind && String(chunk.text).length === 40)).toBe(
        true
      );
    }
  });

  it('addresses subagent text to one call', () => {
    const callIds = new Set(buildChunks('subagent_text', 3).map((chunk) => chunk.callId));

    expect([...callIds]).toEqual(['call-subagent-1']);
  });
});

describe('seedCache', () => {
  it('puts the live row last on the newest page, with history on two pages', () => {
    const cache = seedCache(4);

    expect(cache.pages).toHaveLength(2);
    expect(cache.pages[0]?.messages).toHaveLength(5);
    expect(cache.pages[0]?.messages.at(-1)?.id).toBe('message-live');
    expect(cache.pages[1]?.messages).toHaveLength(4);
  });
});

describe('countIdentityChanges', () => {
  it('counts nothing for the same cache', () => {
    const cache = seedCache(3);

    expect(countIdentityChanges(cache, cache)).toEqual({
      cache: 0,
      pages: 0,
      newestPageMessages: 0,
      liveMessage: 0,
      liveMessageParts: 0,
      siblingMessages: 0,
      olderPageMessages: 0,
    });
  });

  it('counts every page and every row the legacy updater rebuilt', () => {
    const cache = seedCache(3);

    const changes = countIdentityChanges(
      cache,
      legacyPatchMessageInCache(cache, 'message-live', { text: 'x', parts: [] })
    );

    expect(changes).toMatchObject({
      cache: 1,
      pages: 2,
      newestPageMessages: 1,
      liveMessage: 1,
      liveMessageParts: 1,
      siblingMessages: 0,
      olderPageMessages: 0,
    });
  });

  it('detects a sibling row that is replaced', () => {
    const cache = seedCache(3);
    const [first, ...rest] = cache.pages[0]?.messages ?? [];
    const newest = cache.pages[0];
    if (!newest || !first) throw new Error('expected a seeded newest page with rows');
    const replaced: BenchedCache = {
      ...cache,
      pages: [
        { ...newest, messages: [{ ...first, text: 'new' }, ...rest] },
        ...cache.pages.slice(1),
      ],
    };

    expect(countIdentityChanges(cache, replaced).siblingMessages).toBe(1);
  });
});

describe('median', () => {
  it('takes the middle sample, or the mean of the two middle ones', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

describe('runStream with a fake appending reducer', () => {
  it('replaces only the live row and its newest page on one more chunk', () => {
    for (const kind of STREAM_KINDS) {
      const run = runStream(appendingFakeModules, kind, 60, 5);

      expect(run.identity).toEqual({
        cache: 1,
        pages: 1,
        newestPageMessages: 1,
        liveMessage: 1,
        liveMessageParts: 1,
        siblingMessages: 0,
        olderPageMessages: 0,
      });
      expect(run.totalMs).toBeGreaterThan(0);
    }
  });

  it('fails the identity count of a revision that rebuilds every page', () => {
    const legacyModules: StreamModules = {
      ...appendingFakeModules,
      patch: legacyPatchMessageInCache,
      patchSource: 'legacy',
    };

    const run = runStream(legacyModules, 'text', 60, 5);

    expect(run.identity.pages).toBe(2);
  });
});
