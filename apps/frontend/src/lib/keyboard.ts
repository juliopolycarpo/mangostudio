/** True on Apple platforms, where the modifier key is rendered `⌘`. */
function isApplePlatform(): boolean {
  const platform = typeof navigator === 'undefined' ? '' : navigator.platform;
  return /Mac|iPhone|iPad|iPod/.test(platform);
}

/** `⌘K` on Apple platforms, `Ctrl+K` elsewhere. Display only — both are bound. */
function modChordHint(key: string): string {
  return isApplePlatform() ? `⌘${key}` : `Ctrl+${key}`;
}

/** `⌘N` on Apple platforms, `Ctrl+N` elsewhere. Display only — both are bound. */
export function newChatShortcutHint(): string {
  return modChordHint('N');
}

/** `⌘K` on Apple platforms, `Ctrl+K` elsewhere. Display only — both are bound. */
export function commandPaletteShortcutHint(): string {
  return modChordHint('K');
}

/**
 * True when a keydown is mod+`key` with no other modifier.
 *
 * An IME composition session is not a chord: while composing, `event.key` is
 * whatever the IME is feeding back and the keystroke belongs to the editor, not
 * to the shell. Editable targets are deliberately *not* excluded — the composer
 * is where the user already is, and a shortcut that dies there is a shortcut
 * nobody can reach.
 */
function isModChord(event: KeyboardEvent, key: string): boolean {
  if (event.isComposing || event.keyCode === 229) return false;
  if (event.metaKey === event.ctrlKey || event.shiftKey || event.altKey) return false;
  return event.key.toLowerCase() === key;
}

/** The new-chat chord: mod+N. */
export function isNewChatShortcut(event: KeyboardEvent): boolean {
  return isModChord(event, 'n');
}

/**
 * The command-palette chord: mod+K.
 *
 * Deliberately the only chord the palette answers to. Firefox binds mod+K to
 * its own search bar and Safari to the sidebar, so the header affordance stays
 * the reliable path in the browsers that never deliver the event.
 */
export function isCommandPaletteShortcut(event: KeyboardEvent): boolean {
  return isModChord(event, 'k');
}
