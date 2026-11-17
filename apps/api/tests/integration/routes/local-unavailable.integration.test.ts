/**
 * Every route that needs an environment answers an unreachable one the same
 * way: 503, `PROVIDER_ERROR`, a fixed message and `details.reason`, with the
 * connection manager's own text kept out of the body.
 *
 * Only a connect failure the manager raised maps. A runtime that sends
 * `UNAVAILABLE` itself, or a session that closes mid-request, may already have
 * done the work, so those stay 500 and are never presented as retryable.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { RemoteError, RESERVED_ERROR_CODES } from '@mangostudio/protocol';
import { DEFAULT_LIBRARY_LOCATION_SETTINGS } from '@mangostudio/shared/app-settings';
import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import { ApiErrorResponseSchema } from '@mangostudio/shared/errors';
import { RUNTIME_ALREADY_BOUND_CLOSE_CODE } from '@mangostudio/shared/runtime-contract';
import { Elysia } from 'elysia';
import Value from 'typebox/value';

import { app } from '../../../src/app';
import { getDb } from '../../../src/db/database';
import {
  ENVIRONMENT_UNAVAILABLE_REASONS,
  EnvironmentUnavailableError,
  MAX_RETRY_AFTER_SECONDS,
} from '../../../src/lib/environment-unavailable';
import { sseResponse } from '../../../src/lib/sse-stream';
import { setLibraryLocationDefaultsForTest } from '../../../src/modules/app-settings/application/app-settings-service';
import { runGit } from '../../../src/modules/git/infrastructure/git-cli';
import { runGh } from '../../../src/modules/github/infrastructure/gh-cli';
import { errorHandler } from '../../../src/plugins/error-handler';
import {
  BOUND_ELSEWHERE_RETRY_MS,
  getRuntimeClient,
  RuntimeConnectionManager,
  setRuntimeConnectionManagerForTests,
} from '../../../src/services/runtime-client/runtime-connection-manager';
import { DiagnosticWarnCapture } from '../../support/diagnostic-warn-capture';
import { insertTestChat, insertTestUser, type UserFixture } from '../../support/factories';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';

/**
 * What a real connect failure carries: a hub path, a user name and the
 * environment variable that fixes it. None of it may reach an HTTP client.
 */
const LEAKY_DIAGNOSTIC =
  'No mangostudio-runtime binary was found; searched /home/alice/mango/target/debug/mangostudio-runtime. Set MANGOSTUDIO_RUNTIME_BINARY to a runtime binary.';

function refuseLocalConnect(): Promise<never> {
  return Promise.reject(new RemoteError(RESERVED_ERROR_CODES.UNAVAILABLE, LEAKY_DIAGNOSTIC));
}

let user: UserFixture;
let chatId: string;
let manager: RuntimeConnectionManager;
let restoreAuth: (() => void) | null = null;

function managerWith(connector: () => Promise<never>): RuntimeConnectionManager {
  return new RuntimeConnectionManager({
    resolveEnvironment: (userId) =>
      Promise.resolve({
        id: LOCAL_ENVIRONMENT_ID,
        userId,
        name: 'Local',
        transportKind: 'in-process' as const,
        config: {},
        enabled: true,
      }),
    connectors: { 'in-process': connector },
  });
}

beforeEach(async () => {
  user = await insertTestUser();
  chatId = (await insertTestChat(user.id)).id;
  await getDb().updateTable('chats').set({ workdir: '/tmp' }).where('id', '=', chatId).execute();
  // Real detection, so the settings routes that probe Local really do.
  setLibraryLocationDefaultsForTest(null);
  manager = managerWith(refuseLocalConnect);
  setRuntimeConnectionManagerForTests(manager);
  restoreAuth = createAuthenticatedApiTestApp(user).restore;
});

afterEach(async () => {
  restoreAuth?.();
  restoreAuth = null;
  setLibraryLocationDefaultsForTest(DEFAULT_LIBRARY_LOCATION_SETTINGS);
  await manager.closeAll();
  setRuntimeConnectionManagerForTests(undefined);
});

interface LocalReachingRoute {
  readonly method: 'GET' | 'POST' | 'PUT';
  readonly path: (chatId: string) => string;
  readonly body?: unknown;
}

const get = (path: string): LocalReachingRoute => ({ method: 'GET', path: () => path });

/** Every route found to reach an environment; the guard test covers the rest. */
const LOCAL_REACHING_ROUTES: readonly LocalReachingRoute[] = [
  get('/api/library/resources'),
  get('/api/library/settings'),
  get('/api/library/settings/compare'),
  get('/api/library/settings/claude'),
  get('/api/environments/runtimes'),
  get('/api/environments/runtimes/node'),
  get('/api/environments/version-managers'),
  get('/api/environments/version-managers/nvm'),
  get('/api/environments/agents'),
  get('/api/environments/agents/claude'),
  get('/api/settings/agents'),
  get('/api/settings/agents/default'),
  get('/api/skills'),
  { method: 'PUT', path: () => '/api/settings/app', body: {} },
  get('/api/workspace/fs/'),
  { method: 'POST', path: () => '/api/workspace/fs/validate', body: { path: '/tmp' } },
  { method: 'GET', path: (id) => `/api/chats/${id}/capabilities` },
];

function request(route: LocalReachingRoute): Request {
  return new Request(`http://localhost${route.path(chatId)}`, {
    method: route.method,
    ...(route.body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(route.body) }),
  });
}

describe('routes that reach an unavailable Local environment', () => {
  it.each(LOCAL_REACHING_ROUTES.map((route) => [`${route.method} ${route.path('<chat>')}`, route]))(
    '%s answers 503 PROVIDER_ERROR without the diagnostic',
    async (label, route) => {
      const response = await app.handle(request(route as LocalReachingRoute));
      const text = await response.text();
      const received = `${label} -> ${response.status} ${text}`;

      expect(
        response.status,
        `(${label}): expected status 503 for an unavailable Local | received: ${received}`
      ).toBe(503);
      const body: unknown = JSON.parse(text);
      expect(
        Value.Check(ApiErrorResponseSchema, body),
        `(${label}): expected an ApiErrorResponse body | received: ${text}`
      ).toBe(true);
      expect(body, `(${label}): expected code PROVIDER_ERROR | received: ${text}`).toMatchObject({
        code: 'PROVIDER_ERROR',
      });
      const reason = (body as { details?: { reason?: string } }).details?.reason ?? '';
      expect(
        (ENVIRONMENT_UNAVAILABLE_REASONS as readonly string[]).includes(reason),
        `(${label}): expected details.reason to be one of ${ENVIRONMENT_UNAVAILABLE_REASONS.join(', ')} | received: ${text}`
      ).toBe(true);
      expect(
        text,
        `(${label}): expected no hub path, user name or MANGOSTUDIO_ variable in the body | received: ${text}`
      ).not.toMatch(/\/home\/|alice|MANGOSTUDIO_/);
    }
  );

  it('answers 503 with Retry-After once the manager has scheduled the next attempt', async () => {
    await app.handle(new Request('http://localhost/api/environments/runtimes'));
    const retried = await app.handle(new Request('http://localhost/api/environments/runtimes'));
    const text = await retried.text();

    expect(
      retried.status,
      `(runtimes retry): expected status 503 | received: ${retried.status} ${text}`
    ).toBe(503);
    // Still inside the backoff window, the refusal keeps the last real cause.
    expect(JSON.parse(text)).toMatchObject({ details: { reason: 'start-failed' } });
    const retryAfter = Number(retried.headers.get('retry-after'));
    expect(
      retryAfter > 0 && retryAfter <= MAX_RETRY_AFTER_SECONDS,
      `(runtimes retry): expected Retry-After in 1..${MAX_RETRY_AFTER_SECONDS} seconds | received: ${retried.headers.get('retry-after')}`
    ).toBe(true);
  });
});

describe('refusals inside the backoff window', () => {
  it('logs the full diagnostic once per real connect attempt, not once per request', async () => {
    const capture = new DiagnosticWarnCapture();
    const lines = await capture.during(async () => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await app.handle(new Request('http://localhost/api/environments/runtimes'));
      }
    });

    const connectLines = lines.filter((line) => line.includes('"connect_failed"'));
    expect(
      connectLines.length,
      `(connect log): expected 1 connect_failed entry for 5 refused requests | received: ${connectLines.length} in ${lines.join(' ; ')}`
    ).toBe(1);
    expect(connectLines[0]).toContain('/home/alice');
  });

  it.each([
    [
      'bound-elsewhere',
      new RemoteError(RESERVED_ERROR_CODES.UNAVAILABLE, 'already bound', {
        closeCode: RUNTIME_ALREADY_BOUND_CLOSE_CODE,
      }),
    ],
    [
      'binary-missing',
      new RemoteError(RESERVED_ERROR_CODES.UNAVAILABLE, 'no binary', {
        localFailureReason: 'binary-missing',
      }),
    ],
  ] as const)('keeps the %s reason on later requests in the window', async (reason, failure) => {
    const failing = managerWith(() => Promise.reject(failure));
    setRuntimeConnectionManagerForTests(failing);

    const reasons: unknown[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const error = await getRuntimeClient(user.id, LOCAL_ENVIRONMENT_ID).then(
        () => null,
        (caught: unknown) => caught
      );
      reasons.push(error instanceof EnvironmentUnavailableError ? error.reason : String(error));
    }
    await failing.closeAll();

    expect(
      reasons,
      `(${reason}): expected every refusal to name ${reason} | received: ${reasons.join(', ')}`
    ).toEqual([reason, reason, reason]);
  });
});

describe('errors that are not a connect failure', () => {
  const NOT_RETRYABLE: ReadonlyArray<readonly [string, RemoteError]> = [
    [
      'a runtime-sent UNAVAILABLE',
      new RemoteError(RESERVED_ERROR_CODES.UNAVAILABLE, 'terminal capacity is full'),
    ],
    [
      'a session closed mid-request',
      new RemoteError(RESERVED_ERROR_CODES.UNAVAILABLE, 'session closed', { closeCode: 1006 }),
    ],
  ];

  it.each(NOT_RETRYABLE)('%s stays a 500 INTERNAL, never a retryable 503', async (label, error) => {
    const failing = new Elysia().get('/boom', () => {
      throw error;
    });
    const response = await new Elysia()
      .use(errorHandler)
      .use(failing)
      .handle(new Request('http://localhost/boom'));
    const text = await response.text();

    expect(
      response.status,
      `(${label}): expected status 500 | received: ${response.status} ${text}`
    ).toBe(500);
    expect(JSON.parse(text)).toEqual({
      error: 'An internal error occurred',
      code: 'INTERNAL',
    });
    expect(response.headers.get('retry-after')).toBeNull();
  });
});

describe('Retry-After bound', () => {
  it('clamps a wait to one hour', () => {
    const error = new EnvironmentUnavailableError('backing-off', 'wait', {
      retryAfterSeconds: 10 ** 9,
    });
    expect(
      error.retryAfterSeconds,
      `(EnvironmentUnavailableError): expected retryAfterSeconds <= ${MAX_RETRY_AFTER_SECONDS} | received: ${error.retryAfterSeconds}`
    ).toBe(MAX_RETRY_AFTER_SECONDS);
  });

  it('ignores a retryAfterSeconds a peer put in its refusal details', async () => {
    const boundElsewhere = new RemoteError(RESERVED_ERROR_CODES.UNAVAILABLE, 'already bound', {
      closeCode: RUNTIME_ALREADY_BOUND_CLOSE_CODE,
      retryAfterSeconds: 999_999,
    });
    const bound = managerWith(() => Promise.reject(boundElsewhere));
    setRuntimeConnectionManagerForTests(bound);

    const failure = await getRuntimeClient(user.id, LOCAL_ENVIRONMENT_ID).then(
      () => null,
      (error: unknown) => error
    );
    await bound.closeAll();

    expect(failure).toBeInstanceOf(EnvironmentUnavailableError);
    const error = failure as EnvironmentUnavailableError;
    expect(
      [error.reason, error.retryAfterSeconds],
      `(bound elsewhere): expected the manager's own ${BOUND_ELSEWHERE_RETRY_MS / 1_000}s wait, not the peer's | received: ${error.retryAfterSeconds}`
    ).toEqual(['bound-elsewhere', BOUND_ELSEWHERE_RETRY_MS / 1_000]);
  });
});

describe('callers that wrap runtime failures', () => {
  it('runGit lets a connect refusal through instead of a GitCliError', async () => {
    const failure = await runGit(['status'], { cwd: '/tmp', userId: user.id }).then(
      () => null,
      (error: unknown) => error
    );
    expect(
      failure,
      `(runGit): expected an EnvironmentUnavailableError | received: ${String(failure)}`
    ).toBeInstanceOf(EnvironmentUnavailableError);
  });

  it('runGh lets a connect refusal through instead of a GhCliError', async () => {
    const failure = await runGh(['pr', 'list'], { cwd: '/tmp', userId: user.id }).then(
      () => null,
      (error: unknown) => error
    );
    expect(
      failure,
      `(runGh): expected an EnvironmentUnavailableError | received: ${String(failure)}`
    ).toBeInstanceOf(EnvironmentUnavailableError);
  });
});

/** A progress source whose first `next()` rejects, as a read that reaches an unreachable environment does. */
class UnreachableEnvironmentProgress implements AsyncIterable<object>, AsyncIterator<object> {
  [Symbol.asyncIterator](): AsyncIterator<object> {
    return this;
  }
  next(): Promise<IteratorResult<object>> {
    return Promise.reject(new EnvironmentUnavailableError('binary-missing', LEAKY_DIAGNOSTIC));
  }
}

describe('unavailable environment on an SSE stream', () => {
  it('ends with one SSEErrorEvent carrying PROVIDER_ERROR and the fixed text', async () => {
    const text = await sseResponse(new UnreachableEnvironmentProgress(), 'Stream failed.').text();
    const frames = text
      .split('\n\n')
      .filter((frame) => frame.startsWith('data: '))
      .map((frame) => JSON.parse(frame.slice('data: '.length)) as unknown);

    expect(
      frames,
      `(sse): expected one error event {type:'error', code:'PROVIDER_ERROR', done:true} with the fixed text | received: ${text}`
    ).toEqual([
      {
        type: 'error',
        error: 'The runtime for this environment is not installed on the hub.',
        code: 'PROVIDER_ERROR',
        done: true,
      },
    ]);
  });
});
