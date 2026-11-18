/**
 * Ask the running hub to shut down over loopback, presenting the control token from the state
 * file (see `lib/hub-control.ts`). The caller waits for the pid to exit; an accepted request only
 * means the hub has begun its graceful stop.
 */

import { HUB_CONTROL_TOKEN_HEADER, HUB_SHUTDOWN_PATH } from '../lib/hub-control';
import type { ServerState } from '../lib/server-state';
import { resolveLocalTarget } from './health';

const REQUEST_TIMEOUT_MS = 2000;

/** `reason` names why the hub was not asked, or why it declined, for the line the CLI prints. */
export type HubShutdownAnswer = { accepted: true } | { accepted: false; reason: string };

export type HubShutdownRequester = (state: ServerState) => Promise<HubShutdownAnswer>;

export interface HubShutdownRequestDeps {
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

/**
 * POST the shutdown request. Never throws: any failure is a refusal with a reason, so the caller
 * can fall back to ending the process.
 *
 * Refuses without dialling when the state file carries no token (a hub from before this
 * existed) or names a host that is not loopback-reachable. The token is sent to nothing else.
 * // Usage: await requestHubShutdown(state) // → { accepted: true }
 */
export async function requestHubShutdown(
  state: ServerState,
  deps: HubShutdownRequestDeps = {}
): Promise<HubShutdownAnswer> {
  if (!state.controlToken) {
    return { accepted: false, reason: 'this hub did not record a control token' };
  }
  // The host comes from a local file; only dial an address that is this machine.
  const target = resolveLocalTarget(state.host);
  if (target === null) {
    return { accepted: false, reason: `the hub listens on ${state.host}, not on loopback` };
  }
  try {
    const response = await (deps.fetch ?? fetch)(
      `http://${target}:${state.port}${HUB_SHUTDOWN_PATH}`,
      {
        method: 'POST',
        headers: { [HUB_CONTROL_TOKEN_HEADER]: state.controlToken },
        signal: AbortSignal.timeout(deps.timeoutMs ?? REQUEST_TIMEOUT_MS),
      }
    );
    if (response.status === 202) return { accepted: true };
    return { accepted: false, reason: `the hub answered HTTP ${response.status}` };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { accepted: false, reason: `the hub could not be reached (${detail})` };
  }
}
