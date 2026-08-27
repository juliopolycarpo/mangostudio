/**
 * The plugin surface `app.ts` composes, asserted over the real application.
 *
 * CORS, OpenAPI, the two file-serving prefixes, the root WebSocket transport,
 * and the request logger are all configured once at the top of `app.ts` and
 * never referenced again. Nothing downstream would fail to compile if a plugin
 * started answering on a different path, dropped an origin check, stopped
 * emitting an operation, or dropped the transport caps — the only evidence is
 * the HTTP or WebSocket response, so that is what these assert.
 *
 * The OpenAPI document doubles as a route inventory. A framework change that
 * silently drops a route would leave every other suite green, because a suite
 * only covers routes it already knows about; comparing the generated
 * path-to-methods map against a checked-in fixture is what makes a missing
 * route visible.
 */

import { describe, expect, it } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { app } from '../../../src/app';
import { getConfig, loadConfigForTest } from '../../../src/lib/config';
import { REALTIME_WEBSOCKET_OPTIONS } from '../../../src/modules/realtime/http/realtime-routes';
import { SPLIT_DEPLOYMENT_TEST_ORIGIN } from '../../support/setup/test-environment';

const ROUTE_INVENTORY_FIXTURE = join(
  import.meta.dir,
  '../../support/fixtures/openapi-route-inventory.json'
);

type OpenApiOperation = {
  operationId?: string;
  parameters?: { name: string; in: string; required?: boolean; schema?: Record<string, unknown> }[];
  requestBody?: {
    required?: boolean;
    content: Record<string, { schema: Record<string, unknown> }>;
  };
  responses?: Record<string, { content?: Record<string, { schema?: Record<string, unknown> }> }>;
};
type OpenApiDocument = {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, Record<string, OpenApiOperation>>;
};

const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace']);

let cachedDocument: OpenApiDocument | null = null;

async function openApiDocument(): Promise<OpenApiDocument> {
  if (cachedDocument) return cachedDocument;
  const response = await app.handle(new Request('http://localhost/scalar/json'));
  expect(response.status).toBe(200);
  cachedDocument = (await response.json()) as OpenApiDocument;
  return cachedDocument;
}

/**
 * Reduce the document to `path -> sorted methods`.
 *
 * Descriptions, schema bodies, and generator ordering are all deliberately
 * discarded: they churn on every unrelated edit, and the question this fixture
 * answers is only "is every route still published under the same path and
 * method".
 *
 * `/uploads` is excluded because `@elysia/static` derives its routes from
 * whatever is on disk when the plugin is registered — it publishes a `/uploads/*`
 * wildcard when the directory is absent and nothing when it is populated. That
 * makes its footprint a property of the machine rather than of the API, so
 * pinning it would fail on any checkout whose uploads directory differs. The
 * prefix's real behavior is asserted separately below and in
 * `tests/unit/server/frontend-static.test.ts`.
 */
function routeInventory(document: OpenApiDocument): Record<string, string[]> {
  const inventory: Record<string, string[]> = {};
  for (const path of Object.keys(document.paths).sort()) {
    if (path === '/uploads' || path.startsWith('/uploads/')) continue;
    const methods = Object.keys(document.paths[path] ?? {})
      .filter((key) => HTTP_METHODS.has(key.toLowerCase()))
      .map((key) => key.toLowerCase())
      .sort();
    inventory[path] = methods;
  }
  return inventory;
}

// These are behavioural on purpose, and they can be: the CORS middleware is
// ours (`app.ts`), so it runs under `bun test` like any other route code. The
// third gate reading the same cfg.corsOrigins — Better Auth's trustedOrigins —
// cannot be tested this way, because Better Auth turns its origin check off
// when NODE_ENV=test. See apps/api/tests/unit/auth.test.ts for why that one is
// asserted structurally, and scripts/test-build.ts for where it is exercised
// for real.
describe('CORS policy', () => {
  it('grants a configured origin credentialed access with the configured verbs', async () => {
    const response = await app.handle(
      new Request('http://localhost/api/health', {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://localhost:3001',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'content-type',
        },
      })
    );

    expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:3001');
    expect(response.headers.get('access-control-allow-credentials')).toBe('true');
    expect(response.headers.get('access-control-allow-methods')).toBe(
      'GET, POST, PUT, DELETE, OPTIONS'
    );
    expect(response.headers.get('access-control-allow-headers')).toBe(
      'Content-Type, Authorization, x-api-key'
    );
    expect(response.headers.get('vary')).toContain('Origin');
  });

  // The split deployment `MANGO_API_URL` exists for: the bundle is served from
  // another origin, and `server.allowedOrigins` is the only thing that can tell
  // this API about it. The test environment sets that key, so an accepted
  // foreign origin here is evidence the setting reaches the CORS middleware.
  it('grants an origin configured through server.allowedOrigins', async () => {
    const response = await app.handle(
      new Request('http://localhost/api/health', {
        method: 'OPTIONS',
        headers: {
          Origin: SPLIT_DEPLOYMENT_TEST_ORIGIN,
          'Access-Control-Request-Method': 'POST',
        },
      })
    );

    expect(getConfig().server.allowedOrigins).toContain(SPLIT_DEPLOYMENT_TEST_ORIGIN);
    expect(response.headers.get('access-control-allow-origin')).toBe(SPLIT_DEPLOYMENT_TEST_ORIGIN);
    expect(response.headers.get('access-control-allow-credentials')).toBe('true');
  });

  it('withholds the allow-origin header from an origin that is not configured', async () => {
    const response = await app.handle(
      new Request('http://localhost/api/health', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://attacker.example',
          'Access-Control-Request-Method': 'POST',
        },
      })
    );

    // Absence is the refusal: a browser only releases a credentialed response
    // when the origin is echoed back. `allow-credentials` alone grants nothing,
    // so the assertion that matters is that the echo is missing.
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('withholds it from the retired Vite dev-server origin too', async () => {
    // :5173 was allowed while Vite served the frontend on its own origin. The
    // API serves it now, so that origin is as untrusted as any other.
    const response = await app.handle(
      new Request('http://localhost/api/health', {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://localhost:5173',
          'Access-Control-Request-Method': 'POST',
        },
      })
    );

    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  // Regression: the gate must read the live config, not a snapshot from
  // `app.ts`'s module evaluation. Under the shared-module-graph lane the app
  // is first imported by whichever test file loads it first — which may be
  // *while* an earlier file's `loadConfigForTest` override is still installed,
  // since module evaluation runs before any `beforeEach` restores the base
  // config. A snapshot taken then silently drops `server.allowedOrigins`
  // (observed: shard 3 of PR #951's first CI run). `app` was imported at the
  // top of this file, so granting an origin configured only now proves the
  // check is per-request.
  it('honors a config loaded after the app module was evaluated', async () => {
    const lateOrigin = 'https://late-config.test';
    loadConfigForTest({
      server: { host: '0.0.0.0', port: 3001, publicUrl: '', allowedOrigins: [lateOrigin] },
    });

    const granted = await app.handle(
      new Request('http://localhost/api/health', {
        method: 'OPTIONS',
        headers: { Origin: lateOrigin, 'Access-Control-Request-Method': 'POST' },
      })
    );
    const revoked = await app.handle(
      new Request('http://localhost/api/health', {
        method: 'OPTIONS',
        headers: { Origin: SPLIT_DEPLOYMENT_TEST_ORIGIN, 'Access-Control-Request-Method': 'POST' },
      })
    );

    expect(granted.headers.get('access-control-allow-origin')).toBe(lateOrigin);
    // The base-config origin is gone from the loaded config, so an echo here
    // would mean the gate is still serving the first-import snapshot.
    expect(revoked.headers.get('access-control-allow-origin')).toBeNull();
    // The global beforeEach reinstalls the base test config for later tests.
  });
});

describe('OpenAPI document', () => {
  it('serves the Scalar UI and the generated document', async () => {
    // The exact paths the current plugin publishes. PR-002-style plugin swaps
    // must prove these rather than assume them: `/scalar/json` in particular is
    // a plugin-owned convention, not something this repository declares.
    const ui = await app.handle(new Request('http://localhost/scalar'));
    expect(ui.status).toBe(200);
    expect(ui.headers.get('content-type')).toContain('text/html');

    const document = await app.handle(new Request('http://localhost/scalar/json'));
    expect(document.status).toBe(200);
    expect(document.headers.get('content-type')).toContain('application/json');
  });

  it('keeps the declared document metadata', async () => {
    const document = await openApiDocument();

    expect(document.openapi.startsWith('3.')).toBe(true);
    expect(document.info.title).toBe('MangoStudio API');
    expect(document.info.version).toBe('1.0.0');
  });

  it('publishes exactly the recorded set of paths and methods', async () => {
    const document = await openApiDocument();
    const expected = (await Bun.file(ROUTE_INVENTORY_FIXTURE).json()) as Record<string, string[]>;

    // Adding or removing a route updates the fixture in the same commit: apply
    // the failure diff to `openapi-route-inventory.json`, then `bun run fix` to
    // format it. A diff nobody intended is a route the framework stopped
    // publishing — which no other suite can see, because a suite only covers
    // the routes it already knows about.
    expect(routeInventory(document)).toEqual(expected);
  });

  it('describes a path parameter with its constraints', async () => {
    const document = await openApiDocument();
    const operation = document.paths['/api/api-keys/{id}']?.delete;

    expect(operation?.parameters).toContainEqual(
      expect.objectContaining({
        name: 'id',
        in: 'path',
        required: true,
        schema: expect.objectContaining({ type: 'string', minLength: 1 }),
      })
    );
  });

  it('describes a multipart file body as a binary string', async () => {
    const document = await openApiDocument();
    const body = document.paths['/api/upload/chat']?.post?.requestBody;
    const multipart = body?.content['multipart/form-data']?.schema as
      | { required?: string[]; properties?: Record<string, Record<string, unknown>> }
      | undefined;

    expect(body?.required).toBe(true);
    expect(multipart?.required).toEqual(['chatId', 'file']);
    // `format: 'binary'` is what makes generated clients send bytes and what
    // renders the upload control in Scalar, so it is pinned here.
    //
    // The declared `maxSize` is deliberately *not* asserted. A file schema
    // serializes to an opaque marker whose size and MIME constraints live in
    // non-enumerable closures on a frozen object, so no consumer of the schema
    // can read them back — the limit is still enforced at request time, it is
    // simply no longer publishable. It was never a standard OpenAPI keyword.
    expect(multipart?.properties?.file).toMatchObject({ type: 'string', format: 'binary' });
  });

  it('publishes no framework-internal schema markers', async () => {
    const document = await openApiDocument();

    // Internal marker keys (`~kind`, `~elyTyp`) are how the framework tags
    // schema nodes it handles natively; they are meaningless to an OpenAPI
    // consumer and make a document fail strict validation. A file schema is the
    // node that carries them, and converting it back to a documentable shape is
    // patched into the plugin — so this asserts across the whole document
    // rather than one route: it is the check that fails loudly if that patch
    // ever stops being applied, which is otherwise silent.
    const markers = JSON.stringify(document).match(/"~[A-Za-z]+"/g);

    expect([...new Set(markers ?? [])]).toEqual([]);
  });

  it('describes a JSON response body with its required fields', async () => {
    const document = await openApiDocument();
    const schema = document.paths['/api/upload/chat']?.post?.responses?.['200']?.content?.[
      'application/json'
    ]?.schema as { required?: string[] } | undefined;

    expect(schema?.required).toEqual(['attachment']);
  });

  it('describes error responses with the shared ApiErrorResponse shape', async () => {
    const document = await openApiDocument();

    for (const status of ['400', '401']) {
      const schema = document.paths['/api/api-keys/{id}']?.delete?.responses?.[status]?.content?.[
        'application/json'
      ]?.schema as { required?: string[]; properties?: Record<string, unknown> } | undefined;

      // `ApiErrorResponse` is `{ error, code?, details? }`. Published inline
      // rather than as a `$ref`, so the shape is asserted directly.
      expect(schema?.required).toEqual(['error']);
      expect(Object.keys(schema?.properties ?? {})).toEqual(['error', 'code', 'details']);
    }
  });

  it('gives every published operation an operation id', async () => {
    const document = await openApiDocument();
    const missing: string[] = [];

    for (const [path, operations] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        if (!HTTP_METHODS.has(method.toLowerCase())) continue;
        if (!operation.operationId) missing.push(`${method.toUpperCase()} ${path}`);
      }
    }

    expect(missing).toEqual([]);
  });
});

describe('file-serving prefixes', () => {
  it('answers a missing generated image with 404 rather than an SPA shell', async () => {
    const response = await app.handle(new Request('http://localhost/images/not-there.png'));

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type') ?? '').not.toContain('text/html');
  });

  it('refuses a generated-image path that escapes the images directory', async () => {
    // `new Request` canonicalizes `/images/../../etc/passwd` to `/etc/passwd`
    // before `app.handle` sees it, so that form never reaches `/images/*`.
    // Encoded separators keep the `/images/` prefix and still decode to a
    // traversal once the handler resolves the splat.
    const response = await app.handle(new Request('http://localhost/images/..%2f..%2fetc/passwd'));

    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Not found');
    expect(response.headers.get('content-type') ?? '').not.toContain('text/html');
  });

  it('leaves the uploads prefix unclaimed by any API route', async () => {
    // `staticPlugin` enumerates its directory once at registration, so serving
    // a real file is covered where the plugin can be mounted over a fixture
    // directory (`frontend-static.test.ts`). What the composed app has to
    // guarantee is narrower and just as easy to break: nothing else answers
    // here, so a real upload is never shadowed.
    const response = await app.handle(new Request('http://localhost/uploads/not-there.png'));

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type') ?? '').not.toContain('text/html');
  });
});

describe('request logging', () => {
  it('logs API requests and stays silent for frontend assets', async () => {
    const previous = process.env.MANGOSTUDIO_DIAGNOSTIC_LOGS;
    const originalWarn = console.warn;
    const captured: string[] = [];

    process.env.MANGOSTUDIO_DIAGNOSTIC_LOGS = '1';
    console.warn = (line: unknown) => captured.push(String(line));

    try {
      await app.handle(new Request('http://localhost/api/health'));
      await app.handle(new Request('http://localhost/assets/index-AbCd1234.js'));
      await app.handle(new Request('http://localhost/uploads/anything.png'));
      await app.handle(new Request('http://localhost/some-spa-route'));
    } finally {
      console.warn = originalWarn;
      if (previous === undefined) delete process.env.MANGOSTUDIO_DIAGNOSTIC_LOGS;
      else process.env.MANGOSTUDIO_DIAGNOSTIC_LOGS = previous;
    }

    // The `onRequest` hook filters on the path prefix. Without the filter every
    // asset fetch in a browser session writes a structured log line, which is
    // what made the logs unusable before it was added.
    const logged = captured
      .map((line) => {
        try {
          return JSON.parse(line) as { scope?: string; metadata?: { path?: string } };
        } catch {
          return null;
        }
      })
      .filter((entry): entry is { scope?: string; metadata?: { path?: string } } => entry !== null)
      .filter((entry) => entry.scope === 'request')
      .map((entry) => entry.metadata?.path);

    expect(logged).toEqual(['/api/health']);
  });
});

describe('root WebSocket transport', () => {
  it('applies the payload cap on the exported application', async () => {
    // The transport caps are a constructor option on this instance, not a
    // route plugin. `app.handle` cannot see them, so the assertion has to
    // listen on the composed app rather than rebuild a root that happens to
    // pass the same object.
    // The static plugin enumerates its assets directory when the server starts,
    // not when it is registered. The shared `afterEach` deletes the whole test
    // sandbox — uploads directory included — so by the time this runs, the
    // directory `app.ts` was configured to serve is gone and the listen fails
    // asynchronously: a port is still assigned, and the failure only shows up
    // as the connection below being reset.
    mkdirSync(getConfig().uploads.dir, { recursive: true });

    app.listen(0);
    const port = (app.server as { port?: number } | null)?.port;
    expect(port).toBeNumber();

    try {
      const signup = await fetch(`http://127.0.0.1:${port}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: `ws-cap-${crypto.randomUUID()}@mangostudio.test`,
          password: 'correct-horse-battery-staple',
          name: 'Payload Cap Tester',
        }),
      });
      expect(signup.status).toBe(200);
      const cookie = signup.headers
        .getSetCookie()
        .map((value) => value.split(';', 1)[0])
        .join('; ');
      expect(cookie).not.toBe('');

      const socket = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, {
        headers: { Cookie: cookie },
      });
      const closed = new Promise<CloseEvent>((resolve) => {
        socket.addEventListener('close', (event) => resolve(event as CloseEvent), { once: true });
      });
      const ready = new Promise<void>((resolve, reject) => {
        socket.addEventListener('error', () => reject(new Error('WebSocket failed to open')), {
          once: true,
        });
        socket.addEventListener('message', (event) => {
          const message = JSON.parse(String(event.data)) as { type?: string };
          if (message.type === 'ready') resolve();
        });
      });
      await ready;

      socket.send('x'.repeat(REALTIME_WEBSOCKET_OPTIONS.maxPayloadLength + 1));

      expect((await closed).code).not.toBe(1000);
    } finally {
      void app.server?.stop(true);
    }
  });
});
