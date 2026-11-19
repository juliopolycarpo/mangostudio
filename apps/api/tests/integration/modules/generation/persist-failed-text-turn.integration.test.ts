/**
 * `persistFailedTextTurn` writes the assistant side of a one-shot text turn that
 * failed after its user message was saved. These tests read the row back and
 * compare it with what the streaming route records for the same two endings.
 */

import { describe, expect, it } from 'bun:test';

import type { TurnCheckpointPart } from '@mangostudio/shared/turn-recovery';

import { getDb } from '../../../../src/db/database';
import { persistFailedTextTurn } from '../../../../src/modules/generation/application/persist-failed-text-turn';
import { insertTestChat, insertTestUser } from '../../../support/factories';

interface FailedTurnRow {
  readonly text: string;
  readonly isGenerating: number;
  readonly role: string;
  readonly parts: unknown[];
}

async function readAssistantRows(chatId: string): Promise<FailedTurnRow[]> {
  const rows = await getDb()
    .selectFrom('messages')
    .select(['text', 'isGenerating', 'role', 'parts'])
    .where('chatId', '=', chatId)
    .where('role', '=', 'ai')
    .execute();
  return rows.map((row) => ({
    text: row.text,
    isGenerating: Number(row.isGenerating),
    role: row.role,
    parts: row.parts ? (JSON.parse(row.parts) as unknown[]) : [],
  }));
}

function checkpointOf(row: FailedTurnRow | undefined): TurnCheckpointPart | undefined {
  return row?.parts.find(
    (part): part is TurnCheckpointPart =>
      typeof part === 'object' &&
      part !== null &&
      (part as { type?: string }).type === 'turn_checkpoint'
  );
}

async function seedChat(): Promise<{ chatId: string; userId: string }> {
  const user = await insertTestUser();
  const chat = await insertTestChat(user.id);
  return { chatId: chat.id, userId: user.id };
}

describe('persistFailedTextTurn', () => {
  it('records a provider failure as an assistant error part with an interrupted checkpoint', async () => {
    const { chatId, userId } = await seedChat();

    await persistFailedTextTurn(
      {
        chatId,
        userId,
        provider: 'openai-compatible',
        modelId: 'failed-turn-model',
        startTime: Date.now() - 1_500,
        error: new Error('vendor exploded'),
      },
      getDb()
    );

    const [row, ...rest] = await readAssistantRows(chatId);
    expect(rest, `expected one assistant row | received ${rest.length + 1}`).toHaveLength(0);
    expect(row?.isGenerating, 'expected a settled row (isGenerating 0)').toBe(0);
    expect(row?.text, 'expected the failure text as message text').toBe('vendor exploded');
    expect(row?.parts).toContainEqual({ type: 'error', text: 'vendor exploded' });
    expect(checkpointOf(row)).toMatchObject({
      status: 'interrupted',
      reasonCode: 'provider_error',
      provider: 'openai-compatible',
      modelName: 'failed-turn-model',
    });
  });

  it('records a client disconnect the way the streaming route does: interrupted, no error part', async () => {
    const { chatId, userId } = await seedChat();
    const clientDisconnect = new AbortController();
    clientDisconnect.abort('client_disconnect');

    await persistFailedTextTurn(
      {
        chatId,
        userId,
        provider: 'openai-compatible',
        modelId: 'failed-turn-model',
        startTime: Date.now(),
        error: new Error('This operation was aborted'),
        signal: clientDisconnect.signal,
      },
      getDb()
    );

    const [row] = await readAssistantRows(chatId);
    expect(row?.text, 'expected no message text after an abort').toBe('');
    expect(
      row?.parts.some((part) => (part as { type?: string }).type === 'error'),
      'expected no error part after an abort'
    ).toBe(false);
    expect(checkpointOf(row)).toMatchObject({
      status: 'interrupted',
      reasonCode: 'client_disconnect',
    });
  });

  it('does not throw when the row cannot be written', async () => {
    await expect(
      persistFailedTextTurn(
        {
          chatId: 'chat-that-does-not-exist',
          userId: 'user-that-does-not-exist',
          provider: 'openai-compatible',
          modelId: 'failed-turn-model',
          startTime: Date.now(),
          error: new Error('vendor exploded'),
        },
        getDb()
      )
    ).resolves.toBeUndefined();
  });
});
