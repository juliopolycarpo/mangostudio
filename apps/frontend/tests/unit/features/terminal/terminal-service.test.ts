/**
 * Terminal HTTP service: query hooks, mutation hooks, and the error path a
 * raw `fetch` module has to reproduce by hand (`ApiError`, a 401 redirect,
 * a bodyless 204).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import type { TerminalAvailability, TerminalSession } from '@mangostudio/shared/terminal';
import { useQueryClient } from '@tanstack/react-query';

import {
  terminalKeys,
  useCloseTerminalMutation,
  useOpenTerminalMutation,
  useRenameTerminalMutation,
  useTerminalAvailabilityQuery,
  useTerminalSessionsQuery,
} from '../../../../src/features/terminal/services/terminal-service';
import { ApiError } from '../../../../src/lib/utils';
import { renderHook, waitFor } from '../../../support/harness/render';
import {
  createFetchScenario,
  type FetchScenarioMock,
} from '../../../support/mocks/create-fetch-scenario';

const ENVIRONMENT_ID = 'env-1';
const CHAT_ID = 'chat-1';

type AvailabilityPhase = Pick<
  ReturnType<typeof useTerminalAvailabilityQuery>,
  'status' | 'fetchStatus' | 'error'
>;

/** Preserve the phase and error without copying query data or credentials. */
function describeQueryPhase(phase: AvailabilityPhase | undefined) {
  if (!phase) return null;
  return {
    status: phase.status,
    fetchStatus: phase.fetchStatus,
    error: phase.error ? String(phase.error) : null,
  };
}

/** Describe the method and route the scenario actually received. */
function describeFetchCall([input, init]: Parameters<FetchScenarioMock>) {
  const request = input instanceof Request ? input : undefined;
  const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
  try {
    const url = new URL(rawUrl, 'http://localhost');
    return { method, path: `${url.pathname}${url.search}` };
  } catch (error) {
    return { method, url: rawUrl, urlError: String(error) };
  }
}

/**
 * Report request, cache and observer state when availability does not succeed.
 * @example JSON.stringify(describeAvailabilityQuery(observer, cached, calls));
 */
function describeAvailabilityQuery(
  observer: AvailabilityPhase,
  cached: AvailabilityPhase | undefined,
  calls: FetchScenarioMock['mock']['calls']
) {
  return {
    environmentId: ENVIRONMENT_ID,
    observer: describeQueryPhase(observer),
    cache: describeQueryPhase(cached),
    requests: calls.map(describeFetchCall),
  };
}

function session(overrides: Partial<TerminalSession> = {}): TerminalSession {
  return {
    id: 'term-1',
    environmentId: ENVIRONMENT_ID,
    chatId: CHAT_ID,
    title: 'Terminal 1',
    shell: 'bash',
    cwd: null,
    cols: 80,
    rows: 24,
    status: 'running',
    attached: false,
    createdAt: 1,
    lastActivityAt: 1,
    ...overrides,
  };
}

describe('terminal-service', () => {
  const fetchScenario = createFetchScenario();

  beforeEach(() => {
    fetchScenario.install();
  });

  afterEach(() => {
    fetchScenario.restore();
  });

  describe('availability failure context', () => {
    it('names a missing cache and an observer with no request', () => {
      expect(
        describeAvailabilityQuery(
          { status: 'pending', fetchStatus: 'fetching', error: null },
          undefined,
          []
        )
      ).toEqual({
        environmentId: ENVIRONMENT_ID,
        observer: { status: 'pending', fetchStatus: 'fetching', error: null },
        cache: null,
        requests: [],
      });
    });

    it('distinguishes cache success from a pending observer', () => {
      expect(
        describeAvailabilityQuery(
          { status: 'pending', fetchStatus: 'fetching', error: null },
          { status: 'success', fetchStatus: 'idle', error: null },
          [[`/api/terminals/availability?environmentId=${ENVIRONMENT_ID}`]]
        )
      ).toEqual({
        environmentId: ENVIRONMENT_ID,
        observer: { status: 'pending', fetchStatus: 'fetching', error: null },
        cache: { status: 'success', fetchStatus: 'idle', error: null },
        requests: [
          { method: 'GET', path: `/api/terminals/availability?environmentId=${ENVIRONMENT_ID}` },
        ],
      });
    });

    it('retains errors and request methods without headers or payloads', () => {
      const failed: AvailabilityPhase = {
        status: 'error',
        fetchStatus: 'idle',
        error: new TypeError('fixture unavailable'),
      };
      expect(
        describeAvailabilityQuery(failed, failed, [
          [new URL('https://fixture.invalid/availability'), { method: 'get' }],
          [new Request('https://fixture.invalid/sessions', { method: 'POST' })],
          [
            new Request('https://fixture.invalid/rename', { method: 'POST' }),
            { method: 'patch', headers: { authorization: 'fixture-secret' }, body: 'hidden' },
          ],
        ])
      ).toEqual({
        environmentId: ENVIRONMENT_ID,
        observer: {
          status: 'error',
          fetchStatus: 'idle',
          error: 'TypeError: fixture unavailable',
        },
        cache: {
          status: 'error',
          fetchStatus: 'idle',
          error: 'TypeError: fixture unavailable',
        },
        requests: [
          { method: 'GET', path: '/availability' },
          { method: 'POST', path: '/sessions' },
          { method: 'PATCH', path: '/rename' },
        ],
      });
    });

    it('retains an invalid request URL without masking the query failure', () => {
      const context = describeAvailabilityQuery(
        { status: 'pending', fetchStatus: 'fetching', error: null },
        undefined,
        [['http://[']]
      );
      expect(context.requests).toEqual([
        { method: 'GET', url: 'http://[', urlError: expect.any(String) },
      ]);
    });
  });

  describe('terminalKeys', () => {
    it('scopes a session list under the environment-wide invalidation prefix', () => {
      const prefix = [...terminalKeys.sessionsForEnvironment(ENVIRONMENT_ID)];
      const scoped = [...terminalKeys.sessions(ENVIRONMENT_ID, CHAT_ID)];

      expect(scoped.slice(0, prefix.length)).toEqual(prefix);
    });

    it('keys an absent chat id as null rather than undefined, so the query key is stable', () => {
      expect(terminalKeys.sessions(ENVIRONMENT_ID)).toEqual([
        'terminals',
        'sessions',
        ENVIRONMENT_ID,
        null,
      ]);
    });
  });

  describe('useTerminalAvailabilityQuery', () => {
    it('fetches availability for the given environment', async () => {
      const availability: TerminalAvailability = {
        environmentId: ENVIRONMENT_ID,
        available: true,
        shells: ['bash'],
        openSessions: 0,
        maxSessions: 4,
      };
      fetchScenario.respondWithJson(
        'GET',
        `/api/terminals/availability?environmentId=${ENVIRONMENT_ID}`,
        { body: availability }
      );

      const { result } = renderHook(() => ({
        query: useTerminalAvailabilityQuery(ENVIRONMENT_ID),
        client: useQueryClient(),
      }));

      await waitFor(() => {
        const { query, client } = result.current;
        const context = describeAvailabilityQuery(
          query,
          client.getQueryState(terminalKeys.availability(ENVIRONMENT_ID)),
          fetchScenario.fetchMock.mock.calls
        );
        expect(query.isSuccess, JSON.stringify(context)).toBe(true);
      });
      expect(result.current.query.data).toEqual(availability);
    });

    it('retains the failing hook API error and captured route', async () => {
      fetchScenario.respondWithJson(
        'GET',
        `/api/terminals/availability?environmentId=${ENVIRONMENT_ID}`,
        {
          status: 503,
          body: { error: 'availability fixture unavailable', code: 'TERMINAL_DISABLED' },
        }
      );
      const { result } = renderHook(() => ({
        query: useTerminalAvailabilityQuery(ENVIRONMENT_ID),
        client: useQueryClient(),
      }));

      await waitFor(() => expect(result.current.query.isError).toBe(true));
      expect(
        describeAvailabilityQuery(
          result.current.query,
          result.current.client.getQueryState(terminalKeys.availability(ENVIRONMENT_ID)),
          fetchScenario.fetchMock.mock.calls
        )
      ).toEqual({
        environmentId: ENVIRONMENT_ID,
        observer: {
          status: 'error',
          fetchStatus: 'idle',
          error: 'ApiError: availability fixture unavailable',
        },
        cache: {
          status: 'error',
          fetchStatus: 'idle',
          error: 'ApiError: availability fixture unavailable',
        },
        requests: [
          { method: 'GET', path: `/api/terminals/availability?environmentId=${ENVIRONMENT_ID}` },
        ],
      });
    });

    it('does not fetch when disabled', () => {
      renderHook(() => useTerminalAvailabilityQuery(ENVIRONMENT_ID, false));

      expect(fetchScenario.fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('useTerminalSessionsQuery', () => {
    it('includes the chat id in the query string when given one', async () => {
      fetchScenario.respondWithJson(
        'GET',
        `/api/terminals?environmentId=${ENVIRONMENT_ID}&chatId=${CHAT_ID}`,
        { body: { sessions: [session()] } }
      );

      const { result } = renderHook(() => useTerminalSessionsQuery(ENVIRONMENT_ID, CHAT_ID));

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data).toEqual([session()]);
    });

    it('omits the chat id when listing every session for the environment', async () => {
      fetchScenario.respondWithJson('GET', `/api/terminals?environmentId=${ENVIRONMENT_ID}`, {
        body: { sessions: [] },
      });

      const { result } = renderHook(() => useTerminalSessionsQuery(ENVIRONMENT_ID, null));

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data).toEqual([]);
    });

    it('surfaces a failed request as an ApiError carrying the server message', async () => {
      fetchScenario.respondWithJson('GET', `/api/terminals?environmentId=${ENVIRONMENT_ID}`, {
        status: 403,
        body: { error: 'Terminals are disabled on this hub.', code: 'TERMINAL_DISABLED' },
      });

      const { result } = renderHook(() => useTerminalSessionsQuery(ENVIRONMENT_ID, null));

      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(result.current.error).toBeInstanceOf(ApiError);
      expect((result.current.error as ApiError).serverMessage).toBe(
        'Terminals are disabled on this hub.'
      );
      expect((result.current.error as ApiError).code).toBe('TERMINAL_DISABLED');
    });
  });

  describe('useOpenTerminalMutation', () => {
    it('posts the open body and resolves the created session', async () => {
      fetchScenario.respondWithJson('POST', '/api/terminals', { body: { session: session() } });

      const { result } = renderHook(() => useOpenTerminalMutation());
      result.current.mutate({ environmentId: ENVIRONMENT_ID, chatId: CHAT_ID });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data).toEqual(session());
      const [, init] = fetchScenario.fetchMock.mock.calls[0] ?? [];
      // eslint-disable-next-line @typescript-eslint/no-base-to-string -- The fixture expects the request body to contain serialized JSON.
      expect(JSON.parse(String(init?.body))).toEqual({
        environmentId: ENVIRONMENT_ID,
        chatId: CHAT_ID,
      });
    });
  });

  describe('useRenameTerminalMutation', () => {
    it('patches the title and resolves the renamed session', async () => {
      const renamed = session({ title: 'build' });
      fetchScenario.respondWithJson('PATCH', '/api/terminals/term-1', {
        body: { session: renamed },
      });

      const { result } = renderHook(() => useRenameTerminalMutation());
      result.current.mutate({ id: 'term-1', body: { title: 'build' } });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data).toEqual(renamed);
    });
  });

  describe('useCloseTerminalMutation', () => {
    it('resolves a bodyless 204 without throwing', async () => {
      fetchScenario.respondWithJson('DELETE', '/api/terminals/term-1', { status: 204 });

      const { result } = renderHook(() => useCloseTerminalMutation());
      result.current.mutate('term-1');

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
    });
  });
});
