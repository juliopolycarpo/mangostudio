import { REALTIME_WRITER_ID_HEADER, type RealtimeWriterId } from '@mangostudio/shared/realtime';

/**
 * This tab's writer id: chosen once per page load and sent with every write
 * whose invalidation the tab wants to recognise as its own.
 *
 * It is generated here rather than issued by the hub at subscribe time because
 * a write can happen before the socket is acknowledged (or while it is down and
 * reconnecting), and a server-issued id would change under a write already in
 * flight. A tab-lifetime id is stable across reconnects, so an echo that
 * arrives on a new connection still compares equal.
 */
let tabWriterId: RealtimeWriterId | undefined;

/**
 * @example
 * const writerId = getTabWriterId(); // stable for this page load
 */
export function getTabWriterId(): RealtimeWriterId {
  tabWriterId ??= crypto.randomUUID();
  return tabWriterId;
}

/**
 * Header that names this tab as the writer of a request.
 * @example
 * client.api.settings.app.put(patch, { headers: { ...tabWriterHeaders() } });
 */
export function tabWriterHeaders(): Record<typeof REALTIME_WRITER_ID_HEADER, RealtimeWriterId> {
  return { [REALTIME_WRITER_ID_HEADER]: getTabWriterId() };
}

/** Whether an event's writer is this tab. An event with no writer is never ours. */
export function isOwnWriterId(writerId: string | undefined): boolean {
  return writerId !== undefined && writerId === getTabWriterId();
}
