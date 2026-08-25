const ACTIVITY_LAST_SEEN_KEY = 'mangostudio:activity-last-seen';

/**
 * Caps how many accounts one browser profile remembers a last-visit time for.
 *
 * The record is keyed by user id so a shared machine with several signed-in
 * accounts does not show one person's "since last visit" divider to another,
 * but nothing here ever removes a stale entry on its own — this bound is what
 * keeps a browser profile that saw many accounts from growing the value
 * without limit.
 */
const MAX_TRACKED_USERS = 20;

type LastSeenRecord = Record<string, number>;

function readRecord(): LastSeenRecord {
  try {
    const raw = window.localStorage.getItem(ACTIVITY_LAST_SEEN_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const entries = Object.entries(parsed as Record<string, unknown>).filter(
      (entry): entry is [string, number] => typeof entry[1] === 'number'
    );
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

/** Per-user "what changed since I last looked" bookmark. Epoch milliseconds. */
export function readActivityLastSeen(userId: string): number | null {
  const record = readRecord();
  return record[userId] ?? null;
}

export function writeActivityLastSeen(userId: string, atMs: number): void {
  try {
    const record = readRecord();
    record[userId] = atMs;

    const userIds = Object.keys(record);
    if (userIds.length > MAX_TRACKED_USERS) {
      // Drops the oldest bookmarks first, keeping this user's write and the
      // most recently active accounts on this machine.
      const oldestFirst = userIds
        .filter((id) => id !== userId)
        .sort((a, b) => record[a] - record[b]);
      const overflow = oldestFirst.slice(0, userIds.length - MAX_TRACKED_USERS);
      for (const id of overflow) delete record[id];
    }

    window.localStorage.setItem(ACTIVITY_LAST_SEEN_KEY, JSON.stringify(record));
  } catch {
    // Best-effort when storage is unavailable; the divider simply does not
    // move, which is no worse than a browser that never had it.
  }
}
