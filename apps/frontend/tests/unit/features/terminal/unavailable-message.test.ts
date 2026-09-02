import { describe, expect, it } from 'bun:test';
import { en } from '@mangostudio/shared/i18n';
import type { TerminalRefusalReason } from '@mangostudio/shared/terminal';
import { unavailableMessage } from '../../../../src/features/terminal/unavailable-message';

describe('unavailableMessage', () => {
  const cases: ReadonlyArray<[TerminalRefusalReason, string]> = [
    ['disabled', en.terminal.unavailable.disabled],
    ['limit', en.terminal.unavailable.limit],
    ['not-isolated', en.terminal.unavailable.notIsolated],
    ['unavailable', en.terminal.unavailable.unavailable],
    ['disconnected', en.terminal.unavailable.disconnected],
  ];

  it.each(cases)('maps %s to its own copy, not another reason’s', (reason, expected) => {
    expect(unavailableMessage(en, reason)).toBe(expected);
  });

  it('gives every reason distinct copy (no two refusals read the same)', () => {
    const messages = cases.map(([reason]) => unavailableMessage(en, reason));
    expect(new Set(messages).size).toBe(cases.length);
  });
});
