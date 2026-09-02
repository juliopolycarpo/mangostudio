/**
 * "Open a new terminal session" as a channel, for callers outside the
 * terminal panel's own component tree — mirrors
 * `features/github/lib/github-panel-request.ts`'s `requestGithubCreatePr`.
 *
 * The command palette pairs this with `requestRailPanel('terminal')`: the
 * rail hears that as a fire-and-forget event and may not be subscribed yet
 * when this fires in the same tick, so a request with no listener mounted is
 * latched and replayed to the first one that subscribes.
 */

const listeners = new Set<() => void>();
let pending = false;

/**
 * Asks the mounted terminal panel to open a new session. Latched if no panel
 * is mounted yet.
 *
 * @example
 * requestRailPanel('terminal');
 * requestNewTerminalSession();
 */
export function requestNewTerminalSession(): void {
  if (listeners.size === 0) {
    pending = true;
    return;
  }
  for (const listener of listeners) listener();
}

/**
 * Subscribes to new-session requests. Immediately replays one that latched
 * before this call, consuming it.
 *
 * @example
 * useEffect(() => onNewTerminalSessionRequest(openSession), [openSession]);
 */
export function onNewTerminalSessionRequest(listener: () => void): () => void {
  listeners.add(listener);
  if (pending) {
    pending = false;
    listener();
  }
  return () => {
    listeners.delete(listener);
  };
}
