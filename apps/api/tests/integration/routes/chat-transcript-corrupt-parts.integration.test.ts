/**
 * One damaged `messages.parts` cell must degrade that message only. Before the
 * fix the unguarded `JSON.parse` in the transcript mapper threw, and the whole
 * chat came back as HTTP 500.
 */

import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { getDb } from '../../../src/db/database';
import { chatRoutes } from '../../../src/modules/chats/http/chat-routes';
import { insertTestChat, insertTestUser, type UserFixture } from '../../support/factories';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';

interface TranscriptMessage {
  id: string;
  text: string;
  parts?: unknown;
}

interface Transcript {
  messages: TranscriptMessage[];
  nextCursor: string | null;
}

const CORRUPT_VALUE = '{not json';
const VALID_PARTS = JSON.stringify([{ type: 'text', text: 'valid parts text' }]);

let TEST_USER!: UserFixture;
let restoreAuth: (() => void) | null = null;
let sequence = 0;

beforeAll(async () => {
  TEST_USER = await insertTestUser();
});

afterEach(() => {
  restoreAuth?.();
  restoreAuth = null;
});

/** Named fake for the hub log: collects every structured line written to `console.warn`. */
class WarnCapture {
  readonly lines: string[] = [];
  private readonly original = console.warn;
  private readonly originalFlag = process.env.MANGOSTUDIO_DIAGNOSTIC_LOGS;

  start(): void {
    // The test lanes silence diagnostic logs; this fake needs them on.
    process.env.MANGOSTUDIO_DIAGNOSTIC_LOGS = '1';
    console.warn = (...args: unknown[]) => {
      this.lines.push(args.map(String).join(' '));
    };
  }

  stop(): void {
    console.warn = this.original;
    if (this.originalFlag === undefined) delete process.env.MANGOSTUDIO_DIAGNOSTIC_LOGS;
    else process.env.MANGOSTUDIO_DIAGNOSTIC_LOGS = this.originalFlag;
  }
}

async function seedChatWithCorruptMiddleRow(corruptParts: string) {
  sequence += 1;
  const chat = await insertTestChat(TEST_USER.id);
  const base = Date.now() + sequence * 1_000;
  const ids = [`first-${chat.id}`, `corrupt-${chat.id}`, `last-${chat.id}`];
  await getDb()
    .insertInto('messages')
    .values([
      {
        id: ids[0],
        chatId: chat.id,
        role: 'user',
        text: 'first text',
        timestamp: base,
        isGenerating: 0,
        interactionMode: 'agent',
        parts: VALID_PARTS,
      },
      {
        id: ids[1],
        chatId: chat.id,
        role: 'ai',
        text: 'corrupt row text',
        timestamp: base + 1,
        isGenerating: 0,
        interactionMode: 'agent',
        parts: corruptParts,
      },
      {
        id: ids[2],
        chatId: chat.id,
        role: 'user',
        text: 'last text',
        timestamp: base + 2,
        isGenerating: 0,
        interactionMode: 'agent',
        parts: VALID_PARTS,
      },
    ])
    .execute();
  return { chatId: chat.id, ids };
}

function requestTranscript(chatId: string): Promise<Response> {
  const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, chatRoutes);
  restoreAuth = restore;
  return app.handle(new Request(`http://localhost/chats/${chatId}/messages?limit=25`));
}

function assertTranscriptServed(response: Response): void {
  if (response.status === 200) return;
  throw new Error(`expected transcript status: 200 | received: ${response.status}`);
}

describe('GET /chats/:id/messages with a corrupt parts cell', () => {
  it.each([
    ['invalid JSON', CORRUPT_VALUE],
    ['JSON that is not an array', '{"type":"text"}'],
    ['an array holding a non-part element', '[null]'],
  ])('serves every message when one row holds %s', async (_label, corruptParts) => {
    const { chatId, ids } = await seedChatWithCorruptMiddleRow(corruptParts);

    const response = await requestTranscript(chatId);

    assertTranscriptServed(response);
    const body = (await response.json()) as Transcript;
    expect(body.messages.map((message) => message.id)).toEqual(ids);
    expect(body.messages.map((message) => message.text)).toEqual([
      'first text',
      'corrupt row text',
      'last text',
    ]);
    expect(body.messages[0]?.parts).toEqual(JSON.parse(VALID_PARTS));
    expect(body.messages[1]?.parts).toBeUndefined();
    expect(body.messages[2]?.parts).toEqual(JSON.parse(VALID_PARTS));
  });

  it('logs a warning naming the message id without echoing the stored value', async () => {
    const { chatId, ids } = await seedChatWithCorruptMiddleRow(CORRUPT_VALUE);
    const capture = new WarnCapture();
    capture.start();
    let response: Response;
    try {
      response = await requestTranscript(chatId);
    } finally {
      capture.stop();
    }

    assertTranscriptServed(response);
    const warning = capture.lines.find((line) => line.includes('corrupt_message_parts'));
    if (!warning) {
      throw new Error(
        `expected warning: corrupt_message_parts | received: ${JSON.stringify(capture.lines)}`
      );
    }
    expect(warning).toContain(ids[1]);
    expect(warning).not.toContain(CORRUPT_VALUE);
  });
});
