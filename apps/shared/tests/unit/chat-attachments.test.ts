import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  ChatAttachmentKindSchema,
  ChatAttachmentSchema,
  UploadChatAttachmentResponseSchema,
} from '../../src/chat';
import { GenerateTextBodySchema, RespondStreamBodySchema } from '../../src/generation';

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

  it('allows streaming text requests to include agent mode metadata', () => {
    const body = {
      chatId: 'chat-contract-1',
      prompt: 'Use the selected agent.',
      agentMode: 'agent',
      agentId: 'default',
    };

    expect(Value.Check(RespondStreamBodySchema, body)).toBe(true);
  });
});
