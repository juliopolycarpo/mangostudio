import { describe, expect, it } from 'bun:test';

import Value from 'typebox/value';

import {
  type ExternalAgentEvent,
  ExternalAgentEventSchema,
  type ExternalTextLimit,
  schemaMaxLengthFor,
  VendorText,
} from '../../src/external-agents';
import {
  externalAgentEventToStreamChunk,
  externalSessionStartedChunk,
  externalSteerChunk,
  externalTurnCompletedChunk,
  externalTurnWaitingChunk,
  type StreamChunk,
  StreamChunkSchema,
} from '../../src/streaming';

/** Every member of the union, with the nested `external_steer` pair flattened in. */
function unionMembers(): readonly unknown[] {
  const members: unknown[] = [];
  for (const member of StreamChunkSchema.anyOf) {
    const nested = (member as { anyOf?: readonly unknown[] }).anyOf;
    if (nested) members.push(...nested);
    else members.push(member);
  }
  return members;
}

const EXTERNAL_CHUNK_TYPES: readonly string[] = unionMembers()
  .map(
    (member) => (member as { properties?: { type?: { const?: string } } }).properties?.type?.const
  )
  .filter((type): type is string => type?.startsWith('external_') === true);

/**
 * One chunk of every `external_*` type, each built by the function the hub calls
 * to produce it (`external-events.ts`), with every optional field present so a
 * closed schema that forgot one fails here.
 */
function producerChunks(): readonly StreamChunk[] {
  const limits = {
    targetId: 'codex' as const,
    windows: [{ usedPercent: 40 }],
    observedAtMs: 1_700_000_000_000,
  };
  const events: readonly ExternalAgentEvent[] = [
    { type: 'text_delta', text: 'hello' },
    { type: 'reasoning_delta', text: 'considering' },
    { type: 'reasoning_started' },
    { type: 'reasoning_ended' },
    {
      type: 'activity_started',
      callId: 'call_1',
      activity: { name: 'shell', kind: 'command', title: 'ls', detail: 'in /tmp', truncated: true },
    },
    { type: 'activity_updated', callId: 'call_1', update: { title: 'ls -la', detail: 'running' } },
    {
      type: 'activity_completed',
      callId: 'call_1',
      result: { status: 'failed', detail: 'exit 1', truncated: true },
    },
    {
      type: 'approval_requested',
      request: {
        requestId: 'req_1',
        kind: 'command',
        title: 'Run it',
        detail: 'rm -rf build',
        options: [
          { id: 'approve', labelKey: 'approve', rawLabel: 'Approve', isDestructive: false },
        ],
        expiresAtMs: 1_700_000_000_000,
        truncated: true,
      },
    },
    {
      type: 'approval_resolved',
      requestId: 'req_1',
      decision: { optionId: 'approve', source: 'user' },
    },
    { type: 'usage', usage: { inputTokens: 12, outputTokens: 3 } },
    {
      type: 'thread_usage',
      usage: { last: { totalTokens: 12 }, total: { totalTokens: 120 }, contextWindowTokens: 1000 },
    },
    { type: 'account_limits', limits },
    { type: 'commands_available', commands: [{ name: 'review', description: 'Read a diff' }] },
    { type: 'notice', severity: 'warning', title: 'Rate limit close', description: 'Soon.' },
  ];

  const projected = events.map((event) => {
    const chunk = externalAgentEventToStreamChunk(event, { vendorAccountFingerprint: 'acct-a' });
    if (chunk === null) throw new Error(`(producerChunks): '${event.type}' projects to no chunk`);
    return chunk;
  });
  const failure = externalAgentEventToStreamChunk(
    { type: 'error', error: { code: 'x', message: 'boom', requestId: 'r', retryable: true } },
    undefined,
    { kind: 'update' },
    { unavailableReason: 'version-unsupported', requiredVersion: '0.153.4' }
  );
  if (failure === null) throw new Error('(producerChunks): an error event projects to no chunk');

  return [
    ...projected,
    failure,
    externalSessionStartedChunk({
      sessionId: 'hub-minted',
      targetId: 'codex',
      resumed: false,
      fallbackReason: 'thread expired',
      conversationReset: 'unavailable',
      model: 'gpt-5',
    }),
    externalSteerChunk({ clientMessageId: 'c1', text: 'faster', status: 'accepted' }),
    externalSteerChunk({
      clientMessageId: 'c2',
      text: 'faster',
      status: 'rejected',
      reasonCode: 'turn-already-completed',
    }),
    externalTurnWaitingChunk('runtime-busy'),
    externalTurnWaitingChunk(undefined),
    externalTurnCompletedChunk('completed'),
  ];
}

/** The union members the chunk satisfies, so an error report can be read off one schema. */
function membersAccepting(chunk: unknown): readonly unknown[] {
  return unionMembers().filter((member) => Value.Check(member as never, chunk));
}

describe('external stream chunks, producer by producer', () => {
  const chunks = producerChunks();

  it('covers every external_* chunk type in the union', () => {
    const produced = new Set(chunks.map((chunk) => chunk.type));
    const missing = EXTERNAL_CHUNK_TYPES.filter((type) => !produced.has(type as never));
    expect(
      missing,
      `(producerChunks): expected a fixture for every external_* chunk type | missing: ${missing.join(', ')}`
    ).toEqual([]);
  });

  it.each(chunks.map((chunk) => [chunk.type, chunk] as const))(
    'validates the %s chunk its producer builds',
    (_type, chunk) => {
      expect(
        Value.Check(StreamChunkSchema, chunk),
        `(${chunk.type}): expected the producer's chunk to satisfy StreamChunkSchema | received: ${JSON.stringify(chunk)}`
      ).toBe(true);
    }
  );

  it.each(chunks.map((chunk) => [chunk.type, chunk] as const))(
    'rejects an unknown key on the %s chunk, naming the key',
    (_type, chunk) => {
      const widened = { ...chunk, vendorExtension: 'x' };
      expect(
        Value.Check(StreamChunkSchema, widened),
        `(${chunk.type}): expected an extra 'vendorExtension' key to be rejected`
      ).toBe(false);

      // The union's own error list is truncated, so read the key from the one
      // member that accepted the chunk before the key was added.
      const [member, ...others] = membersAccepting(chunk);
      expect(
        others,
        `(${chunk.type}): expected exactly one union member to accept the chunk`
      ).toEqual([]);
      const rejection = Value.Errors(member as never, widened).find(
        (error) => error.keyword === 'additionalProperties'
      );
      expect(
        (rejection?.params as { additionalProperties?: string[] } | undefined)
          ?.additionalProperties,
        `(${chunk.type}): expected an additionalProperties error naming 'vendorExtension'`
      ).toEqual(['vendorExtension']);
    }
  );
});

interface BoundedField {
  readonly label: string;
  readonly chunkType: string;
  readonly field: string;
  readonly limit: ExternalTextLimit;
  /** The neutral event the chunk projects from, when it has one. */
  readonly event?: (value: string) => ExternalAgentEvent;
  readonly chunk: (value: string) => StreamChunk;
}

const activityStarted = (patch: { name?: string; title?: string; detail?: string }) =>
  ({
    type: 'activity_started',
    callId: 'call_1',
    activity: { name: 'shell', kind: 'command', title: 'ls', ...patch },
  }) satisfies ExternalAgentEvent;

const approvalRequested = (patch: { requestId?: string; title?: string; detail?: string }) =>
  ({
    type: 'approval_requested',
    request: {
      requestId: 'req_1',
      kind: 'command',
      title: 'Run it',
      options: [{ id: 'approve', isDestructive: false }],
      expiresAtMs: 1_700_000_000_000,
      ...patch,
    },
  }) satisfies ExternalAgentEvent;

function projected(event: ExternalAgentEvent): StreamChunk {
  const chunk = externalAgentEventToStreamChunk(event);
  if (chunk === null) throw new Error(`(bounded fields): '${event.type}' projects to no chunk`);
  return chunk;
}

const BOUNDED_FIELDS: readonly BoundedField[] = [
  {
    label: 'session id',
    chunkType: 'external_session_started',
    field: 'sessionId',
    limit: 'vendorId',
    chunk: (value) =>
      externalSessionStartedChunk({ sessionId: value, targetId: 'codex', resumed: false }),
  },
  {
    label: 'session fallback reason',
    chunkType: 'external_session_started',
    field: 'fallbackReason',
    limit: 'errorMessage',
    chunk: (value) =>
      externalSessionStartedChunk({
        sessionId: 's1',
        targetId: 'codex',
        resumed: false,
        fallbackReason: value,
      }),
  },
  ...(
    [
      ['callId', 'vendorId'],
      ['name', 'activityName'],
      ['title', 'title'],
      ['detail', 'detail'],
    ] as const
  ).map(([field, limit]): BoundedField => ({
    label: `activity ${field}`,
    chunkType: 'external_activity_started',
    field,
    limit,
    event: (value) =>
      field === 'callId'
        ? { ...activityStarted({}), callId: value }
        : activityStarted({ [field]: value }),
    chunk: (value) =>
      projected(
        field === 'callId'
          ? { ...activityStarted({}), callId: value }
          : activityStarted({ [field]: value })
      ),
  })),
  {
    label: 'activity update call id',
    chunkType: 'external_activity_updated',
    field: 'callId',
    limit: 'vendorId',
    event: (value) => ({ type: 'activity_updated', callId: value, update: {} }),
    chunk: (value) => projected({ type: 'activity_updated', callId: value, update: {} }),
  },
  {
    label: 'activity completion call id',
    chunkType: 'external_activity_completed',
    field: 'callId',
    limit: 'vendorId',
    event: (value) => ({
      type: 'activity_completed',
      callId: value,
      result: { status: 'completed' },
    }),
    chunk: (value) =>
      projected({ type: 'activity_completed', callId: value, result: { status: 'completed' } }),
  },
  {
    label: 'activity completion detail',
    chunkType: 'external_activity_completed',
    field: 'detail',
    limit: 'detail',
    event: (value) => ({
      type: 'activity_completed',
      callId: 'call_1',
      result: { status: 'completed', detail: value },
    }),
    chunk: (value) =>
      projected({
        type: 'activity_completed',
        callId: 'call_1',
        result: { status: 'completed', detail: value },
      }),
  },
  ...(
    [
      ['requestId', 'vendorId'],
      ['title', 'title'],
      ['detail', 'detail'],
    ] as const
  ).map(([field, limit]): BoundedField => ({
    label: `approval request ${field}`,
    chunkType: 'external_approval_request',
    field,
    limit,
    event: (value) => approvalRequested({ [field]: value }),
    chunk: (value) => projected(approvalRequested({ [field]: value })),
  })),
  {
    label: 'approval status request id',
    chunkType: 'external_approval_status',
    field: 'requestId',
    limit: 'vendorId',
    event: (value) => ({
      type: 'approval_resolved',
      requestId: value,
      decision: { optionId: 'approve', source: 'user' },
    }),
    chunk: (value) =>
      projected({
        type: 'approval_resolved',
        requestId: value,
        decision: { optionId: 'approve', source: 'user' },
      }),
  },
  {
    label: 'notice title',
    chunkType: 'external_notice',
    field: 'title',
    limit: 'title',
    event: (value) => ({ type: 'notice', severity: 'info', title: value }),
    chunk: (value) => projected({ type: 'notice', severity: 'info', title: value }),
  },
  {
    label: 'notice description',
    chunkType: 'external_notice',
    field: 'description',
    limit: 'detail',
    event: (value) => ({ type: 'notice', severity: 'info', title: 't', description: value }),
    chunk: (value) =>
      projected({ type: 'notice', severity: 'info', title: 't', description: value }),
  },
];

describe('VendorText, as exported from the external-agents entrypoint', () => {
  it('takes its maxLength from the limits table and passes minLength through', () => {
    const schema = VendorText('activityName', { minLength: 1 });
    const max = schemaMaxLengthFor('activityName');
    expect(
      [
        Value.Check(schema, 'x'.repeat(max)),
        Value.Check(schema, 'x'.repeat(max + 1)),
        Value.Check(schema, ''),
      ],
      `(VendorText): expected [${max} units accepted, ${max + 1} rejected, '' rejected]`
    ).toEqual([true, false, false]);
  });
});

describe('external stream chunk string bounds', () => {
  it.each(BOUNDED_FIELDS.map((row) => [row.label, row] as const))(
    'bounds the %s like the event it projects from',
    (_label, row) => {
      const max = schemaMaxLengthFor(row.limit);
      const atLimit = 'x'.repeat(max);
      const overLimit = 'x'.repeat(max + 1);

      expect(
        Value.Check(StreamChunkSchema, row.chunk(atLimit)),
        `(${row.chunkType}.${row.field}): expected a ${max}-unit value to validate`
      ).toBe(true);

      const oversized = row.chunk(overLimit);
      expect(
        Value.Check(StreamChunkSchema, oversized),
        `(${row.chunkType}.${row.field}): expected a ${max + 1}-unit value to be rejected | limit: ${max} (${row.limit})`
      ).toBe(false);

      const [member] = membersAccepting(row.chunk(atLimit));
      const violation = Value.Errors(member as never, oversized).find(
        (error) => error.keyword === 'maxLength'
      );
      expect(
        violation && {
          path: violation.instancePath,
          limit: (violation.params as { limit?: number }).limit,
        },
        `(${row.chunkType}.${row.field}): expected a maxLength error at /${row.field} with limit ${max}`
      ).toEqual({ path: `/${row.field}`, limit: max });

      // The source event enforces the same number, so the chunk can never carry
      // more than the event allowed.
      if (row.event) {
        expect(
          Value.Check(ExternalAgentEventSchema, row.event(overLimit)),
          `(${row.chunkType}.${row.field}): expected the source event to reject ${max + 1} units too`
        ).toBe(false);
        expect(Value.Check(ExternalAgentEventSchema, row.event(atLimit))).toBe(true);
      }
    }
  );

  it('rejects an empty identifier, as the source event does', () => {
    const empty = projected({
      type: 'activity_completed',
      callId: '',
      result: { status: 'completed' },
    });
    expect(
      Value.Check(StreamChunkSchema, empty),
      "(external_activity_completed.callId): expected '' to be rejected | minLength: 1"
    ).toBe(false);
  });

  it('keeps the approval option cap equal to the event contract', () => {
    const request = {
      requestId: 'req_1',
      kind: 'command' as const,
      title: 'Run it',
      options: Array.from({ length: 17 }, (_, index) => ({
        id: `o${index}`,
        isDestructive: false,
      })),
      expiresAtMs: 1_700_000_000_000,
    };
    expect(
      Value.Check(ExternalAgentEventSchema, { type: 'approval_requested', request }),
      '(approval_requested.request.options): expected 17 options to be rejected | maxItems: 16'
    ).toBe(false);
    expect(
      Value.Check(StreamChunkSchema, {
        type: 'external_approval_request',
        ...request,
        done: false,
      }),
      '(external_approval_request.options): expected 17 options to be rejected | maxItems: 16'
    ).toBe(false);
  });
});
