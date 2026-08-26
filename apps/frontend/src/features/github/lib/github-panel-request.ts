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
 * Fire-and-forget, like the sibling channels: a request while no GitHub panel
 * is mounted is dropped, not queued.
 */

const listeners = new Set<() => void>();

/**
 * Asks the mounted GitHub panel to switch to the pull requests tab and open
 * the create-pull-request form.
 *
 * @example
 * requestRailPanel('github');
 * requestGithubCreatePr();
 */
export function requestGithubCreatePr(): void {
  for (const listener of listeners) listener();
}

/**
 * Subscribes to create-pull-request requests.
 *
 * @example
 * useEffect(() => onGithubCreatePrRequest(openCreateForm), [openCreateForm]);
 */
export function onGithubCreatePrRequest(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
