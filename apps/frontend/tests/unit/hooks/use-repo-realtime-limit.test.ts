/**
 * The sidebar's repo topics against the hub's active-topic limit. The real
 * realtime client and the real hooks run over a socket double that enforces the
 * hub's rule: a subscribe frame that would leave more than
 * `MAX_REALTIME_ACTIVE_TOPICS` topics active is refused whole, with a
 * `RATE_LIMITED` error and no ack.
 *
 * A fast scroll is the case that gets there: the rows that left the view stay
 * subscribed for the client's linger window, so they count beside the rows that
 * replaced them and beside every topic the rest of the tab holds.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import type { GitSummary } from '@mangostudio/shared/git';
import {
  ACTIVITY_TOPIC,
  CHATS_TOPIC,
  ENVIRONMENTS_TOPIC,
  EXTERNAL_AGENTS_TOPIC,
  gitTopic,
  MAX_REALTIME_ACTIVE_TOPICS,
  repoTopic,
  SETTINGS_TOPIC,
} from '@mangostudio/shared/realtime';

import {
  MAX_SIDEBAR_REPO_TOPICS,
  useRepoRealtimeInvalidation,
} from '@/features/workspace/hooks/use-git-state';
import { getRealtimeClient, resetRealtimeClient } from '@/lib/realtime/realtime-client';
import { resetRealtimeInvalidations } from '@/lib/realtime/use-realtime-invalidation';

import { renderHook } from '../../support/harness/render';
import { advanceTimersByTimeAsync, useFakeTimers } from '../../support/harness/timers';
import { setTestSession } from '../../support/setup/auth-client-stub';

const LINGER_MS = 5_000;

/** Enforces the hub's subscribe rule over every socket the client opens. */
class FakeRealtimeHub {
  /** Topics the hub holds for the current socket, as `state.topics` does. */
  readonly activeTopics = new Set<string>();
  /** Topics the hub acked and has not since unsubscribed. */
  readonly ackedTopics = new Set<string>();
  rejectedFrames = 0;
  socket: FakeHubSocket | null = null;

  reset(): void {
    this.activeTopics.clear();
    this.ackedTopics.clear();
    this.rejectedFrames = 0;
    this.socket = null;
  }

  receive(socket: FakeHubSocket, raw: string): void {
    const message = JSON.parse(raw) as { type: string; topics?: string[] };
    const topics = message.topics ?? [];
    if (message.type === 'unsubscribe') {
      for (const topic of topics) {
        this.activeTopics.delete(topic);
        this.ackedTopics.delete(topic);
      }
      return;
    }
    if (message.type !== 'subscribe') return;

    const accepted = new Set(topics.filter((topic) => !this.activeTopics.has(topic)));
    if (this.activeTopics.size + accepted.size > MAX_REALTIME_ACTIVE_TOPICS) {
      this.rejectedFrames += 1;
      socket.emit({
        type: 'error',
        error: 'Realtime subscription limit exceeded',
        code: 'RATE_LIMITED',
      });
      return;
    }
    for (const topic of accepted) this.activeTopics.add(topic);
    for (const topic of topics) this.ackedTopics.add(topic);
    socket.emit({ type: 'subscribed', topics: [...new Set(topics)] });
  }
}

const hub = new FakeRealtimeHub();

class FakeHubSocket {
  readyState = 0;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(_url: string) {
    hub.socket = this;
  }

  send(data: string): void {
    hub.receive(this, data);
  }

  close(): void {
    this.readyState = 3;
  }

  /** The handshake the hub completes before it accepts any frame. */
  accept(): void {
    this.readyState = 1;
    this.emit({ type: 'ready' });
  }

  emit(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
  }
}

const realWebSocket = globalThis.WebSocket;

beforeAll(() => {
  globalThis.WebSocket = FakeHubSocket as unknown as typeof WebSocket;
});

afterAll(() => {
  globalThis.WebSocket = realWebSocket;
});

/** `count` chats named `<prefix>-<n>`, each alone in its own repository. */
function disjointRows(prefix: string, count: number) {
  const chatIds = Array.from({ length: count }, (_, index) => `${prefix}-${index}`);
  const summaries: Record<string, GitSummary> = Object.fromEntries(
    chatIds.map((chatId) => [
      chatId,
      {
        branch: 'main',
        ahead: 0,
        behind: 0,
        changedFileCount: 0,
        workdir: `/work/${chatId}`,
        repoKey: `repo-${chatId}`,
      },
    ])
  );
  return { chatIds, summaries };
}

/** The repo topics the sidebar is entitled to for its first `count` rows. */
function expectedTopics(chatIds: readonly string[]): string[] {
  return chatIds.slice(0, MAX_SIDEBAR_REPO_TOPICS).map((chatId) => repoTopic(`repo-${chatId}`));
}

/** The topics the rest of the tab holds: one per feature, plus the open chat's pair. */
const BASE_TOPICS = [
  SETTINGS_TOPIC,
  CHATS_TOPIC,
  ACTIVITY_TOPIC,
  ENVIRONMENTS_TOPIC,
  EXTERNAL_AGENTS_TOPIC,
  gitTopic('open-chat'),
  repoTopic('open-chat-repo'),
];

async function mountTabWithBaseTopics() {
  for (const topic of BASE_TOPICS) getRealtimeClient().subscribe(topic, () => undefined);
  hub.socket?.accept();
  await advanceTimersByTimeAsync(0);
}

function renderSidebar(initialRows: ReturnType<typeof disjointRows>) {
  return renderHook(
    ({ rows }) => {
      useRepoRealtimeInvalidation(rows.chatIds, rows.summaries);
    },
    { initialProps: { rows: initialRows } }
  );
}

describe('sidebar repo topics against the hub active-topic limit', () => {
  beforeEach(() => {
    useFakeTimers();
    setTestSession({ user: { id: 'user-test' } });
    resetRealtimeClient();
    resetRealtimeInvalidations();
    hub.reset();
  });

  it('acks every repo of the set scrolled to, with the set scrolled from still lingering, and refuses no frame', async () => {
    await mountTabWithBaseTopics();
    const first = disjointRows('first', 32);
    const second = disjointRows('second', 32);
    const view = renderSidebar(first);
    await advanceTimersByTimeAsync(0);

    // A fast scroll: the second set arrives well inside the first one's linger.
    view.rerender({ rows: second });
    await advanceTimersByTimeAsync(0);
    await advanceTimersByTimeAsync(LINGER_MS + 1);

    const wanted = expectedTopics(second.chatIds);
    const missing = wanted.filter((topic) => !hub.ackedTopics.has(topic));
    expect(
      missing,
      `(realtime hub): expected every sidebar repo topic acked | received: ${missing.length} of ${wanted.length} unacked, ${hub.rejectedFrames} frame(s) refused for the topic limit`
    ).toEqual([]);
    expect(hub.rejectedFrames).toBe(0);
  });

  it('recovers when scrolling piles up more lingering topics than the hub allows', async () => {
    await mountTabWithBaseTopics();
    const sets = ['a', 'b', 'c', 'd', 'e', 'f'].map((prefix) => disjointRows(prefix, 32));
    const [firstSet, ...laterSets] = sets;
    if (firstSet === undefined) throw new Error('(test setup): expected at least one row set');
    const view = renderSidebar(firstSet);
    await advanceTimersByTimeAsync(0);

    // Every set lands inside the first release's linger window, so each one's
    // topics are asked for while all the earlier ones still count.
    for (const rows of laterSets) {
      view.rerender({ rows });
      await advanceTimersByTimeAsync(0);
    }
    await advanceTimersByTimeAsync(LINGER_MS + 1);

    const lastSet = laterSets.at(-1);
    if (lastSet === undefined) throw new Error('(test setup): expected a last row set');
    const wanted = expectedTopics(lastSet.chatIds);
    const missing = wanted.filter((topic) => !hub.ackedTopics.has(topic));
    expect(
      missing,
      `(realtime hub): expected the visible repos acked once lingering topics were released | received: ${missing.length} of ${wanted.length} unacked, ${hub.rejectedFrames} frame(s) refused`
    ).toEqual([]);
    expect(hub.activeTopics.size).toBeLessThanOrEqual(MAX_REALTIME_ACTIVE_TOPICS);
  });
});
