import { describe, expect, test } from 'bun:test';

import { ChatSchema } from '@mangostudio/shared/chat';
import { Create } from 'typebox/value';

import { assertSmokeSchema, smokeBinaryApplication } from '../lib/binary-application-smoke';
import { type ApplicationFault, FakeBinaryApplication } from './support/fake-binary-application';

describe('built hub application qualification', () => {
  test('validates canonical CRUD, websocket activity, Local health and the same database after restart', async () => {
    const fake = new FakeBinaryApplication();
    await smokeBinaryApplication(fake.options());
    expect(fake.restarted).toBe(true);
    expect(fake.socket.isClosed).toBe(true);
    expect(fake.requests).toEqual([
      'POST /api/chats/',
      'POST /api/chats/',
      'PUT /api/chats/fixture-chat',
      'GET /api/chats/',
      'POST /api/environments/local/connect',
      'GET /api/environments/local/runtime',
      'GET /api/chats/',
      'DELETE /api/chats/fixture-chat',
      'GET /api/chats/',
    ]);
    expect(fake.chat).toBeUndefined();
  });
  test('Windows disconnects Local and awaits its exit before terminating the hub', async () => {
    const fake = new FakeBinaryApplication();
    await smokeBinaryApplication({ ...fake.options(), platform: 'win32' });
    expect(fake.events).toEqual(['observe', 'disconnect', 'runtime-exited', 'restart']);
  });
  test('schema countercontrol names the invalid title and its expected string shape', () => {
    const chat = Create(ChatSchema);
    expect(assertSmokeSchema(ChatSchema, chat, 'chat')).toEqual(chat);
    expect(() => assertSmokeSchema(ChatSchema, { ...chat, title: 123 }, 'chat')).toThrow(
      '"instancePath":"/title"'
    );
  });
  const cases: [ApplicationFault, string][] = [
    ['bad-title', 'created chat: expected canonical schema'],
    ['bad-list', 'chat list: expected canonical schema'],
    ['wrong-error', 'expected 422 VALIDATION'],
    ['lost-database', 'expected persisted fixture-chat'],
    ['wrong-runtime', 'expected fresh sibling runtime'],
    ['missing-pong', 'expected pong within 30ms'],
    ['wrong-activity', 'expected activity invalidation'],
    ['bad-json', 'received malformed JSON object'],
    ['closed', 'received connection closed'],
    ['bad-subscription', 'expected activity subscription'],
    ['bad-update', 'update chat: expected success true'],
    ['bad-delete', 'delete chat: expected success true'],
    ['retained-chat', 'expected fixture-chat absent after delete'],
  ];
  test.each(cases)('rejects %s for its intended reason', async (fault, message) => {
    const fake = new FakeBinaryApplication(fault);
    await expect(smokeBinaryApplication(fake.options())).rejects.toThrow(message);
    if (fault !== 'wrong-error') expect(fake.socket.isClosed).toBe(true);
  });
});
