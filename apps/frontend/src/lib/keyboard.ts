/** `⌘N` on Apple platforms, `Ctrl+N` elsewhere. Display only — both are bound. */
export function newChatShortcutHint(): string {
  const platform = typeof navigator === 'undefined' ? '' : navigator.platform;
  return /Mac|iPhone|iPad|iPod/.test(platform) ? '⌘N' : 'Ctrl+N';
}

/** True when a keydown is the new-chat chord: mod+N with no other modifier. */
export function isNewChatShortcut(event: KeyboardEvent): boolean {
  if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return false;
  return event.key === 'n' || event.key === 'N';
}
