import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { DEFAULT_APP_SETTINGS } from '@mangostudio/shared/app-settings';
import {
  type RealtimeInvalidateEvent,
  SETTINGS_TOPIC,
  type SettingsScope,
} from '@mangostudio/shared/realtime';
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
    .filter((event) => event.topic === SETTINGS_TOPIC)
    .map((event) => event.scopes as readonly SettingsScope[] | undefined);
}

function jsonRequest(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
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
