/**
 * "Open a new terminal session" as a channel, for callers outside the terminal
 * panel's own component tree.
 *
 * The command palette pairs this with `requestRailPanel('terminal')`: the rail
 * hears that as a fire-and-forget event and may not be subscribed yet when this
 * fires in the same tick, so the channel latches — see
 * `workspace/rail/latched-request-channel` for the semantics. Like the GitHub
 * create-pull-request latch, it is cleared when the paired rail request is
 * dropped, so a session is never opened later than the panel would have been.
 */

import { createLatchedRequestChannel } from '../workspace/rail/latched-request-channel';
import { onRailPanelRequestDropped } from '../workspace/rail/rail-panel-request';

const channel = createLatchedRequestChannel();

const stopClearingOnDrop = onRailPanelRequestDropped((panelId) => {
  if (panelId === 'terminal') channel.clear();
});

// Unsubscribed on a hot reload so the old copy stops clearing a dead channel.
import.meta.hot?.dispose(stopClearingOnDrop);

/**
 * Asks the mounted terminal panel to open a new session. Latched if no panel
 * is mounted yet. Call it before `requestRailPanel('terminal')`, so a rail that
 * rejects the panel finds a latch to clear.
 *
 * @example
 * requestNewTerminalSession();
 * requestRailPanel('terminal');
 */
export const requestNewTerminalSession = channel.request;

/**
 * Subscribes to new-session requests. Immediately replays one that latched
 * before this call, consuming it.
 *
 * @example
 * useEffect(() => onNewTerminalSessionRequest(openSession), [openSession]);
 */
export const onNewTerminalSessionRequest = channel.subscribe;
