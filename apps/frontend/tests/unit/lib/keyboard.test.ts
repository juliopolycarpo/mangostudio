/**
 * The chord predicate behind the one global shortcut. Events are built as plain
 * objects rather than `KeyboardEvent` because `isComposing` is readonly on the
 * real constructor and cannot be set from a test.
 */

import { describe, expect, it } from 'bun:test';
import { isNewChatShortcut } from '../../../src/lib/keyboard';

function keydown(overrides: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: 'n',
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    isComposing: false,
    keyCode: 78,
    ...overrides,
  } as KeyboardEvent;
}

describe('isNewChatShortcut', () => {
  it('accepts mod+N on either platform, in either case', () => {
    expect(isNewChatShortcut(keydown({ metaKey: true }))).toBe(true);
    expect(isNewChatShortcut(keydown({ ctrlKey: true }))).toBe(true);
    expect(isNewChatShortcut(keydown({ ctrlKey: true, key: 'N' }))).toBe(true);
  });

  it('rejects the bare key and any extra modifier', () => {
    expect(isNewChatShortcut(keydown({}))).toBe(false);
    expect(isNewChatShortcut(keydown({ ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isNewChatShortcut(keydown({ metaKey: true, altKey: true }))).toBe(false);
    expect(isNewChatShortcut(keydown({ ctrlKey: true, key: 'm' }))).toBe(false);
    expect(isNewChatShortcut(keydown({ ctrlKey: true, metaKey: true }))).toBe(false);
  });

  it('stays out of an IME composition session', () => {
    expect(isNewChatShortcut(keydown({ ctrlKey: true, isComposing: true }))).toBe(false);
    // The legacy signal, for the engines that never set `isComposing`.
    expect(isNewChatShortcut(keydown({ ctrlKey: true, keyCode: 229 }))).toBe(false);
  });

  it('still fires from inside an editable target — the composer is the point', () => {
    const fromTextarea = keydown({ ctrlKey: true, target: document.createElement('textarea') });
    expect(isNewChatShortcut(fromTextarea)).toBe(true);
  });
});
