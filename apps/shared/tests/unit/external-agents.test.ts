import { describe, expect, it } from 'bun:test';
import { Value } from '@sinclair/typebox/value';

import { ChatRunnerConfigurationSchema } from '../../src/chat';
import {
  boundVendorText,
  EXTERNAL_AGENT_TARGET_IDS,
  EXTERNAL_AGENT_UNAVAILABLE_REASONS,
  EXTERNAL_TEXT_LIMITS,
  EXTERNAL_TURN_PAYLOAD_MAX_BYTES,
  type ExternalAgentDescriptor,
  ExternalAgentDescriptorListResponseSchema,
  ExternalAgentDescriptorSchema,
  type ExternalAgentEvent,
  ExternalAgentEventSchema,
  type ExternalAgentTargetId,
  ExternalAgentTargetIdSchema,
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
  unavailableReason: 'not-yet-available',
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
      'not-yet-available',
    ]);
  });
});

describe('the neutral event contract', () => {
  const valid: readonly ExternalAgentEvent[] = [
    { type: 'session_started', sessionId: 'thread-1', resumed: false },
    { type: 'text_delta', text: 'hello' },
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
