import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { DEFAULT_APP_SETTINGS } from '@mangostudio/shared/app-settings';
import {
  REALTIME_WRITER_ID_HEADER,
  type RealtimeInvalidateEvent,
  RealtimeInvalidateMessageSchema,
  SETTINGS_TOPIC,
  type SettingsScope,
} from '@mangostudio/shared/realtime';
import Value from 'typebox/value';

import { settingsRoutes } from '../../../src/routes/settings';
import {
  createRealtimeBus,
  setRealtimeBusForTests,
} from '../../../src/services/realtime/realtime-bus';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';

const TEST_USER = {
  id: 'settings-realtime-user',
  name: 'Settings Realtime User',
  email: 'settings-realtime@mangostudio.test',
};

const OTHER_USER = {
  id: 'settings-realtime-other-user',
  name: 'Other Settings Realtime User',
  email: 'other-settings-realtime@mangostudio.test',
};

let restoreAuth: (() => void) | null = null;
let unsubscribe: (() => void) | null = null;
let events: RealtimeInvalidateEvent[] = [];
type SettingsInvalidateEvent = Extract<RealtimeInvalidateEvent, { topic: typeof SETTINGS_TOPIC }>;

function collectEventsFor(userId: string): void {
  const bus = createRealtimeBus();
  setRealtimeBusForTests(bus);
  events = [];
  unsubscribe = bus.subscribe(userId, (event) => {
    events.push(event);
  });
}

function settingsScopes(): (readonly SettingsScope[] | undefined)[] {
  return events
    .filter((event): event is SettingsInvalidateEvent => event.topic === SETTINGS_TOPIC)
    .map((event) => event.scopes);
}

function jsonRequest(
  path: string,
  body: unknown,
  extraHeaders: Record<string, string> = {}
): Request {
  return new Request(`http://localhost${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  });
}

/** The writer id each published settings event carries, `undefined` when it has none. */
function settingsWriterIds(): (string | undefined)[] {
  return events
    .filter((event): event is SettingsInvalidateEvent => event.topic === SETTINGS_TOPIC)
    .map((event) => event.writerId);
}

beforeEach(() => {
  collectEventsFor(TEST_USER.id);
});

afterEach(() => {
  unsubscribe?.();
  unsubscribe = null;
  setRealtimeBusForTests(undefined);
  restoreAuth?.();
  restoreAuth = null;
});

describe('settings realtime invalidation', () => {
  it('publishes the app section after an app settings write', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, settingsRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      jsonRequest('/settings/app', { ...DEFAULT_APP_SETTINGS, thinkingEnabled: true })
    );

    expect(response.status).toBe(200);
    expect(settingsScopes()).toEqual([['app']]);
  });

  it('names the writing tab on the app event when the write sends its writer id', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, settingsRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      jsonRequest(
        '/settings/app',
        { thinkingEnabled: true },
        { [REALTIME_WRITER_ID_HEADER]: 'tab-writer-1' }
      )
    );

    expect(response.status).toBe(200);
    expect(settingsWriterIds()).toEqual(['tab-writer-1']);
    expect(events.every((event) => Value.Check(RealtimeInvalidateMessageSchema, event))).toBe(true);
  });

  it('publishes no writer id for a write that sent none', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, settingsRoutes);
    restoreAuth = restore;

    const response = await app.handle(jsonRequest('/settings/app', { thinkingEnabled: true }));

    expect(response.status).toBe(200);
    expect(settingsWriterIds()).toEqual([undefined]);
    // The key is absent, not `writerId: undefined`: the frame must match what an
    // older hub would have sent.
    expect(events.every((event) => !('writerId' in event))).toBe(true);
  });

  it('saves normally and drops a malformed writer id instead of publishing it', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, settingsRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      jsonRequest(
        '/settings/app',
        { thinkingEnabled: true },
        { [REALTIME_WRITER_ID_HEADER]: 'w'.repeat(65) }
      )
    );

    // A correlation token must never turn into a rejected save: the writing tab
    // just reads the unnamed event as someone else's and refetches once.
    expect(response.status).toBe(200);
    expect(settingsWriterIds()).toEqual([undefined]);
  });

  it('keeps each writer id attached to its own write when two tabs save in a row', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, settingsRoutes);
    restoreAuth = restore;

    await app.handle(
      jsonRequest(
        '/settings/app',
        { thinkingEnabled: true },
        { [REALTIME_WRITER_ID_HEADER]: 'tab-a' }
      )
    );
    await app.handle(
      jsonRequest(
        '/settings/app',
        { thinkingEnabled: false },
        { [REALTIME_WRITER_ID_HEADER]: 'tab-b' }
      )
    );

    expect(settingsWriterIds()).toEqual(['tab-a', 'tab-b']);
  });

  it('publishes the provider section after a provider settings write', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, settingsRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      jsonRequest('/settings/providers/openai', { thinkingEnabled: true })
    );

    expect(response.status).toBe(200);
    expect(settingsScopes()).toEqual([['provider']]);
  });

  it('publishes the tool section after a tool settings write', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, settingsRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      jsonRequest('/settings/tools/get_current_datetime', { enabled: false })
    );

    expect(response.status).toBe(200);
    expect(settingsScopes()).toEqual([['tool']]);
  });

  it('does not publish when the write is rejected', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, settingsRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      jsonRequest('/settings/tools/not_a_real_tool', { enabled: false })
    );

    expect(response.status).toBe(404);
    expect(events).toEqual([]);
  });

  it('scopes the event to the writing user', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(OTHER_USER, settingsRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      jsonRequest('/settings/app', { ...DEFAULT_APP_SETTINGS, thinkingEnabled: true })
    );

    expect(response.status).toBe(200);
    expect(events).toEqual([]);
  });
});
