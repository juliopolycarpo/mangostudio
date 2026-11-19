/**
 * What `runtime.health` says about one external session, in the hub's own words.
 *
 * `idle` and `running` are the runtime's `LiveSessionHealth` states, where `running` means the
 * session has a turn in flight. `closing` is a session on its way out, whose teardown reaches the
 * hub on its own. `unlisted` is a session the health report does not name: the report caps its rows
 * (`RUNTIME_HEALTH_LIVE_SESSION_LIMIT`), so absence from a full list proves nothing. `unknown` is
 * a state string this hub has no meaning for, from a newer runtime.
 *
 * Only `idle` is evidence that a turn is over. Every other state must leave the turn running.
 */
export type ExternalRuntimeSessionState = 'idle' | 'running' | 'closing' | 'unlisted' | 'unknown';

/** The part of the `runtime.health` report this reads. */
export interface ExternalAgentHealthRows {
  readonly liveSessions: readonly { readonly sessionId: string; readonly state: string }[];
}

/**
 * Reads one session's state out of a health report's `externalAgents` subtree.
 *
 * @example
 * runtimeSessionStateOf({ liveSessions: [{ sessionId: 's1', state: 'idle' }] }, 's1'); // 'idle'
 */
export function runtimeSessionStateOf(
  externalAgents: ExternalAgentHealthRows | undefined,
  sessionId: string
): ExternalRuntimeSessionState {
  const row = externalAgents?.liveSessions.find((candidate) => candidate.sessionId === sessionId);
  if (!row) return 'unlisted';
  switch (row.state) {
    case 'idle':
    case 'running':
    case 'closing':
      return row.state;
    default:
      return 'unknown';
  }
}
