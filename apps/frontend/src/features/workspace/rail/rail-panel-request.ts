/**
 * "Open that rail panel" as a channel, so surfaces outside the rail can point
 * at one.
 *
 * The rail's active panel is component state, and deliberately so — it is a
 * layout choice, not application data. But three callers need to *change* it
 * from outside: the command palette (the rail has no keyboard shortcut for
 * switching panels at all, so the palette is the accessible path), and the
 * Repository panel's branch chip, which is a deep link into the GitHub panel.
 *
 * A module-level channel rather than a prop chain, on the same reasoning as
 * `composer-draft-store`: threading a setter from `ChatPage` through the shell
 * into the rail moves a string sideways through four components that have no
 * other reason to know about it.
 *
 * The delivery rule, in full:
 *
 * - A request made while a rail is subscribed is delivered at once.
 * - A request made while none is subscribed is held for
 *   `RAIL_PANEL_REQUEST_WINDOW_MS` and delivered to the first rail that
 *   subscribes inside that window. The palette fires its request right after
 *   `await navigate()`, which resolves before the chat surface has committed
 *   the rail, so a strictly un-latched channel lost every request made from
 *   settings or the gallery.
 * - Past the window the request is dropped, never queued: a palette command
 *   run from settings must not silently arm a panel switch that fires
 *   whenever the user next opens a chat. At most one request is held; a newer
 *   one replaces it.
 *
 * A request that is dropped, expired, replaced by one for another panel, or
 * rejected by a rail that does not offer the panel is announced through
 * `onRailPanelRequestDropped`. Panel-specific latches paired with the request
 * (the GitHub create-pull-request form) listen to it and clear themselves, so
 * the panel never opens later than the rail would have, or at all.
 *
 * Ordering contract for a caller pairing a latch with a request: arm the latch
 * first, then call `requestRailPanel`. A rail that is already mounted answers
 * synchronously, so a rejection announced before the latch exists would clear
 * nothing and leave the latch armed afterwards.
 */

import type { WorkspacePanelId } from '@mangostudio/shared/workspaces';

type RailPanelListener = (panelId: WorkspacePanelId) => void;

/**
 * How long a request waits for a rail to subscribe.
 *
 * A safety margin, not a measured gap. Measured in Chromium against the built
 * app, running the palette's "Open GitHub panel" from `/settings`, both after
 * in-app navigation and after a full load of `/settings` (so the chat route's
 * chunk is fetched during the navigation), and again with 6x CPU throttling and
 * a 400 ms-latency, 200 kB/s link: the rail was already subscribed when the
 * request fired every time, because the router resolves `navigate()` after the
 * chat surface commits. The window exists for a commit that lands later than
 * that, say behind a suspended boundary, and 1 s is far past any frame
 * budget while staying well short of anything a user could mistake for "the
 * palette armed something for later".
 */
export const RAIL_PANEL_REQUEST_WINDOW_MS = 1000;

const listeners = new Set<RailPanelListener>();
const droppedListeners = new Set<RailPanelListener>();

interface HeldRequest {
  readonly panelId: WorkspacePanelId;
  readonly expiry: ReturnType<typeof setTimeout>;
}

let held: HeldRequest | null = null;

function notifyDropped(panelId: WorkspacePanelId): void {
  for (const listener of droppedListeners) listener(panelId);
}

/** Forgets the held request without announcing it; the caller decides whether it was dropped. */
function takeHeld(): WorkspacePanelId | null {
  if (!held) return null;
  clearTimeout(held.expiry);
  const { panelId } = held;
  held = null;
  return panelId;
}

/**
 * Asks the mounted rail to show a panel, or the next rail to subscribe within
 * `RAIL_PANEL_REQUEST_WINDOW_MS`.
 *
 * @example
 * requestRailPanel('github');
 */
export function requestRailPanel(panelId: WorkspacePanelId): void {
  // A newer request for the same panel supersedes the held one without
  // dropping it: the caller has already re-armed any paired latch, and clearing
  // it here would undo that.
  const replaced = takeHeld();
  if (replaced && replaced !== panelId) notifyDropped(replaced);

  if (listeners.size > 0) {
    for (const listener of listeners) listener(panelId);
    return;
  }

  held = {
    panelId,
    expiry: setTimeout(() => {
      held = null;
      notifyDropped(panelId);
    }, RAIL_PANEL_REQUEST_WINDOW_MS),
  };
}

/**
 * Subscribes the rail to panel requests, replaying a request still inside its
 * window once.
 *
 * @example
 * useEffect(() => onRailPanelRequest(selectPanel), [selectPanel]);
 */
export function onRailPanelRequest(listener: RailPanelListener): () => void {
  listeners.add(listener);
  const replay = takeHeld();
  if (replay) listener(replay);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Called by a rail that received a request it cannot honour, because the panel
 * is hidden or not available for its chat. Announced like any other drop, so a
 * paired latch clears instead of waiting for some later chat to show the panel.
 *
 * @example
 * if (!offers(panelId)) rejectRailPanelRequest(panelId);
 */
export function rejectRailPanelRequest(panelId: WorkspacePanelId): void {
  notifyDropped(panelId);
}

/**
 * Subscribes to requests the channel gave up on: expired with no rail,
 * replaced by a request for another panel, or rejected by the rail. Used by the
 * latches that ride along with a rail request to clear themselves.
 *
 * @example
 * onRailPanelRequestDropped((panelId) => {
 *   if (panelId === 'github') channel.clear();
 * });
 */
export function onRailPanelRequestDropped(listener: RailPanelListener): () => void {
  droppedListeners.add(listener);
  return () => {
    droppedListeners.delete(listener);
  };
}
