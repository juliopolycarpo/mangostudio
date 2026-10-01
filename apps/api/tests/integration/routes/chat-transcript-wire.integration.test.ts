/**
 * Pins the exact bytes of `GET /chats/:id/messages`.
 *
 * The transcript row schema describes what the route already sends: `null` for
 * an absent optional column, parts of any `type` (older releases wrote shapes
 * the frontend normaliser still reads), and SQLite column order. Describing a
 * row must not re-serialise it, so the response text is compared as a string,
 * never as parsed JSON, against a golden captured before the schema existed.
 */

import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { getDb } from '../../../src/db/database';
import { chatRoutes } from '../../../src/modules/chats/http/chat-routes';
import { insertTestChat, insertTestUser, type UserFixture } from '../../support/factories';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';

const CHAT_ID = 'wire-fixture-chat';
const BASE = 1_700_000_000_000;

/** One part of every type the product writes, in the shape the current writer uses. */
const EVERY_PART_TYPE = [
  { type: 'text', text: 'hello', incomplete: true },
  { type: 'thinking', text: 'hmm', redacted: false },
  {
    type: 'tool_call',
    toolCallId: 'call-1',
    name: 'read_file',
    args: { path: 'a.txt' },
    execution: { status: 'completed' },
  },
  { type: 'tool_result', toolCallId: 'call-1', content: 'ok', isError: false },
  {
    type: 'generated_image',
    imageId: 'img-1',
    toolCallId: 'call-2',
    status: 'completed',
    prompt: 'a mango',
    imageUrl: '/images/img-1.png',
  },
  {
    type: 'mcp_media',
    toolCallId: 'call-3',
    serverSlug: 'srv',
    toolName: 'shot',
    kind: 'image',
    mimeType: 'image/png',
    url: '/images/m.png',
  },
  { type: 'question', toolCallId: 'call-4', questions: [] },
  { type: 'mcp_elicitation', requestId: 'req-1', serverSlug: 'srv', status: 'pending' },
  { type: 'todo', toolCallId: 'call-5', todos: [] },
  {
    type: 'subagent_trace',
    toolCallId: 'call-6',
    agentId: 'default',
    agentName: 'Default',
    status: 'completed',
    summary: 's',
    toolCallCount: 0,
    messages: [],
    tools: [],
  },
  { type: 'turn_checkpoint', version: 1 },
  {
    type: 'external_activity',
    targetId: 'codex',
    callId: 'c',
    name: 'Bash',
    kind: 'command',
    title: 'ls',
    status: 'completed',
  },
  {
    type: 'external_approval',
    targetId: 'codex',
    requestId: 'r',
    kind: 'command',
    title: 't',
    options: [],
    expiresAtMs: 1,
  },
  {
    type: 'external_steer',
    targetId: 'codex',
    clientMessageId: 'm',
    text: 'x',
    status: 'accepted',
    createdAt: 1,
  },
  {
    type: 'external_turn',
    version: 1,
    targetId: 'codex',
    sessionId: 's',
    status: 'active',
    startedAt: 1,
    updatedAt: 1,
    lastSequence: 0,
    eventCount: 0,
    persistedBytes: 0,
  },
  { type: 'error', text: 'boom' },
  { type: 'system_event', event: 'compacted', detail: 'd' },
  {
    type: 'continuation_transition',
    provider: 'openai',
    modelName: 'm',
    fromMode: 'a',
    toMode: 'b',
    reasonCode: 'model_changed',
    recovered: true,
  },
];

/** A part type no current writer emits, with fields no current type has. */
const LEGACY_PARTS = [
  { type: 'legacy_widget', payload: { nested: [1, 2, 3] }, note: null },
  { type: 'text', text: 'old text part', annotations: ['kept'] },
];

let TEST_USER!: UserFixture;
let restoreAuth: (() => void) | null = null;

beforeAll(async () => {
  TEST_USER = await insertTestUser();
});

afterEach(() => {
  restoreAuth?.();
  restoreAuth = null;
});

async function seedWireFixture(): Promise<void> {
  await insertTestChat(TEST_USER.id, { id: CHAT_ID, title: 'wire fixture' });
  const db = getDb();
  await db
    .insertInto('messages')
    .values([
      // Every optional column NULL and no parts: what a legacy row looks like.
      {
        id: 'wire-null-row',
        chatId: CHAT_ID,
        role: 'user',
        text: 'all optional columns null',
        timestamp: BASE,
        isGenerating: 0,
        interactionMode: 'chat',
      },
      // Every column populated, every part type in use.
      {
        id: 'wire-full-row',
        chatId: CHAT_ID,
        role: 'ai',
        text: 'every column set',
        imageUrl: '/images/full.png',
        referenceImage: '/uploads/ref.png',
        timestamp: BASE + 1,
        isGenerating: 1,
        generationTime: '1.2s',
        modelName: 'model-x',
        styleParams: JSON.stringify(['vivid', 'wide']),
        interactionMode: 'image',
        parts: JSON.stringify(EVERY_PART_TYPE),
        providerState: '{"cursor":"abc"}',
      },
      // Parts a current writer would not produce.
      {
        id: 'wire-legacy-row',
        chatId: CHAT_ID,
        role: 'ai',
        text: 'legacy parts',
        timestamp: BASE + 2,
        isGenerating: 0,
        interactionMode: 'agent',
        parts: JSON.stringify(LEGACY_PARTS),
      },
    ])
    .execute();
  await db
    .insertInto('generated_images')
    .values({
      id: 'wire-image',
      userId: TEST_USER.id,
      chatId: CHAT_ID,
      messageId: 'wire-full-row',
      toolCallId: null,
      prompt: 'a mango',
      imageUrl: '/images/full.png',
      modelName: null,
      generationTime: null,
      createdAt: BASE + 10,
      metadataJson: '{"seed":7}',
    })
    .execute();
  await db
    .insertInto('chat_attachments')
    .values({
      id: 'wire-attachment',
      userId: TEST_USER.id,
      chatId: CHAT_ID,
      messageId: 'wire-full-row',
      originalName: 'notes.txt',
      storedName: 'stored-notes.txt',
      relativePath: 'stored-notes.txt',
      url: '/uploads/stored-notes.txt',
      mimeType: 'text/plain',
      sizeBytes: 12,
      kind: 'text',
      createdAt: BASE + 11,
      updatedAt: BASE + 11,
    })
    .execute();
}

async function requestTranscriptText(
  chatId: string = CHAT_ID
): Promise<{ status: number; text: string }> {
  const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, chatRoutes);
  restoreAuth = restore;
  const response = await app.handle(new Request(`http://localhost/chats/${chatId}/messages`));
  return { status: response.status, text: await response.text() };
}

const GOLDEN =
  '{"messages":[{"id":"wire-null-row","chatId":"wire-fixture-chat","role":"user","text":"all optional columns null","imageUrl":null,"referenceImage":null,"timestamp":1700000000000,"isGenerating":false,"generationTime":null,"modelName":null,"interactionMode":"chat","providerState":null},{"id":"wire-full-row","chatId":"wire-fixture-chat","role":"ai","text":"every column set","imageUrl":"/images/full.png","referenceImage":"/uploads/ref.png","timestamp":1700000000001,"isGenerating":true,"generationTime":"1.2s","modelName":"model-x","styleParams":["vivid","wide"],"interactionMode":"image","parts":[{"type":"text","text":"hello","incomplete":true},{"type":"thinking","text":"hmm","redacted":false},{"type":"tool_call","toolCallId":"call-1","name":"read_file","args":{"path":"a.txt"},"execution":{"status":"completed"}},{"type":"tool_result","toolCallId":"call-1","content":"ok","isError":false},{"type":"generated_image","imageId":"img-1","toolCallId":"call-2","status":"completed","prompt":"a mango","imageUrl":"/images/img-1.png"},{"type":"mcp_media","toolCallId":"call-3","serverSlug":"srv","toolName":"shot","kind":"image","mimeType":"image/png","url":"/images/m.png"},{"type":"question","toolCallId":"call-4","questions":[]},{"type":"mcp_elicitation","requestId":"req-1","serverSlug":"srv","status":"pending"},{"type":"todo","toolCallId":"call-5","todos":[]},{"type":"subagent_trace","toolCallId":"call-6","agentId":"default","agentName":"Default","status":"completed","summary":"s","toolCallCount":0,"messages":[],"tools":[]},{"type":"turn_checkpoint","version":1},{"type":"external_activity","targetId":"codex","callId":"c","name":"Bash","kind":"command","title":"ls","status":"completed"},{"type":"external_approval","targetId":"codex","requestId":"r","kind":"command","title":"t","options":[],"expiresAtMs":1},{"type":"external_steer","targetId":"codex","clientMessageId":"m","text":"x","status":"accepted","createdAt":1},{"type":"external_turn","version":1,"targetId":"codex","sessionId":"s","status":"active","startedAt":1,"updatedAt":1,"lastSequence":0,"eventCount":0,"persistedBytes":0},{"type":"error","text":"boom"},{"type":"system_event","event":"compacted","detail":"d"},{"type":"continuation_transition","provider":"openai","modelName":"m","fromMode":"a","toMode":"b","reasonCode":"model_changed","recovered":true}],"providerState":"{\\"cursor\\":\\"abc\\"}","generatedImages":[{"id":"wire-image","chatId":"wire-fixture-chat","messageId":"wire-full-row","prompt":"a mango","imageUrl":"/images/full.png","createdAt":1700000000010,"metadata":{"seed":7}}],"attachments":[{"id":"wire-attachment","chatId":"wire-fixture-chat","messageId":"wire-full-row","originalName":"notes.txt","mimeType":"text/plain","sizeBytes":12,"kind":"text","url":"/uploads/stored-notes.txt","createdAt":1700000000011}]},{"id":"wire-legacy-row","chatId":"wire-fixture-chat","role":"ai","text":"legacy parts","imageUrl":null,"referenceImage":null,"timestamp":1700000000002,"isGenerating":false,"generationTime":null,"modelName":null,"interactionMode":"agent","parts":[{"type":"legacy_widget","payload":{"nested":[1,2,3]},"note":null},{"type":"text","text":"old text part","annotations":["kept"]}],"providerState":null}],"nextCursor":null,"contextInfo":null}';

describe('GET /chats/:id/messages wire bytes', () => {
  it('serves null-bearing rows, every part type and a legacy part byte-for-byte as before', async () => {
    await seedWireFixture();

    const { status, text } = await requestTranscriptText();
    if (status !== 200) throw new Error(`expected status: 200 | received: ${status} ${text}`);
    if (text !== GOLDEN) {
      throw new Error(
        `expected response text: the pinned golden | received a different serialisation:\n${text}`
      );
    }
    expect(text).toBe(GOLDEN);
  });
});

const TOLERANCE_CHAT_ID = 'wire-tolerance-chat';

/**
 * A value no writer produces, typed as the column's declared union. `messages.role`,
 * `messages.interactionMode` and `chat_attachments.kind` are free text with no CHECK
 * constraint, so such a row can exist (a downgrade, a hand edit) and the reader has
 * to keep serving it; Kysely's row types would otherwise refuse to seed one.
 */
function storedOutsideTheUnion<T extends string>(value: string): T {
  return value as T;
}

async function seedToleranceFixture(): Promise<void> {
  await insertTestChat(TEST_USER.id, { id: TOLERANCE_CHAT_ID, title: 'wire tolerance' });
  const db = getDb();
  await db
    .insertInto('messages')
    .values([
      {
        id: 'tolerance-role-row',
        chatId: TOLERANCE_CHAT_ID,
        role: storedOutsideTheUnion<'user'>('zzz'),
        text: 'role outside user | ai',
        timestamp: BASE,
        isGenerating: 0,
        interactionMode: 'agent',
      },
      {
        id: 'tolerance-mode-row',
        chatId: TOLERANCE_CHAT_ID,
        role: 'ai',
        text: 'interaction mode outside chat | agent | image',
        timestamp: BASE + 1,
        isGenerating: 0,
        interactionMode: storedOutsideTheUnion<'chat'>('zzz'),
      },
    ])
    .execute();
  await db
    .insertInto('chat_attachments')
    .values({
      id: 'tolerance-attachment',
      userId: TEST_USER.id,
      chatId: TOLERANCE_CHAT_ID,
      messageId: 'tolerance-mode-row',
      originalName: 'odd.bin',
      storedName: 'stored-odd.bin',
      relativePath: 'stored-odd.bin',
      url: '/uploads/stored-odd.bin',
      mimeType: 'application/octet-stream',
      sizeBytes: 3,
      kind: storedOutsideTheUnion<'text'>('zzz'),
      createdAt: BASE + 11,
      updatedAt: BASE + 11,
    })
    .execute();
}

/** Captured from the route before the transcript row had a schema, when any stored value passed through. */
const TOLERANCE_GOLDEN =
  '{"messages":[{"id":"tolerance-role-row","chatId":"wire-tolerance-chat","role":"zzz","text":"role outside user | ai","imageUrl":null,"referenceImage":null,"timestamp":1700000000000,"isGenerating":false,"generationTime":null,"modelName":null,"interactionMode":"agent","providerState":null},{"id":"tolerance-mode-row","chatId":"wire-tolerance-chat","role":"ai","text":"interaction mode outside chat | agent | image","imageUrl":null,"referenceImage":null,"timestamp":1700000000001,"isGenerating":false,"generationTime":null,"modelName":null,"interactionMode":"zzz","providerState":null,"attachments":[{"id":"tolerance-attachment","chatId":"wire-tolerance-chat","messageId":"tolerance-mode-row","originalName":"odd.bin","mimeType":"application/octet-stream","sizeBytes":3,"kind":"zzz","url":"/uploads/stored-odd.bin","createdAt":1700000000011}]}],"nextCursor":null,"contextInfo":null}';

describe('GET /chats/:id/messages with stored values outside the written unions', () => {
  it('serves a row with an unknown role, an unknown interaction mode and an unknown attachment kind byte-for-byte as before', async () => {
    await seedToleranceFixture();

    const { status, text } = await requestTranscriptText(TOLERANCE_CHAT_ID);
    if (status !== 200) throw new Error(`expected status: 200 | received: ${status} ${text}`);
    if (text !== TOLERANCE_GOLDEN) {
      throw new Error(
        `expected response text: the pinned golden | received a different serialisation:\n${text}`
      );
    }
    expect(text).toBe(TOLERANCE_GOLDEN);
  });
});
