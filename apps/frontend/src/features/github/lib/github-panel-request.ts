/**
 * "Open the create-pull-request form" as a channel, for callers outside the
 * GitHub panel's own component tree.
 *
 * The panel's active tab lives in `GithubRepoSection` and the create form's
 * open flag lives one level below it, in `PrsPane` — deliberately, so the
 * form unmounts (and its draft with it) when the tab is left. A caller like
 * the command palette that wants to land directly on an open form would
 * otherwise need a setter threaded through both, for no reason either
 * component would otherwise have to know about the other's caller. A
 * module-level channel avoids that, on the same reasoning as
 * `rail-panel-request` and `composer-draft-store`.
 *
 * Unlike those siblings, a request here is allowed to arrive before the
 * GitHub panel is mounted: the palette action pairs this with
 * `requestRailPanel('github')`, whose own state update hasn't committed yet
 * when this fires, so `GithubRepoSection` isn't subscribed until the next
 * render. A one-shot latch covers that gap — a request with no listener
 * mounted is held, and replayed to the first listener that subscribes, then
 * cleared. A request while a listener *is* already mounted is delivered
 * directly and never latched, so a later remount doesn't replay a stale one.
 */

const listeners = new Set<() => void>();
let pending = false;

/**
 * Asks the mounted GitHub panel to switch to the pull requests tab and open
 * the create-pull-request form. Latched if no panel is mounted yet.
 *
 * @example
 * requestRailPanel('github');
 * requestGithubCreatePr();
 */
export function requestGithubCreatePr(): void {
  if (listeners.size === 0) {
    pending = true;
    return;
  }
  for (const listener of listeners) listener();
}

/**
 * Subscribes to create-pull-request requests. Immediately replays a request
 * that latched before this call, consuming it.
 *
 * @example
 * useEffect(() => onGithubCreatePrRequest(openCreateForm), [openCreateForm]);
 */
export function onGithubCreatePrRequest(listener: () => void): () => void {
  listeners.add(listener);
  if (pending) {
    pending = false;
    listener();
  }
  return () => {
    listeners.delete(listener);
  };
}
