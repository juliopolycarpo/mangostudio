import { describe, expect, it } from 'bun:test';
import Value from 'typebox/value';

import { ChatRunnerConfigurationSchema } from '../../src/chat';
import {
  boundVendorText,
  EXTERNAL_AGENT_TARGET_IDS,
  EXTERNAL_AGENT_UNAVAILABLE_REASONS,
  EXTERNAL_STEER_REJECTION_REASONS,
  EXTERNAL_TEXT_LIMITS,
  EXTERNAL_TURN_PAYLOAD_MAX_BYTES,
  ExternalAccountLimitsSchema,
  ExternalAgentAckResultSchema,
  ExternalAgentCancelParamsSchema,
  ExternalAgentCloseParamsSchema,
  ExternalAgentConfigurationSchema,
  type ExternalAgentDescriptor,
  ExternalAgentDescriptorListResponseSchema,
  ExternalAgentDescriptorSchema,
  ExternalAgentDiscoverParamsSchema,
  ExternalAgentDiscoverResultSchema,
  type ExternalAgentEvent,
  ExternalAgentEventEnvelopeFrameSchema,
  ExternalAgentEventEnvelopeSchema,
  ExternalAgentEventSchema,
  ExternalAgentOpenParamsSchema,
  ExternalAgentOpenResultSchema,
  ExternalAgentRespondParamsSchema,
  ExternalAgentSteerParamsSchema,
  ExternalAgentSteerResultSchema,
  type ExternalAgentTargetId,
  ExternalAgentTargetIdSchema,
  ExternalAgentTurnParamsSchema,
  ExternalAgentTurnResultSchema,
  ExternalIdentityIsolationSchema,
  ExternalSteerRejectionReasonSchema,
  NO_EXTERNAL_AGENT_CAPABILITIES,
  normalizeApprovalRouting,
  normalizePermissionLevel,
} from '../../src/external-agents';
import type { LibraryTargetId } from '../../src/library';
import { LibraryTargetIdSchema } from '../../src/library';
import { assertType, type Equals } from '../../src/test-utils/type-assert';

// The type and the schema are two independent statements of the same fact, and
// a schema that drifts is invisible to a type assertion — so both are pinned.
assertType<Equals<ExternalAgentTargetId, Exclude<LibraryTargetId, 'mangostudio'>>>();

function literals(schema: { anyOf: readonly { const: string }[] }): string[] {
  return schema.anyOf.map((member) => member.const).sort();
}

const DESCRIPTOR: ExternalAgentDescriptor = {
  targetId: 'codex',
  environmentId: 'local',
  installed: true,
  authState: 'signed-in',
  capabilities: NO_EXTERNAL_AGENT_CAPABILITIES,
  supportedConfigurations: [],
  models: [
    {
      id: 'model-1',
      displayName: 'Model One',
      supportedReasoningEfforts: [{ id: 'low', description: 'Faster responses' }],
      defaultReasoningEffort: 'low',
    },
  ],
  unavailableReason: 'signed-out',
};

describe('external agent target identity', () => {
  it('is exactly the library targets that are not MangoStudio itself', () => {
    const external = literals(LibraryTargetIdSchema).filter((id) => id !== 'mangostudio');

    expect(literals(ExternalAgentTargetIdSchema)).toEqual(external);
    expect([...EXTERNAL_AGENT_TARGET_IDS].sort() as string[]).toEqual(external);
  });

  it('is the same schema the chat runner union validates against', () => {
    expect(
      Value.Check(ChatRunnerConfigurationSchema, { kind: 'external', targetId: 'cursor' })
    ).toBe(true);
    expect(
      Value.Check(ChatRunnerConfigurationSchema, { kind: 'external', targetId: 'mangostudio' })
    ).toBe(false);
  });
});

describe('external agent descriptor', () => {
  it('validates a minimal descriptor and the list response around it', () => {
    expect(Value.Check(ExternalAgentDescriptorSchema, DESCRIPTOR)).toBe(true);
    expect(
      Value.Check(ExternalAgentDescriptorListResponseSchema, {
        environmentId: 'local',
        agents: [DESCRIPTOR],
      })
    ).toBe(true);
  });

  it('refuses an executable path, which no client may render', () => {
    expect(
      Value.Check(ExternalAgentDescriptorSchema, {
        ...DESCRIPTOR,
        executablePath: '/usr/local/bin/codex',
      })
    ).toBe(false);
  });

  it('names every reason a target can be unselectable', () => {
    expect([...EXTERNAL_AGENT_UNAVAILABLE_REASONS]).toEqual([
      'not-installed',
      'signed-out',
      'runtime-unsupported',
      'runtime-denied',
      'environment-unreachable',
      'isolation-unproven',
      'version-unsupported',
      'disclosure-required',
    ]);
  });

  /**
   * The required version is bound to the one reason whose copy interpolates it.
   * Anywhere else it would read as a floor this runtime enforces, and it does
   * not — a below-pin binary that still answers its probe stays selectable.
   */
  it('carries the version to upgrade to beside the reason that names it', () => {
    expect(
      Value.Check(ExternalAgentDescriptorSchema, {
        ...DESCRIPTOR,
        unavailableReason: 'version-unsupported',
        requiredVersion: '2026.08.04',
      })
    ).toBe(true);
    expect(Value.Check(ExternalAgentDescriptorSchema, { ...DESCRIPTOR, requiredVersion: '' })).toBe(
      false
    );
  });

  it('keeps model catalogs rich and bounded', () => {
    expect(Value.Check(ExternalAgentDescriptorSchema, DESCRIPTOR)).toBe(true);
    expect(
      Value.Check(ExternalAgentDescriptorSchema, {
        ...DESCRIPTOR,
        models: [{ id: 'x'.repeat(257) }],
      })
    ).toBe(false);
  });

  it('accepts old descriptors that predate model catalogs and account fingerprints', () => {
    const { models: _models, ...oldDescriptor } = DESCRIPTOR;
    expect(Value.Check(ExternalAgentDescriptorSchema, oldDescriptor)).toBe(true);
    expect(
      Value.Check(ExternalAgentDescriptorSchema, {
        ...oldDescriptor,
        account: { label: 'Signed-in account' },
      })
    ).toBe(true);
  });
});

describe('runtime external-agent protocol payloads', () => {
  const configuration = {
    model: 'model-1',
    effort: 'low',
    level: 'default',
    routing: 'user',
    workspaceRoots: ['/workspace'],
  } as const;

  it('validates all six method contracts', () => {
    const { environmentId: _environmentId, ...runtimeDescriptor } = DESCRIPTOR;

    expect(
      Value.Check(ExternalAgentDiscoverParamsSchema, {
        targetIds: ['codex'],
        timeoutMs: 5_000,
      })
    ).toBe(true);
    expect(
      Value.Check(ExternalAgentDiscoverResultSchema, { descriptors: [runtimeDescriptor] })
    ).toBe(true);
    expect(
      Value.Check(ExternalAgentOpenParamsSchema, {
        sessionId: 'session-1',
        targetId: 'codex',
        workspacePath: '/workspace',
        configuration,
        resumeMode: 'fallback',
        timeoutMs: 30_000,
      })
    ).toBe(true);
    // Guards a real cycle risk: ToolchainSelectionSchema is imported from
    // `environments/toolchain-schemas` specifically to avoid a loop through
    // `runtime-protocol/schemas` and `runtime-home/schemas`, both of which
    // import this module. A regression there does not fail `tsc` — it makes
    // this optional resolve to `undefined` at eval time instead.
    expect(
      Value.Check(ExternalAgentOpenParamsSchema, {
        sessionId: 'session-1',
        targetId: 'codex',
        workspacePath: '/workspace',
        configuration,
        resumeMode: 'fallback',
        timeoutMs: 30_000,
        toolchain: { node: 'auto', bun: '/opt/bun/bin/bun' },
      })
    ).toBe(true);
    expect(
      Value.Check(ExternalAgentOpenParamsSchema, {
        sessionId: 'session-1',
        targetId: 'codex',
        workspacePath: '/workspace',
        configuration,
        resumeMode: 'fallback',
        timeoutMs: 30_000,
        toolchain: { node: 'auto' },
      })
    ).toBe(false);
    expect(
      Value.Check(ExternalAgentOpenResultSchema, {
        nativeSessionId: 'thread-1',
        resumed: false,
        effectiveConfiguration: configuration,
        capabilities: NO_EXTERNAL_AGENT_CAPABILITIES,
      })
    ).toBe(true);
    expect(
      Value.Check(ExternalAgentTurnParamsSchema, {
        sessionId: 'session-1',
        clientMessageId: 'message-1',
        input: 'Use the attached note.',
        configuration,
        attachments: [
          {
            id: 'attachment-1',
            originalName: 'note.txt',
            mimeType: 'text/plain',
            sizeBytes: 4,
            kind: 'text',
            bytesBase64: 'bm90ZQ==',
          },
        ],
      })
    ).toBe(true);
    expect(Value.Check(ExternalAgentTurnResultSchema, { nativeTurnId: 'turn-1' })).toBe(true);
    expect(
      Value.Check(ExternalAgentRespondParamsSchema, {
        sessionId: 'session-1',
        nativeTurnId: 'turn-1',
        requestId: 'request-1',
        optionId: 'allow',
      })
    ).toBe(true);
    expect(
      Value.Check(ExternalAgentCancelParamsSchema, {
        sessionId: 'session-1',
        nativeTurnId: 'turn-1',
      })
    ).toBe(true);
    expect(Value.Check(ExternalAgentCloseParamsSchema, { sessionId: 'session-1' })).toBe(true);
    expect(Value.Check(ExternalAgentAckResultSchema, { ok: true })).toBe(true);
  });

  it('keeps configuration, attachments, and method records closed', () => {
    expect(Value.Check(ExternalAgentConfigurationSchema, { ...configuration, env: {} })).toBe(
      false
    );
    expect(
      Value.Check(ExternalAgentTurnParamsSchema, {
        sessionId: 'session-1',
        clientMessageId: 'message-1',
        input: '',
        configuration,
        attachments: [],
        secret: 'must-not-cross',
      })
    ).toBe(false);
  });

  it('requires semantic event sequences to be one-based', () => {
    const envelope = {
      sessionId: 'session-1',
      nativeTurnId: 'turn-1',
      sequence: 1,
      emittedAtMs: 1_700_000_000_000,
      event: { type: 'text_delta', text: 'hello' },
    } as const;

    expect(Value.Check(ExternalAgentEventEnvelopeSchema, envelope)).toBe(true);
    expect(Value.Check(ExternalAgentEventEnvelopeSchema, { ...envelope, sequence: 0 })).toBe(false);
    expect(Value.Check(ExternalAgentEventEnvelopeSchema, { ...envelope, transportSeq: 1 })).toBe(
      false
    );
    // Nothing produces this yet. The envelope is closed, so a consumer that
    // predates a key drops the whole event instead of ignoring it — declaring
    // the turn controller's key up front is what keeps two builds the protocol
    // version calls compatible from silently losing every event.
    expect(
      Value.Check(ExternalAgentEventEnvelopeSchema, { ...envelope, idempotencyKey: 'message-1' })
    ).toBe(true);
  });

  /**
   * #964. A hub and a runtime never upgrade in lockstep, so the frame schema
   * has to accept an `event` this build's `ExternalAgentEventSchema` has never
   * seen — that is exactly the envelope a newer runtime sends, and the whole
   * point of splitting it from the full schema is that its sequence number
   * must still be counted rather than silently lost.
   */
  it('checks the envelope frame without checking the event it carries', () => {
    const frame = {
      sessionId: 'session-1',
      nativeTurnId: 'turn-1',
      sequence: 1,
      emittedAtMs: 1_700_000_000_000,
      event: { type: 'future_event', shape: 'unknown' },
    } as const;

    expect(Value.Check(ExternalAgentEventEnvelopeFrameSchema, frame)).toBe(true);
    expect(Value.Check(ExternalAgentEventEnvelopeSchema, frame)).toBe(false);
    expect(Value.Check(ExternalAgentEventEnvelopeFrameSchema, { ...frame, sequence: 0 })).toBe(
      false
    );
    expect(Value.Check(ExternalAgentEventEnvelopeFrameSchema, { ...frame, sessionId: 1 })).toBe(
      false
    );
    const { event: _event, ...withoutEvent } = frame;
    expect(Value.Check(ExternalAgentEventEnvelopeFrameSchema, withoutEvent)).toBe(false);
  });

  it('requires a closed, positive identity-isolation attestation', () => {
    const isolation = {
      method: 'single-user-host',
      credentialHomeFingerprint: 'sha256:credential-home',
    } as const;
    expect(Value.Check(ExternalIdentityIsolationSchema, isolation)).toBe(true);
    expect(Value.Check(ExternalIdentityIsolationSchema, { ...isolation, inferred: true })).toBe(
      false
    );
  });
});

describe('steering', () => {
  it('names every reason a steer can be refused', () => {
    expect([...EXTERNAL_STEER_REJECTION_REASONS]).toEqual([
      'turn-already-completed',
      'not-supported',
      'session-lost',
      'turn-not-steerable',
      'id-reused',
    ]);
  });

  it('validates the steer method contract', () => {
    expect(
      Value.Check(ExternalAgentSteerParamsSchema, {
        sessionId: 'session-1',
        nativeTurnId: 'turn-1',
        clientMessageId: 'steer-1',
        input: 'actually use the existing helper',
      })
    ).toBe(true);
    expect(Value.Check(ExternalAgentSteerResultSchema, { accepted: true })).toBe(true);
    for (const reasonCode of EXTERNAL_STEER_REJECTION_REASONS) {
      expect(Value.Check(ExternalAgentSteerResultSchema, { accepted: false, reasonCode })).toBe(
        true
      );
    }
  });

  it('keeps the result a closed union — no reasonCode beside acceptance, no accepted flag missing', () => {
    expect(
      Value.Check(ExternalAgentSteerResultSchema, {
        accepted: true,
        reasonCode: 'turn-not-steerable',
      })
    ).toBe(false);
    expect(Value.Check(ExternalAgentSteerResultSchema, { accepted: false })).toBe(false);
    expect(
      Value.Check(ExternalAgentSteerResultSchema, { accepted: false, reasonCode: 'made-up' })
    ).toBe(false);
  });

  it('rejects an unrecognized reasonCode', () => {
    expect(Value.Check(ExternalSteerRejectionReasonSchema, 'turn-already-completed')).toBe(true);
    expect(Value.Check(ExternalSteerRejectionReasonSchema, 'made-up')).toBe(false);
  });
});

describe('the neutral event contract', () => {
  const valid: readonly ExternalAgentEvent[] = [
    { type: 'session_started', sessionId: 'thread-1', resumed: false },
    { type: 'text_delta', text: 'hello' },
    { type: 'reasoning_started' },
    { type: 'reasoning_ended' },
    { type: 'reasoning_delta', text: 'thinking' },
    {
      type: 'activity_started',
      callId: 'call-1',
      activity: { name: 'shell', kind: 'command', title: 'ls -la' },
    },
    { type: 'activity_updated', callId: 'call-1', update: { detail: 'still running' } },
    { type: 'activity_completed', callId: 'call-1', result: { status: 'completed' } },
    {
      type: 'approval_requested',
      request: {
        requestId: 'req-1',
        kind: 'command',
        title: 'Run `rm -rf build`',
        options: [{ id: 'approve', rawLabel: 'Yes, run it', isDestructive: true }],
        expiresAtMs: 1_700_000_000_000,
      },
    },
    {
      type: 'approval_resolved',
      requestId: 'req-1',
      decision: { optionId: 'approve', source: 'user' },
    },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } },
    {
      type: 'thread_usage',
      usage: {
        last: { inputTokens: 10, outputTokens: 3 },
        total: { inputTokens: 100, outputTokens: 30 },
      },
    },
    {
      type: 'account_limits',
      limits: {
        targetId: 'codex',
        windows: [{ usedPercent: 40, resetsAtMs: 1_700_000_000_000 }],
        observedAtMs: 1_700_000_000_000,
      },
    },
    {
      type: 'commands_available',
      // One vendor sends help text with each name and the other sends names
      // alone, so both halves of that disagreement are represented here.
      commands: [{ name: 'review', description: 'Read a diff' }, { name: 'compact' }],
    },
    // Emitted immediately before `completed`, never instead of it, so a hub
    // that predates it still ends the turn on the terminal it already knows.
    { type: 'cancelled' },
    { type: 'completed' },
    { type: 'error', error: { code: 'stream_closed', message: 'The process exited.' } },
  ];

  it('validates every member', () => {
    for (const event of valid) {
      expect(Value.Check(ExternalAgentEventSchema, event)).toBe(true);
    }
  });

  it('covers every declared event type exactly once', () => {
    expect(new Set(valid.map((event) => event.type)).size).toBe(
      ExternalAgentEventSchema.anyOf.length
    );
  });

  it('leaves no room for an event that asks MangoStudio to execute something', () => {
    // Activity is observational. A shape carrying a MangoStudio tool call would
    // have to be added deliberately; it cannot arrive through an extra field.
    expect(
      Value.Check(ExternalAgentEventSchema, {
        type: 'activity_started',
        callId: 'call-1',
        activity: { name: 'shell', kind: 'command', title: 'ls' },
        execute: { tool: 'bash', args: ['rm', '-rf', '/'] },
      })
    ).toBe(false);
  });

  it('requires an approval to carry at least one vendor option and an expiry', () => {
    expect(
      Value.Check(ExternalAgentEventSchema, {
        type: 'approval_requested',
        request: {
          requestId: 'req-1',
          kind: 'command',
          title: 'Run it',
          options: [],
          expiresAtMs: 1,
        },
      })
    ).toBe(false);
    expect(
      Value.Check(ExternalAgentEventSchema, {
        type: 'approval_requested',
        request: {
          requestId: 'req-1',
          kind: 'command',
          title: 'Run it',
          options: [{ id: 'approve', isDestructive: false }],
        },
      })
    ).toBe(false);
  });
});

describe('bounded vendor text', () => {
  it('truncates on a code-point boundary and never splits a surrogate pair', () => {
    const limit = EXTERNAL_TEXT_LIMITS.activityName;
    const emoji = '👩‍🚀'.repeat(200);

    const { text, truncated } = boundVendorText(emoji, 'activityName');

    expect(truncated).toBe(true);
    expect([...text]).toHaveLength(limit);
    // A lone surrogate survives `String.length` but not a UTF-8 round trip.
    expect(Buffer.from(text, 'utf8').toString('utf8')).toBe(text);
    expect(text).not.toMatch(/[\uD800-\uDFFF]$/);
  });

  it('keeps text that fits, untouched and unmarked', () => {
    expect(boundVendorText('apply_patch', 'activityName')).toEqual({
      text: 'apply_patch',
      truncated: false,
    });
  });

  it('strips a lone surrogate the vendor sent, rather than letting UTF-8 rewrite it', () => {
    // Short enough that truncation cannot be what removed it, and paired with a
    // well-formed astral character to prove only the unpaired half goes.
    const raw = `sess-${String.fromCharCode(0xd800)}42🙂`;

    const { text, truncated } = boundVendorText(raw, 'vendorId');

    expect(text).toBe('sess-42🙂');
    expect(truncated).toBe(true);
    // The guarantee the caps exist for: what we persist is what comes back.
    expect(Buffer.from(text, 'utf8').toString('utf8')).toBe(text);
  });

  it('strips an unpaired low surrogate too', () => {
    const { text, truncated } = boundVendorText(`call-${String.fromCharCode(0xdfff)}1`, 'vendorId');

    expect(text).toBe('call-1');
    expect(truncated).toBe(true);
  });

  it('strips control characters while keeping tab and newline', () => {
    // Built from code points rather than typed literally: a raw ESC in a test
    // file is invisible in review, which is the opposite of the point.
    const bell = String.fromCodePoint(0x07);
    const escapeChar = String.fromCodePoint(0x1b);
    const c1 = String.fromCodePoint(0x9b);
    const raw = `first\tcolumn\nsecond${bell}${escapeChar}[31mred${c1}\r`;

    const { text, truncated } = boundVendorText(raw, 'title');

    expect(text).toBe('first\tcolumn\nsecond[31mred');
    expect(truncated).toBe(true);
  });

  it('strips bidirectional overrides, which make a label read as its reverse', () => {
    const rightToLeftOverride = String.fromCodePoint(0x202e);
    const popDirectionalFormatting = String.fromCodePoint(0x202c);
    const firstStrongIsolate = String.fromCodePoint(0x2068);
    const popDirectionalIsolate = String.fromCodePoint(0x2069);
    const raw = `${rightToLeftOverride}hctap-suoregnad${popDirectionalFormatting} run${firstStrongIsolate} me${popDirectionalIsolate}`;

    const { text, truncated } = boundVendorText(raw, 'title');

    expect(text).toBe('hctap-suoregnad run me');
    expect(truncated).toBe(true);
  });

  it('applies each field its own documented bound', () => {
    expect(EXTERNAL_TEXT_LIMITS).toMatchObject({
      activityName: 128,
      title: 256,
      detail: 4096,
      approvalOptionLabel: 128,
      sessionTitle: 256,
      errorMessage: 2048,
    });

    for (const limit of Object.keys(
      EXTERNAL_TEXT_LIMITS
    ) as (keyof typeof EXTERNAL_TEXT_LIMITS)[]) {
      const { text } = boundVendorText('x'.repeat(10_000), limit);
      expect(text).toHaveLength(EXTERNAL_TEXT_LIMITS[limit]);
    }
  });

  it('accepts a fully bounded astral string through the schema that carries it', () => {
    // The schema counts UTF-16 units and the bound counts code points, so a
    // name of 128 two-unit code points must still validate.
    const name = boundVendorText('🙂'.repeat(400), 'activityName').text;

    expect(
      Value.Check(ExternalAgentEventSchema, {
        type: 'activity_started',
        callId: 'call-1',
        activity: { name, kind: 'other', title: '' },
      })
    ).toBe(true);
  });

  it('accepts astral vendor text on account-limits fields via VendorText', () => {
    const balance = boundVendorText(
      '🙂'.repeat(EXTERNAL_TEXT_LIMITS.accountLabel),
      'accountLabel'
    ).text;
    const planType = boundVendorText('プラン🙂', 'accountLabel').text;

    expect(
      Value.Check(ExternalAccountLimitsSchema, {
        targetId: 'codex',
        windows: [{ usedPercent: 10 }],
        credits: { balance },
        planType,
        observedAtMs: 1,
      })
    ).toBe(true);
  });

  it('bounds a whole turn, not only one event at a time', () => {
    expect(EXTERNAL_TURN_PAYLOAD_MAX_BYTES).toBeGreaterThan(EXTERNAL_TEXT_LIMITS.detail);
  });
});

describe('persisted permission values', () => {
  it('reads a recognized value back as itself', () => {
    expect(normalizePermissionLevel('full-access')).toEqual({
      value: 'full-access',
      recognized: true,
    });
    expect(normalizeApprovalRouting('auto-review')).toEqual({
      value: 'auto-review',
      recognized: true,
    });
  });

  it('resolves anything unrecognized towards the restrictive end', () => {
    // A downgrade leaves rows this build never wrote. Reading them as the
    // permissive end would hand an agent freedom the user never chose.
    for (const stored of ['yolo', 'danger-full-access', '', null, undefined]) {
      expect(normalizePermissionLevel(stored)).toEqual({ value: 'read-only', recognized: false });
      expect(normalizeApprovalRouting(stored)).toEqual({ value: 'user', recognized: false });
    }
  });
});
