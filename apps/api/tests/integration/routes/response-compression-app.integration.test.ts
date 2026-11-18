/**
 * Response compression as `app.ts` composes it.
 *
 * The plugin's own suite proves its rules against a throwaway app. What only
 * the real application can show is that it is mounted at all, that the routes
 * the allowlist names are the ones that compress, and that it sits well with
 * the global hooks around it: rate-limit headers, the error negotiator and the
 * OpenAPI document hook. A real socket is needed for a peer address, so the
 * "remote" client dials the host's own non-loopback address.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { networkInterfaces } from 'node:os';

import { PROBLEM_JSON_ACCEPT, PROBLEM_JSON_MEDIA_TYPE } from '@mangostudio/shared/errors';

import { app, COMPRESSED_API_ROUTES } from '../../../src/app';
import { getDb } from '../../../src/db/database';
import { COMPRESSION_MAX_BYTES } from '../../../src/plugins/response-compression';
import { insertTestChat } from '../../support/factories';
import { listenOnEphemeralPort, stopEphemeralServer } from '../../support/listen-ephemeral';

const lanAddress = Object.values(networkInterfaces())
  .flat()
  .find((entry) => entry?.family === 'IPv4' && !entry.internal)?.address;

/**
 * Without a LAN address the remote half cannot run. Locally that is a skip; in CI
 * (GitHub runners have one) it is a failure, so the half cannot quietly vanish.
 */
const requireLanAddress = process.env.CI !== undefined && process.env.CI !== '';

const CHAT_COUNT = 120;
/** The small, bulky and huge transcript chats seeded besides the numbered ones. */
const SEEDED_TRANSCRIPT_CHATS = 3;
const BULKY_MESSAGES = 60;
const GALLERY_ROWS = 60;
/** 100 messages of this size make a page above the 2 MiB ceiling. */
const HUGE_MESSAGE_CHARS = 25_000;

let port = 0;
let cookie = '';
let smallChatId = '';
let bulkyChatId = '';
let hugeChatId = '';

beforeAll(async () => {
  port = await listenOnEphemeralPort(app);
  const signup = await fetch(`http://127.0.0.1:${port}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `compression-${crypto.randomUUID()}@mangostudio.test`,
      password: 'correct-horse-battery-staple',
      name: 'Compression Tester',
    }),
  });
  expect(signup.status).toBe(200);
  const body = (await signup.json()) as { user: { id: string } };
  cookie = signup.headers
    .getSetCookie()
    .map((value) => value.split(';', 1)[0])
    .join('; ');
  // A transcript far below the threshold, on an allowlisted route that returns a plain value.
  smallChatId = (await insertTestChat(body.user.id, { title: 'Small transcript' })).id;
  await getDb()
    .insertInto('messages')
    .values({
      id: `${smallChatId}-m1`,
      chatId: smallChatId,
      role: 'user',
      text: 'hello',
      timestamp: 1_700_000_000_000,
      isGenerating: 0,
      interactionMode: 'chat',
    })
    .execute();
  bulkyChatId = (await insertTestChat(body.user.id, { title: 'Bulky transcript' })).id;
  hugeChatId = (await insertTestChat(body.user.id, { title: 'Huge transcript' })).id;
  const messageRows = (chatId: string, count: number, chars: number) =>
    Array.from({ length: count }, (_, index) => ({
      id: `${chatId}-m${index}`,
      chatId,
      role: 'user' as const,
      text: `${index} ${'lorem ipsum dolor '.repeat(Math.ceil(chars / 18))}`.slice(0, chars),
      timestamp: 1_700_000_000_000 + index,
      isGenerating: 0,
      interactionMode: 'chat' as const,
    }));
  await getDb()
    .insertInto('messages')
    .values(messageRows(bulkyChatId, BULKY_MESSAGES, 400))
    .execute();
  await getDb()
    .insertInto('messages')
    .values(messageRows(hugeChatId, 100, HUGE_MESSAGE_CHARS))
    .execute();
  await getDb()
    .insertInto('generated_images')
    .values(
      Array.from({ length: GALLERY_ROWS }, (_, index) => ({
        id: `${bulkyChatId}-img${index}`,
        userId: body.user.id,
        chatId: bulkyChatId,
        messageId: `${bulkyChatId}-m${index}`,
        prompt: `A painting of scene number ${index} with plenty of descriptive words`,
        imageUrl: `/uploads/${bulkyChatId}-${index}.png`,
        createdAt: 1_700_000_000_000 + index,
        toolCallId: null,
        modelName: 'test-model',
        generationTime: null,
        metadataJson: null,
      }))
    )
    .execute();
  for (let index = 0; index < CHAT_COUNT; index += 1) {
    await insertTestChat(body.user.id, { title: `A chat about topic number ${index}` });
  }
});

afterAll(async () => {
  await stopEphemeralServer(app);
});

function get(host: string, path: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`http://${host}:${port}${path}`, {
    headers: { Cookie: cookie, 'Accept-Encoding': 'gzip', ...headers },
    decompress: false,
  } as RequestInit);
}

describe('COMPRESSED_API_ROUTES', () => {
  it('lists exactly the routes chosen from the size measurements', () => {
    expect([...COMPRESSED_API_ROUTES].sort()).toEqual([
      '/api/chats',
      '/api/chats/:id/messages',
      '/api/messages/images',
      '/api/settings/tools',
    ]);
  });
});

describe.skipIf(lanAddress === undefined && !requireLanAddress)(
  'the composed app, seen from another machine',
  () => {
    it('has a non-loopback IPv4 address to dial', () => {
      expect(
        lanAddress,
        '(response-compression): expected a non-loopback IPv4 address on this host | received: none (CI must provide one)'
      ).toBeDefined();
    });

    const remote = lanAddress ?? '';

    // Each allowlisted route on the compressed path: the gunzipped remote body is
    // the loopback body byte for byte, with a matching length and a weak ETag.
    const compressedRoutes = [
      ['/api/chats', () => '/api/chats'],
      [
        '/api/chats/:id/messages',
        () => `/api/chats/${bulkyChatId}/messages?limit=${BULKY_MESSAGES}`,
      ],
      ['/api/messages/images', () => `/api/messages/images?limit=${GALLERY_ROWS}`],
      ['/api/settings/tools', () => '/api/settings/tools'],
    ] as const;

    it.each(compressedRoutes)(
      'compresses %s and the bytes match the loopback answer',
      async (_route, pathFor) => {
        const path = pathFor();
        const local = new Uint8Array(await (await get('127.0.0.1', path)).arrayBuffer());
        const response = await get(remote, path);
        expect(response.status).toBe(200);
        expect(response.headers.get('content-encoding')).toBe('gzip');
        const packed = new Uint8Array(await response.arrayBuffer());
        expect(response.headers.get('content-length')).toBe(String(packed.byteLength));
        expect(response.headers.get('vary')).toContain('Accept-Encoding');
        const etag = response.headers.get('etag');
        if (etag !== null) expect(etag).toMatch(/^W\//);
        expect(Bun.gunzipSync(packed)).toEqual(local);
      }
    );

    it('sends identity for an answer above the ceiling, the loopback bytes', async () => {
      const path = `/api/chats/${hugeChatId}/messages?limit=100`;
      const local = new Uint8Array(await (await get('127.0.0.1', path)).arrayBuffer());
      expect(local.byteLength).toBeGreaterThan(COMPRESSION_MAX_BYTES);
      const response = await get(remote, path);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-encoding')).toBeNull();
      expect(response.headers.get('content-length')).toBe(String(local.byteLength));
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(local);
    });

    it('gzips the chat list and keeps the rate-limit headers', async () => {
      const response = await get(remote, '/api/chats');
      expect(response.status).toBe(200);
      expect(response.headers.get('content-encoding')).toBe('gzip');
      expect(response.headers.get('vary')).toContain('Accept-Encoding');
      expect(response.headers.get('x-ratelimit-limit')).not.toBeNull();
      const chats = JSON.parse(
        new TextDecoder().decode(Bun.gunzipSync(await response.arrayBuffer()))
      );
      expect(chats).toHaveLength(CHAT_COUNT + SEEDED_TRANSCRIPT_CHATS);
    });

    it('leaves a below-threshold allowlisted answer byte for byte as Elysia serializes it', async () => {
      const path = `/api/chats/${smallChatId}/messages`;
      // The loopback answer never enters the plugin's compression path: it is Elysia's own output.
      const own = await get('127.0.0.1', path);
      const viaPlugin = await get(remote, path);
      expect(viaPlugin.status).toBe(own.status);
      expect(viaPlugin.headers.get('content-encoding')).toBeNull();
      expect(viaPlugin.headers.get('content-type')).toBe(own.headers.get('content-type'));
      expect(await viaPlugin.text()).toBe(await own.text());
    });

    it('answers an unknown route with the negotiated problem document, uncompressed', async () => {
      const response = await get(remote, '/api/no-such-route', { Accept: PROBLEM_JSON_ACCEPT });
      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).toContain(PROBLEM_JSON_MEDIA_TYPE);
      expect(response.headers.get('content-encoding')).toBeNull();
    });

    it('still amends the OpenAPI document, which is outside the compressed routes', async () => {
      const response = await get(remote, '/scalar/json');
      expect(response.status).toBe(200);
      expect(response.headers.get('content-encoding')).toBeNull();
      const document = (await response.json()) as { components?: { schemas?: object } };
      expect(Object.keys(document.components?.schemas ?? {})).toContain('ProblemDetails');
    });
  }
);

describe('the composed app, seen from the same machine', () => {
  it('sends the chat list as identity', async () => {
    const response = await get('127.0.0.1', '/api/chats');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(((await response.json()) as unknown[]).length).toBe(
      CHAT_COUNT + SEEDED_TRANSCRIPT_CHATS
    );
  });
});
