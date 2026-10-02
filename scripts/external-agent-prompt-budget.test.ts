import { expect, test } from 'bun:test';
import {
  EXTERNAL_ATTACHMENT_MAX_BYTES,
  EXTERNAL_TURN_MAX_ATTACHMENTS,
  ExternalAgentAttachmentSchema,
  ExternalAgentOpenResultSchema,
  ExternalAgentTurnParamsSchema,
  NO_EXTERNAL_AGENT_CAPABILITIES,
} from '@mangostudio/shared/external-agents';
import {
  GENERATION_PROMPT_MAX_LENGTH,
  RespondStreamBodySchema,
} from '@mangostudio/shared/generation';
import Value from 'typebox/value';
import limits from '../crates/mangostudio-runtime/src/external_agents/adapter/fixtures/prompt-limits.json';

const configuration = { level: 'default', routing: 'user', workspaceRoots: [] };

test('the adapter budget fixture pins both accepted prompt contracts and attachment limits', () => {
  expect(limits.attachmentBytes).toBe(EXTERNAL_ATTACHMENT_MAX_BYTES);
  expect(limits.attachments).toBe(EXTERNAL_TURN_MAX_ATTACHMENTS);
  expect(limits.httpPromptUnits).toBe(GENERATION_PROMPT_MAX_LENGTH);
  expect(
    Value.Check(RespondStreamBodySchema, {
      chatId: 'synthetic',
      prompt: '\0'.repeat(limits.httpPromptUnits),
    })
  ).toBe(true);
  expect(
    Value.Check(RespondStreamBodySchema, {
      chatId: 'synthetic',
      prompt: '\0'.repeat(limits.httpPromptUnits + 1),
    })
  ).toBe(false);
  const attachment = {
    id: '\0'.repeat(limits.attachmentIdUnits),
    originalName: '\0'.repeat(limits.attachmentNameUnits),
    mimeType: '\0'.repeat(limits.attachmentMimeUnits),
    kind: 'text',
    sizeBytes: limits.attachmentBytes,
    bytesBase64: Buffer.alloc(limits.attachmentBytes).toString('base64'),
  };
  expect(Value.Check(ExternalAgentAttachmentSchema, attachment)).toBe(true);
  for (const [field, maximum] of [
    ['id', limits.attachmentIdUnits],
    ['originalName', limits.attachmentNameUnits],
    ['mimeType', limits.attachmentMimeUnits],
  ] as const) {
    expect(
      Value.Check(ExternalAgentAttachmentSchema, {
        ...attachment,
        [field]: '\0'.repeat(maximum + 1),
      })
    ).toBe(false);
  }
  const turn = {
    sessionId: 'synthetic',
    clientMessageId: 'synthetic-turn',
    configuration,
    input: '\0'.repeat(limits.runtimePromptUnits),
    attachments: Array.from({ length: limits.attachments }, (_, index) => ({
      ...attachment,
      id: `${'\0'.repeat(limits.attachmentIdUnits - 1)}${String.fromCharCode(index + 1)}`,
    })),
  };
  expect(Value.Check(ExternalAgentTurnParamsSchema, turn)).toBe(true);
  expect(Value.Check(ExternalAgentTurnParamsSchema, { ...turn, input: `${turn.input}\0` })).toBe(
    false
  );
});

test('successful Hub open IDs are bounded separately from raw SDK opens', () => {
  const open = {
    nativeSessionId: '\0'.repeat(limits.nativeSessionIdUnits),
    resumed: false,
    effectiveConfiguration: configuration,
    capabilities: NO_EXTERNAL_AGENT_CAPABILITIES,
  };
  expect(Value.Check(ExternalAgentOpenResultSchema, open)).toBe(true);
  expect(
    Value.Check(ExternalAgentOpenResultSchema, {
      ...open,
      nativeSessionId: `${open.nativeSessionId}\0`,
    })
  ).toBe(false);
});
