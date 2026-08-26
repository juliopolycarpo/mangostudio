/**
 * The composer draft the "review comments" action writes into: append, never
 * replace.
 *
 * The composer may already hold unsent text — the sibling paste-reference
 * action already treats a draft as something to add to, not overwrite, and
 * this is the same rule applied to a multi-line task list instead of a
 * one-line reference.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import {
  resetComposerDraftsForTest,
  setComposerDraft,
} from '../../../../src/features/chat/lib/composer-draft-store';
import { appendTask } from '../../../../src/features/github/components/GithubPrDetail';

const CHAT_ID = 'chat-1';
const TASK =
  'Address these unresolved review comments on mango/studio#942:\n\n1. src/a.ts:42\n   alice: Rename this.';

describe('appendTask', () => {
  afterEach(() => resetComposerDraftsForTest());

  it('returns the task as-is when the composer is empty', () => {
    expect(appendTask(CHAT_ID, TASK)).toBe(TASK);
  });

  it('appends onto an existing draft with a blank line between them, not overwriting it', () => {
    setComposerDraft(CHAT_ID, 'Also check the migration script.');

    expect(appendTask(CHAT_ID, TASK)).toBe(`Also check the migration script.\n\n${TASK}`);
  });

  it('trims trailing whitespace off the existing draft before joining', () => {
    setComposerDraft(CHAT_ID, 'Half a thought   ');

    expect(appendTask(CHAT_ID, TASK)).toBe(`Half a thought\n\n${TASK}`);
  });

  it("never touches a different chat's draft", () => {
    setComposerDraft('chat-2', 'Unrelated draft.');

    expect(appendTask(CHAT_ID, TASK)).toBe(TASK);
  });
});
