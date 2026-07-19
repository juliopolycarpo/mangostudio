import { type Static, Type } from '@sinclair/typebox';
import { ChatAttachmentSchema } from '../chat/schemas';

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
  /** Names of stored stdio environment secrets; values are write-only. */
  secretEnvNames: Type.Array(Type.String()),
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
  /** Secret child environment variables — accepted on write only. */
  secretEnv: Type.Optional(Type.Record(Type.String(), Type.String())),
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
    /** Replaces the stored stdio secret environment bundle when present. */
    secretEnv: Type.Record(Type.String(), Type.String()),
    url: Type.String({ minLength: 1 }),
    /** Replaces the stored header bundle when present. */
    headers: Type.Record(Type.String(), Type.String()),
    enabled: Type.Boolean(),
    timeoutMs: Type.Union([Type.Number({ minimum: 1 }), Type.Null()]),
  })
);

/** Ceiling on an import source, whether read from disk or pasted as JSON. */
export const MCP_IMPORT_MAX_SOURCE_BYTES = 1024 * 1024;

const importSourceFields = {
  /** Absolute or `~`-prefixed path to a `.json` file on the API host. */
  path: Type.Optional(Type.String({ minLength: 1 })),
  /** Raw JSON text pasted by the user. */
  json: Type.Optional(Type.String({ minLength: 1, maxLength: MCP_IMPORT_MAX_SOURCE_BYTES })),
};

/** Exactly one of `path` / `json` must be present; the API enforces it. */
export const PreviewMcpImportBodySchema = Type.Object(importSourceFields);

export const ImportMcpServersBodySchema = Type.Object({
  ...importSourceFields,
  /** Slugs picked from the preview; entries outside this list are ignored. */
  slugs: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
});

export const McpImportActionSchema = Type.Union([
  Type.Literal('create'),
  Type.Literal('skip-duplicate'),
  Type.Literal('unsupported'),
]);

/**
 * Machine-readable cause for a non-`create` action, so the frontend can
 * localize it. `detail` optionally carries the offending raw value.
 */
export const McpImportReasonSchema = Type.Union([
  Type.Literal('duplicate-slug'),
  Type.Literal('duplicate-in-source'),
  Type.Literal('unsupported-transport'),
  Type.Literal('placeholder-value'),
  Type.Literal('invalid-entry'),
  Type.Literal('invalid-slug'),
]);

/**
 * One entry of the `mcpServers` map as it would be imported. Auth header
 * values never leave the API — only their names are echoed.
 */
export const McpImportPreviewEntrySchema = Type.Object({
  /** Original key in the source map. */
  key: Type.String(),
  /** Normalized slug the server would be created under; empty when underivable. */
  slug: Type.String(),
  name: Type.String(),
  transport: Type.Optional(McpTransportSchema),
  command: Type.Optional(Type.String()),
  url: Type.Optional(Type.String()),
  headerNames: Type.Array(Type.String()),
  action: McpImportActionSchema,
  reason: Type.Optional(McpImportReasonSchema),
  detail: Type.Optional(Type.String()),
});

export const McpImportPreviewResponseSchema = Type.Object({
  entries: Type.Array(McpImportPreviewEntrySchema),
});

export const McpImportResultEntrySchema = Type.Object({
  slug: Type.String(),
  result: Type.Union([
    Type.Literal('created'),
    Type.Literal('skip-duplicate'),
    Type.Literal('unsupported'),
  ]),
  reason: Type.Optional(McpImportReasonSchema),
  /** Row id when `result` is `created`. */
  serverId: Type.Optional(Type.String()),
});

export const ImportMcpServersResponseSchema = Type.Object({
  results: Type.Array(McpImportResultEntrySchema),
});

/** Portable, secret-free stdio configuration in the ecosystem `mcpServers` shape. */
export const McpPortableStdioServerSchema = Type.Object({
  type: Type.Literal('stdio'),
  command: Type.String({ minLength: 1 }),
  args: Type.Optional(Type.Array(Type.String())),
  env: Type.Optional(Type.Record(Type.String(), Type.String())),
});

/** Portable, secret-free Streamable HTTP configuration. */
export const McpPortableHttpServerSchema = Type.Object({
  type: Type.Literal('http'),
  url: Type.String({ minLength: 1 }),
});

export const McpPortableServerSchema = Type.Union([
  McpPortableStdioServerSchema,
  McpPortableHttpServerSchema,
]);

const McpPortableSecretNameSchema = Type.String({ minLength: 1 });

/** MangoStudio-only metadata that remains safe to serialize. */
export const McpPortableServerMetadataSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: MCP_SERVER_NAME_MAX_LENGTH }),
  enabled: Type.Boolean(),
  timeoutMs: Type.Union([Type.Number({ minimum: 1 }), Type.Null()]),
  /** Unresolved write-only secret names. Values are never portable. */
  secretEnvNames: Type.Array(McpPortableSecretNameSchema, { uniqueItems: true }),
  headerNames: Type.Array(McpPortableSecretNameSchema, { uniqueItems: true }),
});

export const McpPortableDocumentSchema = Type.Object({
  version: Type.Literal(1),
  mcpServers: Type.Record(Type.String(), McpPortableServerSchema),
  'x-mangostudio': Type.Optional(
    Type.Object({
      servers: Type.Record(Type.String(), McpPortableServerMetadataSchema),
    })
  ),
});

/** Export all owned servers or an explicit non-empty subset. */
export const ExportMcpServersBodySchema = Type.Union([
  Type.Object({ all: Type.Literal(true) }),
  Type.Object({
    serverIds: Type.Array(Type.String({ minLength: 1 }), {
      minItems: 1,
      uniqueItems: true,
    }),
  }),
]);

export const ExportMcpServersResponseSchema = Type.Object({
  filename: Type.String({ minLength: 1 }),
  content: Type.String({ minLength: 1 }),
  serverCount: Type.Number({ minimum: 1 }),
});

/** SHA-256 over normalized, secret-free configuration. */
export const McpNormalizedFingerprintSchema = Type.String({
  pattern: '^[a-f0-9]{64}$',
});

export const McpPortabilityConflictKeySchema = Type.Union([
  Type.Literal('fingerprint'),
  Type.Literal('slug'),
  Type.Literal('name'),
  Type.Literal('url'),
  Type.Literal('command-args'),
]);

export const McpPortabilityDecisionSchema = Type.Union([
  Type.Literal('add'),
  Type.Literal('skip'),
  Type.Literal('replace'),
  Type.Literal('copy'),
]);

export const McpPortabilitySecretReferenceSchema = Type.Object({
  kind: Type.Union([Type.Literal('env'), Type.Literal('header')]),
  name: Type.String({ minLength: 1 }),
  source: Type.Union([Type.Literal('literal'), Type.Literal('reference')]),
  /** Reference-only values must be supplied by the destination before apply. */
  required: Type.Boolean(),
});

export const McpPortabilityConflictCandidateSchema = Type.Object({
  serverId: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  slug: Type.String({ minLength: 1 }),
  keys: Type.Array(McpPortabilityConflictKeySchema, { minItems: 1 }),
  exact: Type.Boolean(),
  replaceBlockedBySlug: Type.Optional(
    Type.Object({
      slug: Type.String({ minLength: 1 }),
      holderName: Type.String({ minLength: 1 }),
    })
  ),
});

export const McpPortabilityInvalidReasonSchema = Type.Union([
  Type.Literal('unsupported-transport'),
  Type.Literal('placeholder-value'),
  Type.Literal('invalid-entry'),
  Type.Literal('invalid-slug'),
  Type.Literal('duplicate-in-source'),
]);

/** Secret-free plan entry produced before any mutation. */
export const McpPortabilityPreviewEntrySchema = Type.Object({
  key: Type.String(),
  name: Type.String(),
  slug: Type.String(),
  transport: Type.Optional(McpTransportSchema),
  command: Type.Optional(Type.String()),
  url: Type.Optional(Type.String()),
  fingerprint: Type.Optional(McpNormalizedFingerprintSchema),
  status: Type.Union([Type.Literal('ready'), Type.Literal('invalid')]),
  reason: Type.Optional(McpPortabilityInvalidReasonSchema),
  conflicts: Type.Array(McpPortabilityConflictCandidateSchema),
  allowedDecisions: Type.Array(McpPortabilityDecisionSchema, { minItems: 1 }),
  suggestedDecision: McpPortabilityDecisionSchema,
  copyName: Type.Optional(Type.String()),
  copySlug: Type.Optional(Type.String()),
  secretReferences: Type.Array(McpPortabilitySecretReferenceSchema),
});

export const PreviewMcpPortabilityImportBodySchema = Type.Object(importSourceFields);

export const McpPortabilityPreviewResponseSchema = Type.Object({
  previewToken: McpNormalizedFingerprintSchema,
  entries: Type.Array(McpPortabilityPreviewEntrySchema),
});

export const McpPortabilityDecisionInputSchema = Type.Object({
  key: Type.String(),
  decision: McpPortabilityDecisionSchema,
  /** Required for replace and must name a candidate shown in preview. */
  targetServerId: Type.Optional(Type.String({ minLength: 1 })),
  /** Destination-supplied write-only values for unresolved exported references. */
  secretEnv: Type.Optional(Type.Record(Type.String(), Type.String())),
  headers: Type.Optional(Type.Record(Type.String(), Type.String())),
});

export const ApplyMcpPortabilityImportBodySchema = Type.Object({
  ...importSourceFields,
  previewToken: McpNormalizedFingerprintSchema,
  decisions: Type.Array(McpPortabilityDecisionInputSchema),
});

export const McpPortabilityApplyResultSchema = Type.Object({
  key: Type.String(),
  decision: McpPortabilityDecisionSchema,
  serverId: Type.Optional(Type.String()),
});

export const McpPortabilityApplyResponseSchema = Type.Object({
  added: Type.Number({ minimum: 0 }),
  replaced: Type.Number({ minimum: 0 }),
  copied: Type.Number({ minimum: 0 }),
  skipped: Type.Number({ minimum: 0 }),
  invalid: Type.Number({ minimum: 0 }),
  results: Type.Array(McpPortabilityApplyResultSchema),
});

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

/** One resource advertised by a server's `resources/list`. */
export const McpResourceDescriptorSchema = Type.Object({
  uri: Type.String({ minLength: 1 }),
  name: Type.String(),
  description: Type.Optional(Type.String()),
  mimeType: Type.Optional(Type.String()),
  sizeBytes: Type.Optional(Type.Number()),
});

export const McpServerResourcesResponseSchema = Type.Object({
  resources: Type.Array(McpResourceDescriptorSchema),
});

/**
 * Read a resource's contents. With `chatId`, supported contents are also
 * persisted as chat attachments so a turn can reference them as context.
 */
export const ReadMcpResourceBodySchema = Type.Object({
  uri: Type.String({ minLength: 1 }),
  chatId: Type.Optional(Type.String({ minLength: 1 })),
});

/**
 * One `resources/read` content entry. Text is inlined (capped); binary
 * payloads never travel inline — they surface only via `attachments`.
 */
export const McpResourceContentSchema = Type.Object({
  uri: Type.String(),
  mimeType: Type.Optional(Type.String()),
  text: Type.Optional(Type.String()),
  isBinary: Type.Boolean(),
});

export const ReadMcpResourceResponseSchema = Type.Object({
  contents: Type.Array(McpResourceContentSchema),
  /** Chat attachments created from the contents when `chatId` was provided. */
  attachments: Type.Optional(Type.Array(ChatAttachmentSchema)),
});

export const McpPromptArgumentSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  description: Type.Optional(Type.String()),
  required: Type.Optional(Type.Boolean()),
});

/** One prompt advertised by a server's `prompts/list`. */
export const McpPromptDescriptorSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  description: Type.Optional(Type.String()),
  arguments: Type.Array(McpPromptArgumentSchema),
});

export const McpServerPromptsResponseSchema = Type.Object({
  prompts: Type.Array(McpPromptDescriptorSchema),
});

export const GetMcpPromptBodySchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  arguments: Type.Optional(Type.Record(Type.String(), Type.String())),
});

/** A resolved prompt with each message flattened to plain text. */
export const GetMcpPromptResponseSchema = Type.Object({
  description: Type.Optional(Type.String()),
  messages: Type.Array(
    Type.Object({
      role: Type.Union([Type.Literal('user'), Type.Literal('assistant')]),
      text: Type.String(),
    })
  ),
});

/** Final state of a resolved elicitation; `pending` never appears here. */
export const McpElicitationTerminalStatusSchema = Type.Union([
  Type.Literal('accepted'),
  Type.Literal('declined'),
  Type.Literal('cancelled'),
]);

/** Lifecycle of a mid-tool-call MCP form elicitation shown in chat. */
export const McpElicitationStatusSchema = Type.Union([
  Type.Literal('pending'),
  Type.Literal('accepted'),
  Type.Literal('declined'),
  Type.Literal('cancelled'),
]);

/**
 * Why an elicitation reached its terminal status: a user response, or a
 * server-side end of life (timeout, turn abort, tool completion, tool failure,
 * session close) that cancelled it without input.
 */
export const McpElicitationTerminalReasonSchema = Type.Union([
  Type.Literal('responded'),
  Type.Literal('tool_timeout'),
  Type.Literal('turn_aborted'),
  Type.Literal('tool_finished'),
  Type.Literal('tool_failed'),
  Type.Literal('server_closed'),
]);

export const McpElicitationFieldFormatSchema = Type.Union([
  Type.Literal('email'),
  Type.Literal('uri'),
  Type.Literal('date'),
  Type.Literal('date-time'),
]);

export const McpElicitationEnumOptionSchema = Type.Object({
  value: Type.String(),
  label: Type.String(),
});

/**
 * One flattened field from an MCP `requestedSchema` object. Enum / multi-enum
 * map to option buttons; other primitives map to typed inputs.
 */
export const McpElicitationFieldSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  title: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  required: Type.Boolean(),
  kind: Type.Union([
    Type.Literal('string'),
    Type.Literal('number'),
    Type.Literal('integer'),
    Type.Literal('boolean'),
    Type.Literal('enum'),
    Type.Literal('multi_enum'),
  ]),
  format: Type.Optional(McpElicitationFieldFormatSchema),
  minLength: Type.Optional(Type.Number()),
  maxLength: Type.Optional(Type.Number()),
  minimum: Type.Optional(Type.Number()),
  maximum: Type.Optional(Type.Number()),
  minItems: Type.Optional(Type.Number()),
  maxItems: Type.Optional(Type.Number()),
  options: Type.Optional(Type.Array(McpElicitationEnumOptionSchema)),
  default: Type.Optional(
    Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Array(Type.String())])
  ),
});

/** Persisted / streamed card payload for an MCP form elicitation. */
export const McpElicitationPartSchema = Type.Object({
  type: Type.Literal('mcp_elicitation'),
  elicitationId: Type.String({ minLength: 1 }),
  toolCallId: Type.String({ minLength: 1 }),
  serverSlug: Type.String({ minLength: 1 }),
  message: Type.String(),
  fields: Type.Array(McpElicitationFieldSchema),
  status: McpElicitationStatusSchema,
  reason: Type.Optional(McpElicitationTerminalReasonSchema),
});

export const McpElicitationActionSchema = Type.Union([
  Type.Literal('accept'),
  Type.Literal('decline'),
  Type.Literal('cancel'),
]);

/** Body for `POST /mcp/elicitations/:id/respond`. */
export const RespondMcpElicitationBodySchema = Type.Object({
  action: McpElicitationActionSchema,
  /** Field values when `action` is `accept`; omitted for decline/cancel. */
  content: Type.Optional(
    Type.Record(
      Type.String(),
      Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Array(Type.String())])
    )
  ),
});

export const RespondMcpElicitationResponseSchema = Type.Object({
  ok: Type.Literal(true),
  status: McpElicitationStatusSchema,
});

export type McpTransport = Static<typeof McpTransportSchema>;
export type PreviewMcpImportBody = Static<typeof PreviewMcpImportBodySchema>;
export type ImportMcpServersBody = Static<typeof ImportMcpServersBodySchema>;
export type McpImportAction = Static<typeof McpImportActionSchema>;
export type McpImportReason = Static<typeof McpImportReasonSchema>;
export type McpImportPreviewEntry = Static<typeof McpImportPreviewEntrySchema>;
export type McpImportPreviewResponse = Static<typeof McpImportPreviewResponseSchema>;
export type McpImportResultEntry = Static<typeof McpImportResultEntrySchema>;
export type ImportMcpServersResponse = Static<typeof ImportMcpServersResponseSchema>;
export type McpPortableStdioServer = Static<typeof McpPortableStdioServerSchema>;
export type McpPortableHttpServer = Static<typeof McpPortableHttpServerSchema>;
export type McpPortableServer = Static<typeof McpPortableServerSchema>;
export type McpPortableServerMetadata = Static<typeof McpPortableServerMetadataSchema>;
export type McpPortableDocument = Static<typeof McpPortableDocumentSchema>;
export type ExportMcpServersBody = Static<typeof ExportMcpServersBodySchema>;
export type ExportMcpServersResponse = Static<typeof ExportMcpServersResponseSchema>;
export type McpNormalizedFingerprint = Static<typeof McpNormalizedFingerprintSchema>;
export type McpPortabilityConflictKey = Static<typeof McpPortabilityConflictKeySchema>;
export type McpPortabilityDecision = Static<typeof McpPortabilityDecisionSchema>;
export type McpPortabilitySecretReference = Static<typeof McpPortabilitySecretReferenceSchema>;
export type McpPortabilityConflictCandidate = Static<typeof McpPortabilityConflictCandidateSchema>;
export type McpPortabilityInvalidReason = Static<typeof McpPortabilityInvalidReasonSchema>;
export type McpPortabilityPreviewEntry = Static<typeof McpPortabilityPreviewEntrySchema>;
export type PreviewMcpPortabilityImportBody = Static<typeof PreviewMcpPortabilityImportBodySchema>;
export type McpPortabilityPreviewResponse = Static<typeof McpPortabilityPreviewResponseSchema>;
export type McpPortabilityDecisionInput = Static<typeof McpPortabilityDecisionInputSchema>;
export type ApplyMcpPortabilityImportBody = Static<typeof ApplyMcpPortabilityImportBodySchema>;
export type McpPortabilityApplyResult = Static<typeof McpPortabilityApplyResultSchema>;
export type McpPortabilityApplyResponse = Static<typeof McpPortabilityApplyResponseSchema>;
export type McpServerStatus = Static<typeof McpServerStatusSchema>;
export type McpServer = Static<typeof McpServerSchema>;
export type AddMcpServerBody = Static<typeof AddMcpServerBodySchema>;
export type UpdateMcpServerBody = Static<typeof UpdateMcpServerBodySchema>;
export type McpToolDescriptor = Static<typeof McpToolDescriptorSchema>;
export type McpServerListResponse = Static<typeof McpServerListResponseSchema>;
export type McpServerToolsResponse = Static<typeof McpServerToolsResponseSchema>;
export type TestMcpServerResponse = Static<typeof TestMcpServerResponseSchema>;
export type DeleteMcpServerResponse = Static<typeof DeleteMcpServerResponseSchema>;
export type McpResourceDescriptor = Static<typeof McpResourceDescriptorSchema>;
export type McpServerResourcesResponse = Static<typeof McpServerResourcesResponseSchema>;
export type ReadMcpResourceBody = Static<typeof ReadMcpResourceBodySchema>;
export type McpResourceContent = Static<typeof McpResourceContentSchema>;
export type ReadMcpResourceResponse = Static<typeof ReadMcpResourceResponseSchema>;
export type McpPromptArgument = Static<typeof McpPromptArgumentSchema>;
export type McpPromptDescriptor = Static<typeof McpPromptDescriptorSchema>;
export type McpServerPromptsResponse = Static<typeof McpServerPromptsResponseSchema>;
export type GetMcpPromptBody = Static<typeof GetMcpPromptBodySchema>;
export type GetMcpPromptResponse = Static<typeof GetMcpPromptResponseSchema>;
export type McpElicitationStatus = Static<typeof McpElicitationStatusSchema>;
export type McpElicitationTerminalStatus = Static<typeof McpElicitationTerminalStatusSchema>;
export type McpElicitationTerminalReason = Static<typeof McpElicitationTerminalReasonSchema>;
export type McpElicitationFieldFormat = Static<typeof McpElicitationFieldFormatSchema>;
export type McpElicitationEnumOption = Static<typeof McpElicitationEnumOptionSchema>;
export type McpElicitationField = Static<typeof McpElicitationFieldSchema>;
export type McpElicitationPart = Static<typeof McpElicitationPartSchema>;
export type McpElicitationAction = Static<typeof McpElicitationActionSchema>;
export type RespondMcpElicitationBody = Static<typeof RespondMcpElicitationBodySchema>;
export type RespondMcpElicitationResponse = Static<typeof RespondMcpElicitationResponseSchema>;
