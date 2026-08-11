/**
 * What the ACP handshake has to contain, and what it may merely happen to
 * contain.
 *
 * `cursor-agent acp` is the subcommand `cursor-agent --help` does not list, so
 * the handshake is the only thing that establishes it still behaves the way
 * this adapter assumes. `adapter.ts` already refuses a `protocolVersion` other
 * than 1; this module covers the rest of the reply, and it is deliberately
 * asymmetric:
 *
 * - A **missing required** key means the reply is not describing a protocol-1
 *   ACP agent at all. The target becomes unavailable.
 * - A **missing optional** key means a capability this client can live without
 *   was not offered. The matching flag stays false, which is what
 *   `capabilitiesFrom` already does, and nothing is refused.
 * - An **unknown** key means Cursor shipped something new. It is logged once
 *   and otherwise ignored.
 *
 * Getting that direction backwards is the failure worth naming: treating an
 * unrecognized key as drift would take the feature down on every Cursor
 * release, and Cursor releases constantly. Only absence can be a refusal,
 * because only absence removes something this client reads.
 */

import type { AcpInitializeResponse } from './protocol';

/**
 * Keys without which the reply is not a protocol-1 ACP handshake.
 *
 * Two, and no more. `protocolVersion` is the negotiated contract and
 * `agentCapabilities` is the object every capability is read from — an agent
 * that omits it has described nothing, which is different from one that
 * described a capability as absent. Everything else Cursor sends is either
 * optional by the specification or informational.
 */
export const CURSOR_REQUIRED_HANDSHAKE_KEYS: readonly string[] = [
  'protocolVersion',
  'agentCapabilities',
];

/**
 * Agent capability keys observed on the pinned build.
 *
 * The list exists to make "Cursor added something" visible, not to require any
 * of it. `loadSession`, `promptCapabilities` and `sessionCapabilities` each map
 * onto one optional flag; `mcpCapabilities` maps onto none and is listed only
 * so it is not reported as new on every single handshake.
 */
export const CURSOR_KNOWN_AGENT_CAPABILITY_KEYS: readonly string[] = [
  'loadSession',
  'mcpCapabilities',
  'promptCapabilities',
  'sessionCapabilities',
];

export interface CursorHandshakeAudit {
  /** Required keys the reply did not carry. Non-empty means unavailable. */
  readonly missing: readonly string[];
  /** Agent capability keys this build has not seen before. Informational. */
  readonly unrecognized: readonly string[];
}

/** Compares one `initialize` reply against what this client reads off it. */
export function auditCursorHandshake(initialize: AcpInitializeResponse): CursorHandshakeAudit {
  const reply = initialize as Record<string, unknown>;
  const missing = CURSOR_REQUIRED_HANDSHAKE_KEYS.filter(
    (key) => reply[key] === undefined || reply[key] === null
  );
  const capabilities = initialize.agentCapabilities;
  const unrecognized =
    capabilities && typeof capabilities === 'object'
      ? Object.keys(capabilities)
          .filter((key) => !CURSOR_KNOWN_AGENT_CAPABILITY_KEYS.includes(key))
          .sort()
      : [];
  return { missing, unrecognized };
}
