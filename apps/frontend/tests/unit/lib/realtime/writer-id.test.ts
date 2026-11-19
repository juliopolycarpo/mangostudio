import { describe, expect, it } from 'bun:test';

import { RealtimeWriterIdSchema } from '@mangostudio/shared/realtime';
import Value from 'typebox/value';

import { getTabWriterId, isOwnWriterId, tabWriterHeaders } from '@/lib/realtime/writer-id';

describe('tab writer id', () => {
  it('is stable for the life of the page and fits the shared schema', () => {
    const first = getTabWriterId();

    expect(getTabWriterId()).toBe(first);
    expect(
      Value.Check(RealtimeWriterIdSchema, first),
      `expected a writer id matching RealtimeWriterIdSchema | received: ${first}`
    ).toBe(true);
  });

  it('names the tab under the shared header', () => {
    expect(tabWriterHeaders()).toEqual({ 'x-mangostudio-writer-id': getTabWriterId() });
  });

  it('recognises only its own id, never an absent one', () => {
    expect(isOwnWriterId(getTabWriterId())).toBe(true);
    expect(isOwnWriterId('another-tab')).toBe(false);
    // An event with no writer (older hub, hub-originated) is always someone else's.
    expect(isOwnWriterId(undefined)).toBe(false);
  });
});
