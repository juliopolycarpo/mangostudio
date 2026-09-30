/**
 * The hub as the authenticated shell's bootstrap sees it: the chat list, the
 * model catalog and agent settings, plus the first chat's transcript.
 *
 * Built on the fetch scenario so each request goes through the real Eden
 * client and its error normalization — the status and `code` a failure
 * carries are what the code under test branches on, so a stub that skipped
 * that path would test a different error than production raises.
 */

import { ERROR_CODES } from '@mangostudio/shared/errors';
import { createFetchScenario } from './create-fetch-scenario';

/** The request path each shell responsibility is loaded from. */
const SHELL_PATHS = {
  chats: '/api/chats',
  catalog: '/api/settings/models',
  agents: '/api/settings/agents',
} as const;

type ShellPathKey = keyof typeof SHELL_PATHS;

/** The transcript request the loader chains from the first chat. */
export const FIRST_CHAT_MESSAGES_PATH = '/api/chats/chat-1/messages?limit=50';

/** How a responsibility is refused: an HTTP status with the hub's error body, or a dropped connection. */
export type ShellRefusal = 'server-error' | 'rate-limited' | 'unauthorized' | 'network';

const REFUSALS: Record<Exclude<ShellRefusal, 'network'>, { status: number; body: object }> = {
  'server-error': { status: 500, body: { error: 'Internal error', code: ERROR_CODES.INTERNAL } },
  'rate-limited': {
    status: 429,
    body: { error: 'Too many requests', code: ERROR_CODES.RATE_LIMITED },
  },
  unauthorized: { status: 401, body: { error: 'Unauthorized', code: ERROR_CODES.UNAUTHORIZED } },
};

const HEALTHY: Record<ShellPathKey, unknown> = {
  chats: [{ id: 'chat-1', title: 'First chat' }],
  catalog: { textModels: [], imageModels: [] },
  agents: { agents: [] },
};

function pathOf(input: RequestInfo | URL): string {
  const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
  return `${url.pathname}${url.search}`;
}

/**
 * A hub that answers every bootstrap request, until told to refuse one.
 *
 * @example
 * const hub = createShellBootstrapHub().refuse('catalog', 'server-error').install();
 * await loadShellBootstrap(queryClient);
 * hub.requestCount('catalog'); // 1
 */
export function createShellBootstrapHub() {
  const scenario = createFetchScenario();
  scenario.respondWithJson('GET', FIRST_CHAT_MESSAGES_PATH, {
    body: { messages: [], nextCursor: null },
  });

  const hub = {
    /** Answers a responsibility with its healthy body. */
    answer(key: ShellPathKey) {
      scenario.respondWithJson('GET', SHELL_PATHS[key], { body: HEALTHY[key] });
      return hub;
    },
    /** Refuses a responsibility the given way. A dropped connection stays dropped. */
    refuse(key: ShellPathKey, refusal: ShellRefusal) {
      if (refusal === 'network') {
        scenario.failWithNetworkError('GET', SHELL_PATHS[key]);
        return hub;
      }
      scenario.respondWithJson('GET', SHELL_PATHS[key], REFUSALS[refusal]);
      return hub;
    },
    /** How many times a path was requested, whatever the answer. */
    requestCount(key: ShellPathKey | typeof FIRST_CHAT_MESSAGES_PATH): number {
      const path = key === FIRST_CHAT_MESSAGES_PATH ? key : SHELL_PATHS[key];
      return scenario.fetchMock.mock.calls.filter(([input]) => pathOf(input) === path).length;
    },
    install() {
      scenario.install();
      return hub;
    },
    restore() {
      scenario.restore();
    },
  };

  for (const key of Object.keys(SHELL_PATHS) as ShellPathKey[]) hub.answer(key);
  return hub;
}

/** A fake hub's handle, as the tests hold it. */
export type ShellBootstrapHub = ReturnType<typeof createShellBootstrapHub>;
