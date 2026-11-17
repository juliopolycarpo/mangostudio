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
import { insertTestChat } from '../../support/factories';
import { listenOnEphemeralPort } from '../../support/listen-ephemeral';

const lanAddress = Object.values(networkInterfaces())
  .flat()
  .find((entry) => entry?.family === 'IPv4' && !entry.internal)?.address;

const CHAT_COUNT = 120;

let port = 0;
let cookie = '';
let smallChatId = '';

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
  for (let index = 0; index < CHAT_COUNT; index += 1) {
    await insertTestChat(body.user.id, { title: `A chat about topic number ${index}` });
  }
});

afterAll(async () => {
  await app.stop(true);
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

describe.skipIf(lanAddress === undefined)('the composed app, seen from another machine', () => {
  const remote = lanAddress as string;

  it('gzips the chat list and keeps the rate-limit headers', async () => {
    const response = await get(remote, '/api/chats');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-encoding')).toBe('gzip');
    expect(response.headers.get('vary')).toContain('Accept-Encoding');
    expect(response.headers.get('x-ratelimit-limit')).not.toBeNull();
    const chats = JSON.parse(
      new TextDecoder().decode(Bun.gunzipSync(await response.arrayBuffer()))
    );
    expect(chats).toHaveLength(CHAT_COUNT + 1);
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
});

describe('the composed app, seen from the same machine', () => {
  it('sends the chat list as identity', async () => {
    const response = await get('127.0.0.1', '/api/chats');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(((await response.json()) as unknown[]).length).toBe(CHAT_COUNT + 1);
  });
});
