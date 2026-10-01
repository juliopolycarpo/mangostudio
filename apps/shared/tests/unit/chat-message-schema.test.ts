import { describe, expect, it } from 'bun:test';
import type { TSchema } from 'typebox';
import Value from 'typebox/value';
import { type Message, MessageSchema, MessagesPageSchema } from '../../src/chat';

/** Fails with the schema's own error list instead of a bare `false`. */
function expectValid(schema: TSchema, value: unknown): void {
  if (Value.Check(schema, value)) return;
  const errors = [...Value.Errors(schema, value)].map((e) => `${e.instancePath}: ${e.message}`);
  throw new Error(`expected value: valid | received errors: ${JSON.stringify(errors)}`);
}

function expectInvalid(schema: TSchema, value: unknown, why: string): void {
  if (!Value.Check(schema, value)) return;
  throw new Error(`expected value: invalid (${why}) | received: accepted ${JSON.stringify(value)}`);
}

/** A row as the repository returns it for a legacy message: empty columns are `null`. */
const storedRow: Message = {
  id: 'message-1',
  chatId: 'chat-1',
  role: 'ai',
  text: 'hello',
  imageUrl: null,
  referenceImage: null,
  timestamp: 1_700_000_000_000,
  isGenerating: false,
  generationTime: null,
  modelName: null,
  interactionMode: 'chat',
  providerState: null,
};

describe('MessageSchema', () => {
  it('accepts a stored row whose empty columns are null and that has no parts', () => {
    expectValid(MessageSchema, storedRow);
  });

  it('accepts a message built in the client, where empty fields are absent', () => {
    expectValid(MessageSchema, {
      id: 'optimistic-1',
      chatId: 'chat-1',
      role: 'user',
      text: 'draft',
      timestamp: 1,
      agentId: 'default',
      agentName: 'Default',
    });
  });

  it('keeps parts permissive: an unknown type and unknown fields are valid', () => {
    expectValid(MessageSchema, {
      ...storedRow,
      parts: [
        { type: 'legacy_widget', payload: { nested: [1] }, note: null },
        { type: 'text', text: 'old', annotations: ['kept'] },
      ],
    });
  });

  it('rejects a part that has no string type', () => {
    expectInvalid(
      MessageSchema,
      { ...storedRow, parts: [{ text: 'no type' }] },
      'part without type'
    );
    expectInvalid(MessageSchema, { ...storedRow, parts: [{ type: 3 }] }, 'non-string part type');
  });

  it('rejects a column of the wrong type', () => {
    expectInvalid(MessageSchema, { ...storedRow, role: 'assistant' }, 'role outside user | ai');
    expectInvalid(MessageSchema, { ...storedRow, isGenerating: 1 }, 'isGenerating as an integer');
    expectInvalid(MessageSchema, { ...storedRow, timestamp: '1' }, 'timestamp as a string');
  });

  it('describes a transcript page row by row', () => {
    expectValid(MessagesPageSchema, { messages: [storedRow], nextCursor: null, contextInfo: null });
    expectInvalid(
      MessagesPageSchema,
      { messages: [{ ...storedRow, text: 1 }], nextCursor: null },
      'row with a numeric text'
    );
  });
});
