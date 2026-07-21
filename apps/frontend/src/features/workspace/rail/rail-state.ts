const COLLAPSED_STORAGE_PREFIX = 'mangostudio:workspace-rail-collapsed:';

export function railCollapsedStorageKey(chatId: string): string {
  return `${COLLAPSED_STORAGE_PREFIX}${chatId}`;
}

export function readRailCollapsed(chatId: string): boolean {
  try {
    return window.localStorage.getItem(railCollapsedStorageKey(chatId)) === 'true';
  } catch {
    return false;
  }
}

export function writeRailCollapsed(chatId: string, collapsed: boolean): void {
  try {
    if (collapsed) {
      window.localStorage.setItem(railCollapsedStorageKey(chatId), 'true');
    } else {
      window.localStorage.removeItem(railCollapsedStorageKey(chatId));
    }
  } catch {
    // Per-chat layout state is best-effort when storage is unavailable.
  }
}
