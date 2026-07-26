import { afterEach, describe, expect, it } from 'bun:test';
import {
  InstallBlockedResponseSchema,
  InstallCancelResponseSchema,
  type InstallRecipePreview,
  InstallRecipePreviewSchema,
  type InstallRun,
  InstallRunListSchema,
  InstallStartResponseSchema,
  type InstallStreamEvent,
} from '@mangostudio/shared/environments';
import { Value } from '@sinclair/typebox/value';
import {
  InstallBlockedError,
  type InstallRequestContext,
  type InstallService,
} from '../../../src/modules/environments/application/install-service';
import { createInstallRoutes } from '../../../src/modules/environments/http/install-routes';
import {
  createApiTestApp,
  createAuthenticatedApiTestApp,
} from '../../support/harness/create-api-test-app';

const TEST_USER = {
  id: 'environment-installs-user',
  name: 'Environment Installs User',
  email: 'environment-installs@mangostudio.test',
};
const PREVIEW: InstallRecipePreview = {
  id: 'bun.update',
  runtimeId: 'bun',
  action: 'update',
  inputKind: 'none',
  platforms: ['darwin', 'linux'],
  argv: ['bun', 'upgrade'],
  copyCommand: 'bun upgrade',
  requires: ['bun'],
  writes: ['$BUN_INSTALL/bin/bun'],
  networkAccess: true,
  timeoutMs: 300_000,
  supported: true,
  missingRequirements: [],
  guard: { allowed: true, reasons: [] },
};
const RUN: InstallRun = {
  id: 'install-run-1',
  recipeId: 'bun.update',
  argv: ['bun', 'upgrade'],
  startedAt: 1_700_000_000_000,
  finishedAt: 1_700_000_001_000,
  exitCode: 0,
  status: 'succeeded',
  truncated: false,
};

let restoreAuth: (() => void) | null = null;

afterEach(() => {
  restoreAuth?.();
  restoreAuth = null;
});

function streamEvents(events: readonly InstallStreamEvent[]): AsyncIterable<InstallStreamEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      yield* events;
    },
  };
}

function createFakeService(
  options: { blocked?: boolean; stream?: readonly InstallStreamEvent[] } = {}
) {
  let startCalls = 0;
  let lastContext: InstallRequestContext | null = null;
  const service: InstallService = {
    listRecipes(context) {
      lastContext = context;
      return Promise.resolve([PREVIEW]);
    },
    prepare(_body, context) {
      lastContext = context;
      return Promise.resolve({
        preparationId: null,
        expiresAt: null,
        recipe: PREVIEW,
      });
    },
    start(_body, context) {
      startCalls += 1;
      lastContext = context;
      if (options.blocked) {
        throw new InstallBlockedError({
          ...PREVIEW,
          guard: { allowed: false, reasons: ['disabled'] },
        });
      }
      return Promise.resolve({ runId: RUN.id, attached: false });
    },
    cancel() {
      return Promise.resolve({ runId: RUN.id, cancellationRequested: true });
    },
    listRuns() {
      return Promise.resolve([RUN]);
    },
    getRunStream() {
      return Promise.resolve(
        streamEvents(
          options.stream ?? [
            { type: 'log', stream: 'stdout', line: 'hello', done: false },
            {
              type: 'exit',
              code: 0,
              status: 'succeeded',
              truncated: false,
              durationMs: 1000,
              done: true,
            },
          ]
        )
      );
    },
  };
  return {
    service,
    getStartCalls: () => startCalls,
    getLastContext: () => lastContext,
  };
}

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('environment install routes', () => {
  it('exposes schema-valid lifecycle responses and an SSE event stream', async () => {
    const fake = createFakeService();
    const { app, restore } = createAuthenticatedApiTestApp(
      TEST_USER,
      createInstallRoutes(fake.service)
    );
    restoreAuth = restore;

    const recipes = await app.handle(new Request('http://localhost/environments/install/recipes'));
    const start = await app.handle(
      jsonRequest('http://localhost/environments/install', {
        recipeId: 'bun.update',
        input: { kind: 'none' },
      })
    );
    const runs = await app.handle(new Request('http://localhost/environments/install/runs'));
    const cancel = await app.handle(
      new Request(`http://localhost/environments/install/${RUN.id}/cancel`, { method: 'POST' })
    );
    const log = await app.handle(
      new Request(`http://localhost/environments/install/${RUN.id}/log`)
    );

    const recipePayload = (await recipes.json()) as unknown[];
    expect(Value.Check(InstallRecipePreviewSchema, recipePayload[0])).toBe(true);
    expect(Value.Check(InstallStartResponseSchema, await start.json())).toBe(true);
    expect(Value.Check(InstallRunListSchema, await runs.json())).toBe(true);
    expect(Value.Check(InstallCancelResponseSchema, await cancel.json())).toBe(true);
    expect(log.headers.get('content-type')).toContain('text/event-stream');
    const streamed = (await log.text())
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice('data: '.length)) as InstallStreamEvent);
    expect(streamed.map((event) => event.type)).toEqual(['log', 'exit']);
  });

  it('rejects unknown recipes and hostile Node specs before calling the service', async () => {
    const fake = createFakeService();
    const { app, restore } = createAuthenticatedApiTestApp(
      TEST_USER,
      createInstallRoutes(fake.service)
    );
    restoreAuth = restore;
    const hostileSpecs = [
      '22; rm -rf ~',
      '$(whoami)',
      '`id`',
      '--',
      '../../x',
      '',
      '1'.repeat(10_000),
    ];

    const unknown = await app.handle(
      jsonRequest('http://localhost/environments/install', {
        recipeId: 'unknown.install',
        input: { kind: 'none' },
      })
    );
    const statuses = await Promise.all(
      hostileSpecs.map(async (version) => {
        const response = await app.handle(
          jsonRequest('http://localhost/environments/install', {
            recipeId: 'nvm.node.install',
            input: { kind: 'node-version', version },
          })
        );
        return response.status;
      })
    );

    expect(unknown.status).toBe(422);
    expect(statuses).toEqual(hostileSpecs.map(() => 422));
    expect(fake.getStartCalls()).toBe(0);
  });

  it('returns guard details for copy-command fallback', async () => {
    const fake = createFakeService({ blocked: true });
    const { app, restore } = createAuthenticatedApiTestApp(
      TEST_USER,
      createInstallRoutes(fake.service)
    );
    restoreAuth = restore;

    const response = await app.handle(
      jsonRequest('http://localhost/environments/install', {
        recipeId: 'bun.update',
        input: { kind: 'none' },
      })
    );
    const payload = (await response.json()) as {
      recipe: InstallRecipePreview;
    };

    expect(response.status).toBe(403);
    expect(Value.Check(InstallBlockedResponseSchema, payload)).toBe(true);
    expect(payload.recipe.copyCommand).toBe('bun upgrade');
    expect(payload.recipe.guard.reasons).toEqual(['disabled']);
  });

  it('uses only the socket peer for the local-surface decision', async () => {
    const fake = createFakeService();
    const { app, restore } = createAuthenticatedApiTestApp(
      TEST_USER,
      createInstallRoutes(fake.service)
    );
    restoreAuth = restore;

    await app.handle(
      new Request('http://localhost/environments/install/recipes', {
        headers: { 'x-forwarded-for': '127.0.0.1' },
      })
    );

    expect(fake.getLastContext()?.clientIp).toBeUndefined();
  });

  it('requires authentication for every install lifecycle route', async () => {
    const fake = createFakeService();
    const app = createApiTestApp(createInstallRoutes(fake.service));
    const requests = [
      new Request('http://localhost/environments/install/recipes'),
      jsonRequest('http://localhost/environments/install/prepare', {
        recipeId: 'bun.update',
        input: { kind: 'none' },
      }),
      jsonRequest('http://localhost/environments/install', {
        recipeId: 'bun.update',
        input: { kind: 'none' },
      }),
      new Request('http://localhost/environments/install/runs'),
      new Request(`http://localhost/environments/install/${RUN.id}/cancel`, { method: 'POST' }),
      new Request(`http://localhost/environments/install/${RUN.id}/log`),
    ];

    const responses = await Promise.all(requests.map((request) => app.handle(request)));

    expect(responses.map((response) => response.status)).toEqual(requests.map(() => 401));
    expect(fake.getStartCalls()).toBe(0);
  });
});
