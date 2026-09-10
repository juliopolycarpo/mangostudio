/**
 * What a runtime publishes while it is connected: the six topics, their
 * payloads, and the `events` half of the contract definition.
 *
 * Three of them are streams — one `streamId` per install run, terminal session
 * or vendor-agent session — so their sequence numbers are per stream and the
 * last frame carries `end`. The other three are single events.
 */

import Type, { type Static } from 'typebox';
import { ExternalAgentEventEnvelopeSchema } from '../external-agents/schemas';
import type { McpElicitationField } from '../mcp';
import { UnsafeObjectSchema } from '../schema-helpers';

/**
 * Topic a runtime publishes on while it is connected. It is a keep-alive with
 * a payload, not a metric: the hub uses it to record that a credential is in
 * use without writing on every protocol ping.
 */
export const RUNTIME_HEARTBEAT_TOPIC = 'runtime.heartbeat' as const;

export const RuntimeHeartbeatEventSchema = Type.Object({
  /** Milliseconds since the epoch, read on the runtime's own clock. */
  at: Type.Integer({ minimum: 0 }),
});
export type RuntimeHeartbeatEvent = Static<typeof RuntimeHeartbeatEventSchema>;

/** Topic carrying ordered, semantic vendor-agent events to the hub. */
export const RUNTIME_EXTERNAL_AGENT_TOPIC = 'external-agent.event' as const;
export type RuntimeExternalAgentEvent = Static<typeof ExternalAgentEventEnvelopeSchema>;

/** Topic carrying a server's mid-tool-call form request up to the hub. */
export const RUNTIME_MCP_ELICITATION_TOPIC = 'mcp.elicitation' as const;

/** Topic carrying out-of-band session state (drops, tool-list invalidations). */
export const RUNTIME_MCP_SESSION_TOPIC = 'mcp.session' as const;

export interface RuntimeMcpElicitationEvent {
  readonly requestId: string;
  readonly serverId: string;
  readonly serverSlug: string;
  readonly toolCallId: string;
  readonly message: string;
  readonly fields: readonly McpElicitationField[];
}

export interface RuntimeMcpSessionEvent {
  readonly serverId: string;
  /** `closed`: the session dropped. `tool-list-changed`: caches are stale. */
  readonly change: 'closed' | 'tool-list-changed';
}

/** Topic carrying one install run's output up to the hub, keyed by run id. */
export const RUNTIME_INSTALL_OUTPUT_TOPIC = 'install.output' as const;

export interface RuntimeInstallOutputEvent {
  readonly stream: 'stdout' | 'stderr' | 'system';
  readonly line: string;
  /** Marks the frame that closes the stream; its `line` is empty. */
  readonly end?: true;
}

/**
 * Topic carrying one terminal session's output up to the hub, keyed by
 * session id. Never emitted before the hub has called `terminal.attach` on
 * that session, so an older hub that cannot decode the payload never sees it.
 */
export const RUNTIME_TERMINAL_OUTPUT_TOPIC = 'terminal.output' as const;

/**
 * One frame on `terminal.output`. `data` is base64 because the event envelope
 * is JSON; at most `TERMINAL_CHUNK_MAX_BYTES` raw bytes per frame. `dropped`
 * is a marker for bytes discarded when the in-flight window and the pending
 * buffer were both full. `exit` rides the frame that ends the stream.
 */
export type RuntimeTerminalOutputEvent =
  | { readonly kind: 'data'; readonly data: string }
  | { readonly kind: 'dropped'; readonly bytes: number }
  | { readonly kind: 'exit'; readonly exitCode: number | null; readonly signal: string | null };

/** The `events` half of the runtime contract definition. */
export const RUNTIME_CONTRACT_EVENTS = {
  [RUNTIME_HEARTBEAT_TOPIC]: {
    payload: RuntimeHeartbeatEventSchema,
    description: 'Keep-alive with a payload; the hub records that a credential is in use.',
  },
  [RUNTIME_EXTERNAL_AGENT_TOPIC]: {
    payload: ExternalAgentEventEnvelopeSchema,
    stream: true,
    description: 'One ordered, semantic event of a hub-owned vendor-agent session.',
  },
  [RUNTIME_MCP_ELICITATION_TOPIC]: {
    payload: UnsafeObjectSchema<RuntimeMcpElicitationEvent>(),
    description: "A server's mid-tool-call form request.",
  },
  [RUNTIME_MCP_SESSION_TOPIC]: {
    payload: UnsafeObjectSchema<RuntimeMcpSessionEvent>(),
    description: 'Out-of-band MCP session state: drops and tool-list invalidations.',
  },
  [RUNTIME_INSTALL_OUTPUT_TOPIC]: {
    payload: UnsafeObjectSchema<RuntimeInstallOutputEvent>(),
    stream: true,
    description: "One line of an install run's output, keyed by run id.",
  },
  [RUNTIME_TERMINAL_OUTPUT_TOPIC]: {
    payload: UnsafeObjectSchema<RuntimeTerminalOutputEvent>(),
    stream: true,
    description: "One frame of a terminal session's output, keyed by session id.",
  },
} as const;
