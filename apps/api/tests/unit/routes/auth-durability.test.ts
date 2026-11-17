/**
 * Which Better Auth requests commit at synchronous = FULL on a relaxed hub database,
 * checked against the installed Better Auth and its plugins and against the library
 * itself running on a file database.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AUTH_BASE_PATH, createAuthInstance } from '../../../src/auth';
import { relaxDurability } from '../../../src/db/durability';
import {
  CREDENTIAL_REVOKING_AUTH_PATHS,
  handleAuthRequest,
  isCredentialRevokingRequest,
} from '../../../src/routes/auth';
import { MigratedDatabaseTemplate } from '../../support/migrated-database-template';
import {
  ObservedFileDatabase,
  SYNCHRONOUS_FULL as FULL,
  SYNCHRONOUS_NORMAL as NORMAL,
} from '../../support/observed-file-database';

const ORIGIN = 'http://localhost:3001';

/**
 * Every non-GET Better Auth endpoint that deletes no session, password or API key.
 * An endpoint the installed library adds must be put here or in
 * CREDENTIAL_REVOKING_AUTH_PATHS, so the choice is made when it appears.
 */
const NON_REVOKING_AUTH_PATHS: ReadonlySet<string> = new Set([
  '/api-key/create',
  '/callback/:id',
  '/change-email',
  '/get-access-token',
  '/get-session',
  '/link-social',
  '/refresh-token',
  '/request-password-reset',
  '/send-verification-email',
  '/sign-in/email',
  '/sign-in/social',
  '/sign-up/email',
  '/update-session',
  '/update-user',
  '/verify-password',
]);

let directory: string;
let file: ObservedFileDatabase;
let migrated: MigratedDatabaseTemplate | undefined;

// Migrating a fresh file costs one fsync per statement (see MigratedDatabaseTemplate), seconds
// per test on a Windows runner. Migrate once and give each test a copy.
beforeAll(async () => {
  migrated = await MigratedDatabaseTemplate.create('auth-durability');
}, 120_000);

afterAll(() => {
  migrated?.dispose();
});

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'auth-durability-'));
  if (!migrated) throw new Error('expected the migrated template from beforeAll | received: none');
  migrated.copyInto(directory);
  file = new ObservedFileDatabase(directory);
  await relaxDurability(file.db);
  file.forget();
});

afterEach(async () => {
  await file.destroy();
  rmSync(directory, { recursive: true, force: true });
});

const authUrl = (endpoint: string) => `${ORIGIN}${AUTH_BASE_PATH}${endpoint}`;

const post = (endpoint: string, init: { body?: unknown; cookie?: string } = {}) =>
  new Request(authUrl(endpoint), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: ORIGIN,
      ...(init.cookie ? { Cookie: init.cookie } : {}),
    },
    body: JSON.stringify(init.body ?? {}),
  });

/** The writes that ran after the last `PRAGMA synchronous` statement, which is the restore. */
function writesAfterLastRestore(): string[] {
  const statements = file.observed.map((entry) => entry.sql);
  const lastPragma = statements.map((sql) => /PRAGMA synchronous\s*=/i.test(sql)).lastIndexOf(true);
  return statements
    .slice(lastPragma + 1)
    .filter((statement) => /^\s*(insert|update|delete|replace)/i.test(statement));
}

describe('the endpoints of the installed Better Auth', () => {
  /** [path, methods] of every endpoint that has an HTTP path. */
  function installedEndpoints(): Array<{ path: string; methods: string[] }> {
    const auth = createAuthInstance(file.db);
    return Object.values(auth.api as unknown as Record<string, unknown>).flatMap((endpoint) => {
      const { path, options } = endpoint as { path?: string; options?: { method?: unknown } };
      if (!path) return [];
      const method = options?.method;
      const methods = (Array.isArray(method) ? method : [method]).map((value) => String(value));
      return [{ path, methods }];
    });
  }

  it('are each either listed as revoking a credential or as revoking nothing', () => {
    const unclassified = installedEndpoints()
      .filter(({ methods }) => methods.some((method) => method !== 'GET'))
      .map(({ path }) => path)
      .filter(
        (path) => !CREDENTIAL_REVOKING_AUTH_PATHS.has(path) && !NON_REVOKING_AUTH_PATHS.has(path)
      );

    expect({ unclassifiedNonGetEndpoints: unclassified }).toEqual({
      unclassifiedNonGetEndpoints: [],
    });
  });

  it('include every path the hub treats as revoking, so a renamed endpoint is not left behind', () => {
    const installed = new Set(installedEndpoints().map(({ path }) => path));

    const missing = [...CREDENTIAL_REVOKING_AUTH_PATHS].filter((path) => !installed.has(path));

    expect({ revokingPathsNotInstalled: missing }).toEqual({ revokingPathsNotInstalled: [] });
  });

  it('never list a path as both revoking and not', () => {
    const both = [...CREDENTIAL_REVOKING_AUTH_PATHS].filter((path) =>
      NON_REVOKING_AUTH_PATHS.has(path)
    );

    expect({ pathsInBothLists: both }).toEqual({ pathsInBothLists: [] });
  });
});

describe('isCredentialRevokingRequest', () => {
  const classify = (method: string, endpoint: string) =>
    isCredentialRevokingRequest(new Request(authUrl(endpoint), { method }));

  it('is true for a POST to a revoking endpoint, however its path is spelled', () => {
    expect({
      signOut: classify('POST', '/sign-out'),
      trailingSlash: classify('POST', '/sign-out/'),
      doubledSlash: classify('POST', '//sign-out'),
      upperCase: classify('POST', '/Sign-Out'),
      apiKeyDelete: classify('POST', '/api-key/delete'),
      changePassword: classify('POST', '/change-password'),
    }).toEqual({
      signOut: true,
      trailingSlash: true,
      doubledSlash: true,
      upperCase: true,
      apiKeyDelete: true,
      changePassword: true,
    });
  });

  it('is false for session reads, sign-in and sign-up, and for a GET', () => {
    expect({
      getSession: classify('POST', '/get-session'),
      signIn: classify('POST', '/sign-in/email'),
      signUp: classify('POST', '/sign-up/email'),
      getSignOut: classify('GET', '/sign-out'),
      outsideBasePath: isCredentialRevokingRequest(
        new Request(`${ORIGIN}/other/sign-out`, { method: 'POST' })
      ),
    }).toEqual({
      getSession: false,
      signIn: false,
      signUp: false,
      getSignOut: false,
      outsideBasePath: false,
    });
  });
});

describe('handleAuthRequest', () => {
  /** A handler that reports the level it ran at and what it read from the body. */
  class RecordingHandler {
    readonly levels: number[] = [];
    readonly bodies: string[] = [];

    readonly handle = async (request: Request): Promise<Response> => {
      this.levels.push(file.level());
      this.bodies.push(await request.text());
      return new Response('{}');
    };
  }

  it('runs a revoking request at FULL, with its body, and restores NORMAL after', async () => {
    const recorder = new RecordingHandler();

    await handleAuthRequest(post('/revoke-session', { body: { token: 'session-token' } }), {
      db: file.db,
      handler: recorder.handle,
    });

    expect({ levels: recorder.levels, bodies: recorder.bodies, afterwards: file.level() }).toEqual({
      levels: [FULL],
      bodies: ['{"token":"session-token"}'],
      afterwards: NORMAL,
    });
  });

  it('leaves get-session and sign-in at the connection level, without touching the pragma', async () => {
    const recorder = new RecordingHandler();

    await handleAuthRequest(post('/get-session'), { db: file.db, handler: recorder.handle });
    await handleAuthRequest(
      post('/sign-in/email', { body: { email: 'a@b.test', password: 'x' } }),
      {
        db: file.db,
        handler: recorder.handle,
      }
    );

    expect({
      levels: recorder.levels,
      pragmaWrites: file.observed.filter((entry) => /PRAGMA synchronous\s*=/i.test(entry.sql)),
    }).toEqual({ levels: [NORMAL, NORMAL], pragmaWrites: [] });
  });

  it('does not raise FULL until the whole body has arrived', async () => {
    const recorder = new RecordingHandler();
    let sendBody: (chunk: string) => void = () => undefined;
    const trickled = new ReadableStream<Uint8Array>({
      start(controller) {
        sendBody = (chunk) => {
          controller.enqueue(new TextEncoder().encode(chunk));
          controller.close();
        };
      },
    });
    const request = new Request(authUrl('/sign-out'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: trickled,
      // Required by the Fetch spec for a streamed request body.
      duplex: 'half',
    } as RequestInit);

    const pending = handleAuthRequest(request, { db: file.db, handler: recorder.handle });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const whileWaiting = {
      level: file.level(),
      pragmaWrites: file.observed.filter((entry) => /PRAGMA synchronous\s*=/i.test(entry.sql))
        .length,
      handlerCalls: recorder.levels.length,
    };
    sendBody('{}');
    await pending;

    expect({ whileWaiting, handlerLevels: recorder.levels, afterwards: file.level() }).toEqual({
      whileWaiting: { level: NORMAL, pragmaWrites: 0, handlerCalls: 0 },
      handlerLevels: [FULL],
      afterwards: NORMAL,
    });
  });
});

describe('the real Better Auth on a file database', () => {
  async function signUp(auth: ReturnType<typeof createAuthInstance>) {
    const response = await handleAuthRequest(
      post('/sign-up/email', {
        body: {
          email: `durability-${crypto.randomUUID()}@mangostudio.test`,
          password: 'correct-horse-battery-staple',
          name: 'Durability Tester',
        },
      }),
      { db: file.db, handler: (request) => auth.handler(request) }
    );
    const payload = (await response.json()) as { user?: { id: string } };
    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(';', 1)[0])
      .join('; ');
    expect({ status: response.status, userId: typeof payload.user?.id }).toEqual({
      status: 200,
      userId: 'string',
    });
    return { userId: payload.user?.id ?? '', cookie };
  }

  it('deletes the session on sign-out at FULL and commits nothing after the restore', async () => {
    const auth = createAuthInstance(file.db);
    const { cookie } = await signUp(auth);
    file.forget();

    const response = await handleAuthRequest(post('/sign-out', { cookie }), {
      db: file.db,
      handler: (request) => auth.handler(request),
    });

    expect({
      status: response.status,
      sessionDeleteLevel: file.levelOf(/delete from "session"/i),
      writesAfterRestore: writesAfterLastRestore(),
      afterwards: file.level(),
    }).toEqual({
      status: 200,
      sessionDeleteLevel: FULL,
      writesAfterRestore: [],
      afterwards: NORMAL,
    });
  });

  it('deletes an API key at FULL and commits nothing after the restore', async () => {
    const auth = createAuthInstance(file.db);
    const { cookie, userId } = await signUp(auth);
    const created = await auth.api.createApiKey({
      body: { userId, name: 'Durability key', metadata: { scope: 'full' } },
    });
    file.forget();

    const response = await handleAuthRequest(
      post('/api-key/delete', { cookie, body: { keyId: created.id } }),
      { db: file.db, handler: (request) => auth.handler(request) }
    );

    expect({
      status: response.status,
      apiKeyDeleteLevel: file.levelOf(/delete from "apikey"/i),
      writesAfterRestore: writesAfterLastRestore(),
      afterwards: file.level(),
    }).toEqual({
      status: 200,
      apiKeyDeleteLevel: FULL,
      writesAfterRestore: [],
      afterwards: NORMAL,
    });
  });
});
