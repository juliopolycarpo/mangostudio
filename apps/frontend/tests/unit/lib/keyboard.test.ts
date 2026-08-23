/**
 * The chord predicates behind the two global shortcuts. Events are built as
 * plain objects rather than `KeyboardEvent` because `isComposing` is readonly
 * on the real constructor and cannot be set from a test.
 */

import { describe, expect, it } from 'bun:test';
import { isCommandPaletteShortcut, isNewChatShortcut } from '../../../src/lib/keyboard';

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

describe('isCommandPaletteShortcut', () => {
  it('accepts mod+K on either platform, in either case', () => {
    expect(isCommandPaletteShortcut(keydown({ metaKey: true, key: 'k' }))).toBe(true);
    expect(isCommandPaletteShortcut(keydown({ ctrlKey: true, key: 'k' }))).toBe(true);
    expect(isCommandPaletteShortcut(keydown({ ctrlKey: true, key: 'K' }))).toBe(true);
  });

  it('claims nothing but its own chord, so plain typing is untouched', () => {
    expect(isCommandPaletteShortcut(keydown({ key: 'k' }))).toBe(false);
    expect(isCommandPaletteShortcut(keydown({ ctrlKey: true, shiftKey: true, key: 'k' }))).toBe(
      false
    );
    expect(isCommandPaletteShortcut(keydown({ ctrlKey: true }))).toBe(false);
  });

  it('does not collide with the new-chat chord', () => {
    expect(isCommandPaletteShortcut(keydown({ ctrlKey: true, key: 'n' }))).toBe(false);
    expect(isNewChatShortcut(keydown({ ctrlKey: true, key: 'k' }))).toBe(false);
  });

  it('stays out of an IME composition session', () => {
    expect(isCommandPaletteShortcut(keydown({ ctrlKey: true, key: 'k', isComposing: true }))).toBe(
      false
    );
    expect(isCommandPaletteShortcut(keydown({ ctrlKey: true, key: 'k', keyCode: 229 }))).toBe(
      false
    );
  });
});
