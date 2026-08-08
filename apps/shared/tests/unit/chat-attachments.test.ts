import { describe, expect, it } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import {
  ChatAttachmentKindSchema,
  ChatAttachmentSchema,
  UploadChatAttachmentResponseSchema,
} from '../../src/chat';
import {
  GENERATION_ATTACHMENT_IDS_MAX_ITEMS,
  GENERATION_MODEL_ID_MAX_LENGTH,
  GENERATION_PROMPT_MAX_LENGTH,
  GenerateTextBodySchema,
  RespondStreamBodySchema,
} from '../../src/generation';

const attachment = {
  id: 'attachment-contract-1',
  chatId: 'chat-contract-1',
  messageId: null,
  originalName: 'reference.png',
  mimeType: 'image/png',
  sizeBytes: 128,
  kind: 'image',
  url: '/uploads/Reference_chat-contract-1/1710000000000/reference.png',
  createdAt: 1710000000000,
};

describe('chat attachment contracts', () => {
  it('validates every supported attachment kind', () => {
    for (const kind of ['image', 'text', 'pdf', 'data', 'unknown']) {
      expect(Value.Check(ChatAttachmentKindSchema, kind)).toBe(true);
    }
  });

  it('rejects unsupported attachment kinds', () => {
    expect(Value.Check(ChatAttachmentKindSchema, 'video')).toBe(false);
  });

  it('validates upload responses with attachment metadata', () => {
    expect(Value.Check(ChatAttachmentSchema, attachment)).toBe(true);
    expect(Value.Check(UploadChatAttachmentResponseSchema, { attachment })).toBe(true);
  });

  it('allows text generation requests to reference uploaded attachments', () => {
    const body = {
      chatId: 'chat-contract-1',
      prompt: 'Summarize the attachment.',
      attachmentIds: ['attachment-contract-1'],
      model: 'text-model-contract',
    };

    expect(Value.Check(GenerateTextBodySchema, body)).toBe(true);
  });

  it('allows streaming text requests to reference uploaded attachments', () => {
    const body = {
      chatId: 'chat-contract-1',
      prompt: 'Use this attachment.',
      attachmentIds: ['attachment-contract-1'],
      maxToolIterations: 1_000,
    };

    expect(Value.Check(RespondStreamBodySchema, body)).toBe(true);
  });

  it('allows streaming text requests to name the agent that runs the turn', () => {
    const body = {
      chatId: 'chat-contract-1',
      prompt: 'Use the selected agent.',
      agentId: 'explore',
    };

    expect(Value.Check(RespondStreamBodySchema, body)).toBe(true);
  });

  it('rejects the retired chat agent id on streaming text requests', () => {
    const body = {
      chatId: 'chat-contract-1',
      prompt: 'Use the selected agent.',
      agentId: 'chat',
    };

    expect(Value.Check(RespondStreamBodySchema, body)).toBe(false);
  });

  it('rejects oversized text generation payload fields', () => {
    expect(
      Value.Check(GenerateTextBodySchema, {
        chatId: 'chat-contract-1',
        prompt: 'x'.repeat(GENERATION_PROMPT_MAX_LENGTH + 1),
      })
    ).toBe(false);

    expect(
      Value.Check(GenerateTextBodySchema, {
        chatId: 'chat-contract-1',
        prompt: 'Hello',
        model: 'x'.repeat(GENERATION_MODEL_ID_MAX_LENGTH + 1),
      })
    ).toBe(false);
  });

  it('rejects oversized streaming attachment arrays', () => {
    expect(
      Value.Check(RespondStreamBodySchema, {
        chatId: 'chat-contract-1',
        prompt: 'Use these attachments.',
        attachmentIds: Array.from(
          { length: GENERATION_ATTACHMENT_IDS_MAX_ITEMS + 1 },
          (_, index) => `attachment-${index}`
        ),
      })
    ).toBe(false);
  });
});
