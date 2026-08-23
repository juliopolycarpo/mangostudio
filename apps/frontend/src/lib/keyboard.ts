/** `⌘N` on Apple platforms, `Ctrl+N` elsewhere. Display only — both are bound. */
export function newChatShortcutHint(): string {
  const platform = typeof navigator === 'undefined' ? '' : navigator.platform;
  return /Mac|iPhone|iPad|iPod/.test(platform) ? '⌘N' : 'Ctrl+N';
}

/**
 * True when a keydown is the new-chat chord: mod+N with no other modifier.
 *
 * An IME composition session is not a chord: while composing, `event.key` is
 * whatever the IME is feeding back and the keystroke belongs to the editor, not
 * to the shell. Editable targets are deliberately *not* excluded — the composer
 * is where the user already is, and a "new chat" shortcut that dies there is a
 * shortcut nobody can reach.
 */
export function isNewChatShortcut(event: KeyboardEvent): boolean {
  if (event.isComposing || event.keyCode === 229) return false;
  if (event.metaKey === event.ctrlKey || event.shiftKey || event.altKey) return false;
  return event.key === 'n' || event.key === 'N';
}
