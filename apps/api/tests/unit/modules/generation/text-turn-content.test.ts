import { describe, expect, it } from 'bun:test';
import {
  assertTextTurnHasContent,
  EmptyTextTurnError,
  normalizeTextTurnAttachmentIds,
} from '../../../../src/modules/generation/application/text-turn-content';

describe('text turn content helpers', () => {
  it('trims and de-duplicates attachment IDs', () => {
    expect(
      normalizeTextTurnAttachmentIds([' attachment-a ', '', 'attachment-b', 'attachment-a'])
    ).toEqual(['attachment-a', 'attachment-b']);
  });

  it('allows attachment-only turns', () => {
    expect(() => assertTextTurnHasContent('   ', ['attachment-a'])).not.toThrow();
  });

  it('rejects turns without prompt text or attachments', () => {
    expect(() => assertTextTurnHasContent('   ', [])).toThrow(EmptyTextTurnError);
  });
});
