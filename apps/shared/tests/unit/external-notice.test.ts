import { describe, expect, it } from 'bun:test';

import {
  canAddExternalNotice,
  externalNoticePart,
  lastContentIndex,
  MAX_EXTERNAL_NOTICES_PER_TURN,
} from '../../src/external-agents';
import type { MessagePart } from '../../src/types';

describe('externalNoticePart', () => {
  it('keeps the severity and the words and nothing else', () => {
    expect(
      externalNoticePart({ severity: 'warning', title: 'Rate limit close', description: 'Soon.' })
    ).toEqual({
      type: 'external_notice',
      severity: 'warning',
      title: 'Rate limit close',
      description: 'Soon.',
    });
  });

  it('leaves an absent description absent rather than undefined', () => {
    expect(externalNoticePart({ severity: 'info', title: 'Retrying' })).toStrictEqual({
      type: 'external_notice',
      severity: 'info',
      title: 'Retrying',
    });
  });
});

describe('canAddExternalNotice', () => {
  const notice: MessagePart = { type: 'external_notice', severity: 'info', title: 'again' };

  it('counts only notices against the cap', () => {
    const prose: MessagePart[] = Array.from({ length: 20 }, () => ({ type: 'text', text: 'x' }));
    expect(canAddExternalNotice(prose)).toBe(true);
  });

  it('refuses the notice after the last one the cap allows', () => {
    const received = [MAX_EXTERNAL_NOTICES_PER_TURN - 1, MAX_EXTERNAL_NOTICES_PER_TURN].map(
      (count) => canAddExternalNotice(Array.from({ length: count }, () => notice))
    );
    expect(received).toEqual([true, false]);
  });
});

describe('lastContentIndex', () => {
  const text: MessagePart = { type: 'text', text: 'x' };
  const notice: MessagePart = { type: 'external_notice', severity: 'info', title: 'again' };

  it('skips trailing notices and nothing else', () => {
    const received = [
      lastContentIndex([text, notice, notice]),
      lastContentIndex([text, notice, text]),
      lastContentIndex([notice]),
      lastContentIndex([]),
    ];
    expect(received).toEqual([0, 2, -1, -1]);
  });
});
