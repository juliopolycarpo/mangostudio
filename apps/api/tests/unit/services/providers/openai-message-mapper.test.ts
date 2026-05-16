import { describe, expect, it } from 'bun:test';
import {
  buildChatMessages,
  buildOpenAIResponsesUserMessage,
  buildResponsesInput,
} from '../../../../src/services/providers/openai/message-mapper';
import type {
  ProviderRuntimeAttachment,
  TextGenerationRequest,
} from '../../../../src/services/providers/types';

function makeAttachment(
  kind: ProviderRuntimeAttachment['kind'],
  mimeType: string,
  originalName = 'file'
): ProviderRuntimeAttachment {
  return {
    id: 'att-1',
    originalName,
    mimeType,
    sizeBytes: 4,
    kind,
    bytes: new Uint8Array([1, 2, 3, 4]),
  };
}

function baseReq(overrides: Partial<TextGenerationRequest> = {}): TextGenerationRequest {
  return {
    userId: 'u1',
    modelName: 'gpt-4o',
    prompt: 'Hello',
    history: [],
    ...overrides,
  };
}

describe('buildChatMessages', () => {
  it('returns a single user message when no system prompt or history', () => {
    const result = buildChatMessages(baseReq());
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ role: 'user', content: 'Hello' });
  });

  it('prepends system prompt when present', () => {
    const result = buildChatMessages(baseReq({ systemPrompt: 'Be helpful' }));
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ role: 'system', content: 'Be helpful' });
    expect(result[1]).toEqual({ role: 'user', content: 'Hello' });
  });

  it('ignores whitespace-only system prompt', () => {
    const result = buildChatMessages(baseReq({ systemPrompt: '   ' }));
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ role: 'user', content: 'Hello' });
  });

  it('maps history roles correctly', () => {
    const result = buildChatMessages(
      baseReq({
        history: [
          { role: 'user', text: 'Q1' },
          { role: 'ai', text: 'A1' },
        ],
      })
    );
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ role: 'user', content: 'Q1' });
    expect(result[1]).toEqual({ role: 'assistant', content: 'A1' });
    expect(result[2]).toEqual({ role: 'user', content: 'Hello' });
  });

  it('wraps prompt and image attachments in content array', () => {
    const image = makeAttachment('image', 'image/png', 'pic.png');
    const result = buildChatMessages(
      baseReq({
        prompt: 'Describe this',
        attachments: [image],
        modelCapabilities: {
          text: true,
          image: true,
          streaming: true,
          imageInput: true,
          fileAttachments: true,
        },
      })
    );
    expect(result).toHaveLength(1);
    const userMsg = result[0] as unknown as Record<string, unknown>;
    expect(userMsg.role).toBe('user');
    expect(Array.isArray(userMsg.content)).toBe(true);
    const content = userMsg.content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({ type: 'text', text: 'Describe this' });
    expect(content[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,AQIDBA==' },
    });
  });

  it('appends unsupported attachment notes as text parts', () => {
    const pdf = makeAttachment('pdf', 'application/pdf', 'doc.pdf');
    const result = buildChatMessages(
      baseReq({
        prompt: 'Read this',
        attachments: [pdf],
        modelCapabilities: { text: true, image: true, streaming: true, fileAttachments: true },
      })
    );
    const content = (result[0] as unknown as Record<string, unknown>).content as Array<
      Record<string, unknown>
    >;
    const notePart = content.find(
      (c) => c.type === 'text' && (c.text as string).includes('was not sent')
    );
    expect(notePart).toBeTruthy();
  });
});

describe('buildResponsesInput', () => {
  it('returns only the user message when history is empty', () => {
    const result = buildResponsesInput(baseReq());
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ role: 'user', content: 'Hello' });
  });

  it('maps history before the user message', () => {
    const result = buildResponsesInput(
      baseReq({
        history: [
          { role: 'user', text: 'Q' },
          { role: 'ai', text: 'A' },
        ],
      })
    );
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ role: 'user', content: 'Q' });
    expect(result[1]).toEqual({ role: 'assistant', content: 'A' });
    expect(result[2]).toEqual({ role: 'user', content: 'Hello' });
  });

  it('returns empty prompt user message when prompt is empty and no attachments', () => {
    const result = buildResponsesInput(baseReq({ prompt: '' }));
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ role: 'user', content: '' });
  });
});

describe('buildOpenAIResponsesUserMessage', () => {
  it('returns plain text when no attachments', () => {
    const result = buildOpenAIResponsesUserMessage({ prompt: 'Hi' });
    expect(result).toEqual({ role: 'user', content: 'Hi' });
  });

  it('returns null when no prompt and no attachments', () => {
    const result = buildOpenAIResponsesUserMessage({});
    expect(result).toBeNull();
  });

  it('embeds an image attachment as input_image', () => {
    const image = makeAttachment('image', 'image/png', 'pic.png');
    const result = buildOpenAIResponsesUserMessage({
      prompt: 'Describe',
      attachments: [image],
      modelCapabilities: {
        text: true,
        image: true,
        streaming: true,
        imageInput: true,
        fileAttachments: true,
      },
    });
    expect(result).toEqual({
      role: 'user',
      content: [
        { type: 'input_text', text: 'Describe' },
        { type: 'input_image', image_url: 'data:image/png;base64,AQIDBA==' },
      ],
    });
  });

  it('embeds a PDF attachment as input_file', () => {
    const pdf = makeAttachment('pdf', 'application/pdf', 'doc.pdf');
    const result = buildOpenAIResponsesUserMessage({
      prompt: 'Summarize',
      attachments: [pdf],
      modelCapabilities: {
        text: true,
        image: true,
        streaming: true,
        pdfInput: true,
        fileAttachments: true,
      },
    });
    const content = (result as Record<string, unknown>).content as Array<Record<string, unknown>>;
    expect(content[1]).toEqual({
      type: 'input_file',
      filename: 'doc.pdf',
      file_data: 'data:application/pdf;base64,AQIDBA==',
    });
  });

  it('embeds a text attachment as input_file', () => {
    const txt = makeAttachment('text', 'text/plain', 'notes.txt');
    const result = buildOpenAIResponsesUserMessage({
      prompt: 'Review',
      attachments: [txt],
      modelCapabilities: {
        text: true,
        image: true,
        streaming: true,
        textFileInput: true,
        fileAttachments: true,
      },
    });
    const content = (result as Record<string, unknown>).content as Array<Record<string, unknown>>;
    expect(content[1]).toEqual({
      type: 'input_file',
      filename: 'notes.txt',
      file_data: 'data:text/plain;base64,AQIDBA==',
    });
  });

  it('skips unsupported attachment kinds', () => {
    const unsupported = makeAttachment('image', 'image/webp', 'pic.webp');
    const result = buildOpenAIResponsesUserMessage({
      prompt: 'Look',
      attachments: [unsupported],
      modelCapabilities: { text: true, image: true, streaming: true, fileAttachments: false },
    });
    const content = (result as Record<string, unknown>).content as Array<Record<string, unknown>>;
    expect(content.some((c) => c.type === 'input_image')).toBe(false);
  });

  it('omits prompt when it is only whitespace', () => {
    const result = buildOpenAIResponsesUserMessage({ prompt: '   ' });
    expect(result).toEqual({ role: 'user', content: '   ' });
  });
});
