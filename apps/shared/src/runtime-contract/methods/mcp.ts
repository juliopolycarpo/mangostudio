/**
 * The MCP family: connecting to a server, calling its tools, reading its
 * resources and prompts, answering a mid-call elicitation, and the two
 * out-of-band events a session can raise.
 *
 * Schema-first, like the families that import it — the schema is the source
 * and the type is `Static<>` of it.
 */

import Type, { type Static } from 'typebox';
import {
  McpElicitationActionSchema,
  McpElicitationFieldSchema,
  McpPromptDescriptorSchema,
  McpResourceDescriptorSchema,
  McpToolDescriptorSchema,
  McpTransportSchema,
} from '../../mcp/schemas';
import { ReadonlyArraySchema, ReadonlyRecordSchema } from '../../schema-helpers';
import { type RuntimeAckResult, RuntimeAckResultSchema } from './common';

/**
 * Connection config for one MCP server, derived hub-side from its row. Secrets
 * travel separately in {@link RuntimeMcpSecretsSchema} so nothing here is
 * sensitive — this half is what may be logged, echoed, or persisted for
 * diagnostics.
 */
export const RuntimeMcpServerConfigSchema = Type.Object({
  id: Type.String(),
  slug: Type.String(),
  transport: McpTransportSchema,
  command: Type.Union([Type.String(), Type.Null()]),
  args: ReadonlyArraySchema(Type.String()),
  env: ReadonlyRecordSchema(Type.String()),
  url: Type.Union([Type.String(), Type.Null()]),
  timeoutMs: Type.Union([Type.Number(), Type.Null()]),
});
export type RuntimeMcpServerConfig = Static<typeof RuntimeMcpServerConfigSchema>;

/**
 * Credentials the hub's secret store holds for a server, delivered on connect
 * and kept in memory by the session for as long as it lives. The runtime never
 * writes them anywhere: not to disk, not to a log line, not to an audit record.
 */
export const RuntimeMcpSecretsSchema = Type.Object({
  /** stdio: secret child environment variables, merged over the row's `env`. */
  env: Type.Optional(ReadonlyRecordSchema(Type.String())),
  /** http: auth headers sent with every request on the session. */
  headers: Type.Optional(ReadonlyRecordSchema(Type.String())),
});
export type RuntimeMcpSecrets = Static<typeof RuntimeMcpSecretsSchema>;

/** Feature areas a server advertised during the MCP initialize handshake. */
export const RuntimeMcpServerCapabilitiesSchema = Type.Object({
  tools: Type.Boolean(),
  resources: Type.Boolean(),
  prompts: Type.Boolean(),
});
export type RuntimeMcpServerCapabilities = Static<typeof RuntimeMcpServerCapabilitiesSchema>;

/**
 * Structural, SDK-free view of one tool-result content block. `image`/`audio`
 * data and `resource` blobs stay base64-encoded exactly as the server returned
 * them; consumers decide what to persist or inline.
 */
export const RuntimeMcpContentBlockSchema = Type.Union([
  Type.Object({
    type: Type.Literal('text'),
    text: Type.String(),
    truncated: Type.Optional(Type.Literal(true)),
  }),
  Type.Object({
    type: Type.Literal('image'),
    data: Type.String(),
    mimeType: Type.String(),
  }),
  Type.Object({
    type: Type.Literal('audio'),
    data: Type.String(),
    mimeType: Type.String(),
  }),
  Type.Object({
    type: Type.Literal('resource'),
    uri: Type.String(),
    mimeType: Type.Optional(Type.String()),
    text: Type.Optional(Type.String()),
    /** Set when {@link text} was shortened to fit the runtime frame cap. */
    textTruncated: Type.Optional(Type.Literal(true)),
    blob: Type.Optional(Type.String()),
  }),
  Type.Object({
    type: Type.Literal('unknown'),
    blockType: Type.String(),
    mimeType: Type.Optional(Type.String()),
  }),
]);
export type RuntimeMcpContentBlock = Static<typeof RuntimeMcpContentBlockSchema>;

/** Tool call outcome: flattened text for the model plus the structured blocks. */
export const RuntimeMcpCallResultSchema = Type.Object({
  /** Text and text-resource blocks joined with blank lines, capped. */
  contentText: Type.String(),
  isError: Type.Boolean(),
  /** Content block types the server returned (`text`, `image`, `resource`, …). */
  rawContentKinds: ReadonlyArraySchema(Type.String()),
  content: ReadonlyArraySchema(RuntimeMcpContentBlockSchema),
});
export type RuntimeMcpCallResult = Static<typeof RuntimeMcpCallResultSchema>;

/** One `resources/read` content entry; binary payloads stay base64 in `blob`. */
export const RuntimeMcpResourceContentsSchema = Type.Object({
  uri: Type.String(),
  mimeType: Type.Optional(Type.String()),
  text: Type.Optional(Type.String()),
  blob: Type.Optional(Type.String()),
});
export type RuntimeMcpResourceContents = Static<typeof RuntimeMcpResourceContentsSchema>;

/** A resolved prompt, with each message's content flattened to plain text. */
export const RuntimeMcpPromptResultSchema = Type.Object({
  description: Type.Optional(Type.String()),
  messages: ReadonlyArraySchema(
    Type.Object({
      role: Type.Union([Type.Literal('user'), Type.Literal('assistant')]),
      text: Type.String(),
    })
  ),
});
export type RuntimeMcpPromptResult = Static<typeof RuntimeMcpPromptResultSchema>;

export const RuntimeMcpConnectParamsSchema = Type.Object({
  config: RuntimeMcpServerConfigSchema,
  secrets: Type.Optional(RuntimeMcpSecretsSchema),
});
export type RuntimeMcpConnectParams = Static<typeof RuntimeMcpConnectParamsSchema>;

export const RuntimeMcpConnectResultSchema = Type.Object({
  capabilities: RuntimeMcpServerCapabilitiesSchema,
});
export type RuntimeMcpConnectResult = Static<typeof RuntimeMcpConnectResultSchema>;

export const RuntimeMcpServerParamsSchema = Type.Object({
  serverId: Type.String(),
});
export type RuntimeMcpServerParams = Static<typeof RuntimeMcpServerParamsSchema>;

export const RuntimeMcpListToolsResultSchema = Type.Object({
  tools: ReadonlyArraySchema(McpToolDescriptorSchema),
});
export type RuntimeMcpListToolsResult = Static<typeof RuntimeMcpListToolsResultSchema>;

export const RuntimeMcpCallToolParamsSchema = Type.Interface([RuntimeMcpServerParamsSchema], {
  toolName: Type.String(),
  args: ReadonlyRecordSchema(Type.Unknown()),
  /**
   * Hub-minted correlation id for the call. Elicitation events echo it back so
   * the hub can route a server's mid-call question to the tool call that
   * caused it — the key is part of this method's contract, not a detail.
   */
  toolCallId: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Number()),
});
export type RuntimeMcpCallToolParams = Static<typeof RuntimeMcpCallToolParamsSchema>;

export const RuntimeMcpListResourcesResultSchema = Type.Object({
  resources: ReadonlyArraySchema(McpResourceDescriptorSchema),
});
export type RuntimeMcpListResourcesResult = Static<typeof RuntimeMcpListResourcesResultSchema>;

export const RuntimeMcpReadResourceParamsSchema = Type.Interface([RuntimeMcpServerParamsSchema], {
  uri: Type.String(),
});
export type RuntimeMcpReadResourceParams = Static<typeof RuntimeMcpReadResourceParamsSchema>;

export const RuntimeMcpReadResourceResultSchema = Type.Object({
  contents: ReadonlyArraySchema(RuntimeMcpResourceContentsSchema),
});
export type RuntimeMcpReadResourceResult = Static<typeof RuntimeMcpReadResourceResultSchema>;

export const RuntimeMcpListPromptsResultSchema = Type.Object({
  prompts: ReadonlyArraySchema(McpPromptDescriptorSchema),
});
export type RuntimeMcpListPromptsResult = Static<typeof RuntimeMcpListPromptsResultSchema>;

export const RuntimeMcpGetPromptParamsSchema = Type.Interface([RuntimeMcpServerParamsSchema], {
  promptName: Type.String(),
  args: Type.Optional(ReadonlyRecordSchema(Type.String())),
});
export type RuntimeMcpGetPromptParams = Static<typeof RuntimeMcpGetPromptParamsSchema>;

/** The hub's answer to one `mcp.elicitation` event, keyed by its request id. */
export const RuntimeMcpElicitResponseParamsSchema = Type.Object({
  requestId: Type.String(),
  action: McpElicitationActionSchema,
  content: Type.Optional(
    ReadonlyRecordSchema(
      Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Array(Type.String())])
    )
  ),
});
export type RuntimeMcpElicitResponseParams = Static<typeof RuntimeMcpElicitResponseParamsSchema>;

/** The family's own name for {@link RuntimeAckResultSchema}; one shape, not two. */
export const RuntimeMcpAckResultSchema = RuntimeAckResultSchema;
export type RuntimeMcpAckResult = RuntimeAckResult;

/** Topic payload: a server's mid-tool-call form request. */
export const RuntimeMcpElicitationEventSchema = Type.Object({
  requestId: Type.String(),
  serverId: Type.String(),
  serverSlug: Type.String(),
  toolCallId: Type.String(),
  message: Type.String(),
  fields: ReadonlyArraySchema(McpElicitationFieldSchema),
});
export type RuntimeMcpElicitationEvent = Static<typeof RuntimeMcpElicitationEventSchema>;

/** Topic payload: out-of-band MCP session state — drops and tool-list invalidations. */
export const RuntimeMcpSessionEventSchema = Type.Object({
  serverId: Type.String(),
  /** `closed`: the session dropped. `tool-list-changed`: caches are stale. */
  change: Type.Union([Type.Literal('closed'), Type.Literal('tool-list-changed')]),
});
export type RuntimeMcpSessionEvent = Static<typeof RuntimeMcpSessionEventSchema>;
