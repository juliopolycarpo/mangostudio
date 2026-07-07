import { type Static, Type } from '@sinclair/typebox';

/** Per-user unique server identifier; becomes the tool namespace prefix. */
export const MCP_SERVER_SLUG_PATTERN = '^[a-z0-9]+(?:-[a-z0-9]+)*$';
export const MCP_SERVER_SLUG_MAX_LENGTH = 64;
export const MCP_SERVER_NAME_MAX_LENGTH = 100;

export const McpTransportSchema = Type.Union([Type.Literal('stdio'), Type.Literal('http')]);

/**
 * Last-known connection state of a server. Listing never forces a connect —
 * the test endpoint is the explicit probe.
 */
export const McpServerStatusSchema = Type.Union([
  Type.Literal('disconnected'),
  Type.Literal('connecting'),
  Type.Literal('connected'),
  Type.Literal('error'),
]);

/**
 * Public server row. Auth header values live in the secret store and never
 * appear in responses — only their names.
 */
export const McpServerSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  slug: Type.String({ minLength: 1 }),
  transport: McpTransportSchema,
  /** stdio transport: executable to spawn. */
  command: Type.Union([Type.String(), Type.Null()]),
  args: Type.Array(Type.String()),
  /** stdio transport: non-secret child environment variables. */
  env: Type.Record(Type.String(), Type.String()),
  /** http transport: Streamable HTTP endpoint. */
  url: Type.Union([Type.String(), Type.Null()]),
  /** Names of stored auth headers; values are write-only. */
  headerNames: Type.Array(Type.String()),
  enabled: Type.Boolean(),
  /** Per-request cap in milliseconds; null falls back to the built-in default. */
  timeoutMs: Type.Union([Type.Number(), Type.Null()]),
  status: McpServerStatusSchema,
  /** Failure detail when `status` is `error`. */
  statusError: Type.Optional(Type.String()),
  createdAt: Type.Number(),
  updatedAt: Type.Number(),
});

const addCommonFields = {
  name: Type.String({ minLength: 1, maxLength: MCP_SERVER_NAME_MAX_LENGTH }),
  slug: Type.String({
    minLength: 1,
    maxLength: MCP_SERVER_SLUG_MAX_LENGTH,
    pattern: MCP_SERVER_SLUG_PATTERN,
  }),
  enabled: Type.Optional(Type.Boolean()),
  timeoutMs: Type.Optional(Type.Union([Type.Number({ minimum: 1 }), Type.Null()])),
};

export const AddStdioMcpServerBodySchema = Type.Object({
  ...addCommonFields,
  transport: Type.Literal('stdio'),
  command: Type.String({ minLength: 1 }),
  args: Type.Optional(Type.Array(Type.String())),
  env: Type.Optional(Type.Record(Type.String(), Type.String())),
});

export const AddHttpMcpServerBodySchema = Type.Object({
  ...addCommonFields,
  transport: Type.Literal('http'),
  url: Type.String({ minLength: 1 }),
  /** Auth headers — accepted on write only, persisted to the secret store. */
  headers: Type.Optional(Type.Record(Type.String(), Type.String())),
});

export const AddMcpServerBodySchema = Type.Union([
  AddStdioMcpServerBodySchema,
  AddHttpMcpServerBodySchema,
]);

/**
 * Flat partial update body. Transport-specific invariants (stdio needs a
 * command, http needs an http(s) URL) are enforced against the merged row by
 * the API domain layer, so a partial body stays unambiguous to validate.
 */
export const UpdateMcpServerBodySchema = Type.Partial(
  Type.Object({
    name: Type.String({ minLength: 1, maxLength: MCP_SERVER_NAME_MAX_LENGTH }),
    slug: Type.String({
      minLength: 1,
      maxLength: MCP_SERVER_SLUG_MAX_LENGTH,
      pattern: MCP_SERVER_SLUG_PATTERN,
    }),
    transport: McpTransportSchema,
    command: Type.String({ minLength: 1 }),
    args: Type.Array(Type.String()),
    env: Type.Record(Type.String(), Type.String()),
    url: Type.String({ minLength: 1 }),
    /** Replaces the stored header bundle when present. */
    headers: Type.Record(Type.String(), Type.String()),
    enabled: Type.Boolean(),
    timeoutMs: Type.Union([Type.Number({ minimum: 1 }), Type.Null()]),
  })
);

export const McpToolDescriptorSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  description: Type.String(),
  /** JSON Schema published by the server, passed through untouched. */
  inputSchema: Type.Unknown(),
});

export const McpServerListResponseSchema = Type.Object({
  servers: Type.Array(McpServerSchema),
});

export const McpServerToolsResponseSchema = Type.Object({
  tools: Type.Array(McpToolDescriptorSchema),
});

export const TestMcpServerResponseSchema = Type.Object({
  ok: Type.Boolean(),
  status: McpServerStatusSchema,
  tools: Type.Optional(Type.Array(McpToolDescriptorSchema)),
  error: Type.Optional(Type.String()),
});

export const DeleteMcpServerResponseSchema = Type.Object({
  ok: Type.Boolean(),
});

export type McpTransport = Static<typeof McpTransportSchema>;
export type McpServerStatus = Static<typeof McpServerStatusSchema>;
export type McpServer = Static<typeof McpServerSchema>;
export type AddMcpServerBody = Static<typeof AddMcpServerBodySchema>;
export type UpdateMcpServerBody = Static<typeof UpdateMcpServerBodySchema>;
export type McpToolDescriptor = Static<typeof McpToolDescriptorSchema>;
export type McpServerListResponse = Static<typeof McpServerListResponseSchema>;
export type McpServerToolsResponse = Static<typeof McpServerToolsResponseSchema>;
export type TestMcpServerResponse = Static<typeof TestMcpServerResponseSchema>;
export type DeleteMcpServerResponse = Static<typeof DeleteMcpServerResponseSchema>;
