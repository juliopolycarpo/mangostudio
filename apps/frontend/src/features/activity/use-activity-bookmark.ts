import { useEffect, useRef, useState } from 'react';
import { authClient } from '@/lib/auth-client';
import { readActivityLastSeen, writeActivityLastSeen } from './last-seen';

/**
 * When this account last looked at the feed, read once and then moved forward.
 *
 * Frozen at the first render that knows who the user is: the bookmark advances
 * the moment the card mounts, so reading it live would collapse "3 new" to
 * "nothing new" while somebody was still looking at it. Anonymous or
 * still-loading sessions report `null`, which the callers read as "no bookmark
 * yet" rather than "everything is new".
 */
export function useActivityBookmark(): number | null {
  const { data: session } = authClient.useSession();
  const userId = session?.user?.id ?? null;
  const [lastSeenAt, setLastSeenAt] = useState<number | null>(null);
  const captured = useRef(false);

  useEffect(() => {
    if (userId === null || captured.current) return;
    captured.current = true;
    setLastSeenAt(readActivityLastSeen(userId));
    writeActivityLastSeen(userId, Date.now());
  }, [userId]);

  return lastSeenAt;
}
