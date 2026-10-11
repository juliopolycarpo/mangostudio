import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

describe('the runtime relay cap', () => {
  it('forwards exactly as many notices as the hub keeps', () => {
    const relay = readFileSync(
      join(import.meta.dir, '../../../../crates/mangostudio-runtime/src/external_agents/turns.rs'),
      'utf8'
    );
    const declared = /const NOTICES_PER_TURN: usize = (\d+);/.exec(relay)?.[1];
    expect(
      declared,
      `expected turns.rs to declare NOTICES_PER_TURN = ${MAX_EXTERNAL_NOTICES_PER_TURN} | received ${declared}`
    ).toBe(String(MAX_EXTERNAL_NOTICES_PER_TURN));
  });
});
