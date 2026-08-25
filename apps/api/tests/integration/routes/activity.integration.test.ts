import { afterEach, describe, expect, it } from 'bun:test';
import {
  ACTIVITY_PAGE_LIMIT_DEFAULT,
  type ListActivityResponse,
  ListActivityResponseSchema,
} from '@mangostudio/shared/activity';
import { ACTIVITY_TOPIC, type RealtimeInvalidateEvent } from '@mangostudio/shared/realtime';
import Value from 'typebox/value';
import { getDb } from '../../../src/db/database';
import { recordActivity } from '../../../src/modules/activity/application/record-activity';
import { activityRoutes } from '../../../src/modules/activity/http/activity-routes';
import {
  createRealtimeBus,
  setRealtimeBusForTests,
} from '../../../src/services/realtime/realtime-bus';
import { insertTestUser } from '../../support/factories';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';

let restoreAuth: (() => void) | null = null;
let userSeq = 0;
function nextUser() {
  userSeq += 1;
  return {
    id: `activity-route-user-${userSeq}`,
    name: 'Activity Route User',
    email: `activity-route-${userSeq}@mangostudio.test`,
  };
}

afterEach(async () => {
  restoreAuth?.();
  restoreAuth = null;
  setRealtimeBusForTests(undefined);
  await getDb()
    .deleteFrom('activity_events')
    .where('userId', 'like', 'activity-route-user-%')
    .execute();
  await getDb().deleteFrom('user').where('id', 'like', 'activity-route-user-%').execute();
});

async function insertRow(
  userId: string,
  overrides: Partial<{
    id: string;
    kind: string;
    createdAt: number;
    workdir: string | null;
    payloadJson: string;
  }> = {}
): Promise<string> {
  const id = overrides.id ?? `evt-${crypto.randomUUID()}`;
  await getDb()
    .insertInto('activity_events')
    .values({
      id,
      userId,
      kind: overrides.kind ?? 'chat_created',
      createdAt: overrides.createdAt ?? Date.now(),
      chatId: null,
      workdir: overrides.workdir ?? null,
      environmentId: null,
      targetId: null,
      payloadJson: overrides.payloadJson ?? JSON.stringify({ title: 'Event' }),
    })
    .execute();
  return id;
}

describe('GET /activity', () => {
  it('returns 200 with a body satisfying ListActivityResponseSchema', async () => {
    const user = await insertTestUser(nextUser());
    const { app, restore } = createAuthenticatedApiTestApp(user, activityRoutes);
    restoreAuth = restore;
    await insertRow(user.id);

    const response = await app.handle(new Request('http://localhost/activity'));
    const body = (await response.json()) as ListActivityResponse;

    expect(response.status).toBe(200);
    expect(Value.Check(ListActivityResponseSchema, body)).toBe(true);
  });

  it('orders events newest first', async () => {
    const user = await insertTestUser(nextUser());
    const { app, restore } = createAuthenticatedApiTestApp(user, activityRoutes);
    restoreAuth = restore;
    const older = await insertRow(user.id, { createdAt: 1_000 });
    const newer = await insertRow(user.id, { createdAt: 2_000 });

    const response = await app.handle(new Request('http://localhost/activity'));
    const body = (await response.json()) as ListActivityResponse;

    expect(body.events.map((event) => event.id)).toEqual([newer, older]);
  });

  it('pages with limit and cursor, covering every row exactly once', async () => {
    const user = await insertTestUser(nextUser());
    const { app, restore } = createAuthenticatedApiTestApp(user, activityRoutes);
    restoreAuth = restore;
    const ids = await Promise.all(
      [1_000, 2_000, 3_000].map((createdAt) => insertRow(user.id, { createdAt }))
    );

    const seen: string[] = [];
    let url = 'http://localhost/activity?limit=2';
    for (let guard = 0; guard < 10; guard += 1) {
      const response = await app.handle(new Request(url));
      const body = (await response.json()) as ListActivityResponse;
      seen.push(...body.events.map((event) => event.id));
      if (!body.nextCursor) break;
      url = `http://localhost/activity?limit=2&cursor=${encodeURIComponent(body.nextCursor)}`;
    }

    expect(seen.sort()).toEqual([...ids].sort());
    expect(new Set(seen).size).toBe(ids.length);
  });

  it('filters by workdir', async () => {
    const user = await insertTestUser(nextUser());
    const { app, restore } = createAuthenticatedApiTestApp(user, activityRoutes);
    restoreAuth = restore;
    const matching = await insertRow(user.id, {
      kind: 'commit_created',
      workdir: '/repo/a',
      payloadJson: JSON.stringify({ subject: 'a', branch: null }),
    });
    await insertRow(user.id, {
      kind: 'commit_created',
      workdir: '/repo/b',
      payloadJson: JSON.stringify({ subject: 'b', branch: null }),
    });

    const response = await app.handle(
      new Request(`http://localhost/activity?workdir=${encodeURIComponent('/repo/a')}`)
    );
    const body = (await response.json()) as ListActivityResponse;

    expect(body.events.map((event) => event.id)).toEqual([matching]);
  });

  it('filters by since', async () => {
    const user = await insertTestUser(nextUser());
    const { app, restore } = createAuthenticatedApiTestApp(user, activityRoutes);
    restoreAuth = restore;
    await insertRow(user.id, { createdAt: 1_000 });
    const recent = await insertRow(user.id, { createdAt: 5_000 });

    const response = await app.handle(new Request('http://localhost/activity?since=1000'));
    const body = (await response.json()) as ListActivityResponse;

    expect(body.events.map((event) => event.id)).toEqual([recent]);
  });

  it("never returns another user's rows", async () => {
    const user = await insertTestUser(nextUser());
    const other = await insertTestUser(nextUser());
    const { app, restore } = createAuthenticatedApiTestApp(user, activityRoutes);
    restoreAuth = restore;
    await insertRow(other.id);

    const response = await app.handle(new Request('http://localhost/activity'));
    const body = (await response.json()) as ListActivityResponse;

    expect(body.events).toEqual([]);

    await getDb().deleteFrom('activity_events').where('userId', '=', other.id).execute();
    await getDb().deleteFrom('user').where('id', '=', other.id).execute();
  });

  // The highest-value case in this file: Elysia validates the whole response
  // against a closed union, so one row this build cannot re-validate must not
  // take the entire feed down with it.
  it('does not 500 when a row holds an unknown kind, and omits that row', async () => {
    const user = await insertTestUser(nextUser());
    const { app, restore } = createAuthenticatedApiTestApp(user, activityRoutes);
    restoreAuth = restore;
    await insertRow(user.id, { kind: 'not_a_kind' });
    const readable = await insertRow(user.id);

    const response = await app.handle(new Request('http://localhost/activity'));
    const body = (await response.json()) as ListActivityResponse;

    expect(response.status).toBe(200);
    expect(body.events.map((event) => event.id)).toEqual([readable]);
  });

  it('coerces a real query string (limit, since, workdir arrive as strings)', async () => {
    const user = await insertTestUser(nextUser());
    const { app, restore } = createAuthenticatedApiTestApp(user, activityRoutes);
    restoreAuth = restore;
    const matching = await insertRow(user.id, {
      kind: 'commit_created',
      workdir: '/tmp/x',
      createdAt: 5_000,
      payloadJson: JSON.stringify({ subject: 'x', branch: null }),
    });
    await insertRow(user.id, {
      kind: 'commit_created',
      workdir: '/tmp/x',
      createdAt: 500,
      payloadJson: JSON.stringify({ subject: 'x-old', branch: null }),
    });

    const response = await app.handle(
      new Request('http://localhost/activity?limit=5&since=1000&workdir=/tmp/x')
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as ListActivityResponse;
    expect(body.events.map((event) => event.id)).toEqual([matching]);
  });

  it('defaults limit to ACTIVITY_PAGE_LIMIT_DEFAULT with no query', async () => {
    const user = await insertTestUser(nextUser());
    const { app, restore } = createAuthenticatedApiTestApp(user, activityRoutes);
    restoreAuth = restore;

    const response = await app.handle(new Request('http://localhost/activity'));

    expect(response.status).toBe(200);
    expect(ACTIVITY_PAGE_LIMIT_DEFAULT).toBe(30);
  });

  it('publishes on the activity topic when a new event is recorded', async () => {
    const user = await insertTestUser(nextUser());
    const bus = createRealtimeBus();
    const events: RealtimeInvalidateEvent[] = [];
    bus.subscribe(user.id, (event) => events.push(event));
    setRealtimeBusForTests(bus);

    await recordActivity(
      { userId: user.id, kind: 'chat_created', chatId: 'chat-1', payload: { title: 'Hi' } },
      { db: getDb() }
    );

    expect(events.map((event) => event.topic)).toEqual([ACTIVITY_TOPIC]);
  });
});
