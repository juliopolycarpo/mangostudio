/**
 * "Open a new terminal session" as a channel, for callers outside the terminal
 * panel's own component tree.
 *
 * The command palette pairs this with `requestRailPanel('terminal')`: the rail
 * hears that as a fire-and-forget event and may not be subscribed yet when this
 * fires in the same tick, so the channel latches — see
 * `workspace/rail/latched-request-channel` for the semantics.
 */

import { createLatchedRequestChannel } from '../workspace/rail/latched-request-channel';

const channel = createLatchedRequestChannel();

/**
 * Asks the mounted terminal panel to open a new session. Latched if no panel
 * is mounted yet.
 *
 * @example
 * requestRailPanel('terminal');
 * requestNewTerminalSession();
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
