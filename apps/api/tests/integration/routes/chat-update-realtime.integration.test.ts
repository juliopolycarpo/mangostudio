/**
 * `PUT /chats/:id` must tell every open tab of the owning account that the chat
 * list changed. The writing tab patches its own cache from the mutation; any
 * other tab only learns through the activity topic, so a silent update leaves
 * its sidebar stale until the socket happens to reconnect.
 *
 * Two tabs are two bus subscribers of the same user: the realtime route does
 * nothing but forward what the bus delivers, so the producer side is what these
 * cases pin.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { ACTIVITY_TOPIC, type RealtimeInvalidateEvent } from '@mangostudio/shared/realtime';
import { getDb } from '../../../src/db/database';
import { chatRoutes } from '../../../src/modules/chats/http/chat-routes';
import {
  createRealtimeBus,
  getRealtimeBus,
  setRealtimeBusForTests,
} from '../../../src/services/realtime/realtime-bus';
import { insertTestChat, insertTestUser, type UserFixture } from '../../support/factories';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';

let owner!: UserFixture;
let otherUser!: UserFixture;
let restoreAuth: (() => void) | null = null;
const unsubscribers: Array<() => void> = [];

beforeAll(async () => {
  owner = await insertTestUser();
  otherUser = await insertTestUser();
});

beforeEach(() => {
  setRealtimeBusForTests(createRealtimeBus());
});

afterEach(() => {
  for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
  setRealtimeBusForTests(undefined);
  restoreAuth?.();
  restoreAuth = null;
});

/** One open tab: a subscriber that records everything delivered to it. */
function openTab(userId: string): RealtimeInvalidateEvent[] {
  const events: RealtimeInvalidateEvent[] = [];
  unsubscribers.push(getRealtimeBus().subscribe(userId, (event) => events.push(event)));
  return events;
}

function activityCount(events: readonly RealtimeInvalidateEvent[]): number {
  return events.filter((event) => event.topic === ACTIVITY_TOPIC).length;
}

function expectActivityInvalidations(
  events: readonly RealtimeInvalidateEvent[],
  expected: number,
  action: string,
  tab: string
): void {
  const received = activityCount(events);
  if (received === expected) return;
  throw new Error(
    `expected activity invalidations after ${action}: ${expected} | received: ${received} (${tab})`
  );
}

function putChat(
  asUser: UserFixture,
  chatId: string,
  body: Record<string, unknown>
): Promise<Response> {
  const { app, restore } = createAuthenticatedApiTestApp(asUser, chatRoutes);
  restoreAuth = restore;
  return app.handle(
    new Request(`http://localhost/chats/${chatId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
}

async function storedTitle(chatId: string): Promise<string | undefined> {
  const row = await getDb()
    .selectFrom('chats')
    .select('title')
    .where('id', '=', chatId)
    .executeTakeFirst();
  return row?.title;
}

describe('chat update realtime invalidation', () => {
  it('tells a second tab of the same account about a title update, and nobody else', async () => {
    const writingTab = openTab(owner.id);
    const secondTab = openTab(owner.id);
    const otherAccountTab = openTab(otherUser.id);
    const chat = await insertTestChat(owner.id, { title: 'before' });

    const response = await putChat(owner, chat.id, { title: 'after' });

    expect(response.status).toBe(200);
    expectActivityInvalidations(writingTab, 1, 'title update', 'writing tab');
    expectActivityInvalidations(secondTab, 1, 'title update', 'second tab');
    expectActivityInvalidations(otherAccountTab, 0, 'title update', 'other account tab');
    expect(secondTab).toEqual([{ type: 'invalidate', topic: ACTIVITY_TOPIC }]);
  });

  it('publishes only once the new title is durable', async () => {
    const titlesSeenOnDelivery: Array<Promise<string | undefined>> = [];
    unsubscribers.push(
      getRealtimeBus().subscribe(owner.id, () => {
        titlesSeenOnDelivery.push(storedTitle(chat.id));
      })
    );
    const chat = await insertTestChat(owner.id, { title: 'before' });

    await putChat(owner, chat.id, { title: 'durable' });

    const seen = await Promise.all(titlesSeenOnDelivery);
    if (seen.length !== 1) {
      throw new Error(
        `expected deliveries observing the stored title: 1 | received: ${seen.length}`
      );
    }
    expect(seen).toEqual(['durable']);
  });

  it('publishes for any update the chat list renders, not only titles', async () => {
    const tab = openTab(owner.id);
    const chat = await insertTestChat(owner.id);

    const response = await putChat(owner, chat.id, { model: 'a-different-model' });

    expect(response.status).toBe(200);
    expectActivityInvalidations(tab, 1, 'model update', 'tab');
  });

  it('publishes nothing for an update that changes nothing', async () => {
    const tab = openTab(owner.id);
    const chat = await insertTestChat(owner.id);

    const response = await putChat(owner, chat.id, {});

    expect(response.status).toBe(200);
    expectActivityInvalidations(tab, 0, 'empty update', 'tab');
  });

  it('publishes nothing when the update is rejected', async () => {
    const tab = openTab(owner.id);
    const chat = await insertTestChat(owner.id, { title: 'untouched' });

    const response = await putChat(owner, chat.id, {
      title: 'rejected',
      environmentId: 'environment-that-does-not-exist',
    });

    expect(response.status).toBe(422);
    expectActivityInvalidations(tab, 0, 'rejected update', 'tab');
    expect(await storedTitle(chat.id)).toBe('untouched');
  });

  it("publishes nothing to anyone for another account's chat", async () => {
    const ownerTab = openTab(owner.id);
    const intruderTab = openTab(otherUser.id);
    const chat = await insertTestChat(owner.id, { title: 'mine' });

    const response = await putChat(otherUser, chat.id, { title: 'hijacked' });

    expect(response.status).toBe(404);
    expectActivityInvalidations(ownerTab, 0, 'unauthorized update', 'owner tab');
    expectActivityInvalidations(intruderTab, 0, 'unauthorized update', 'intruder tab');
    expect(await storedTitle(chat.id)).toBe('mine');
  });
});
