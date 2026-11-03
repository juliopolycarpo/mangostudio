/**
 * Tool avatar images: what may be stored, and how it comes back out.
 *
 * The upload and serve halves are exercised through the routes, because the
 * headers are half the security story. The remote-URL half is exercised through
 * the service, which is where the fetch seam is injected — no test here opens a
 * socket or resolves a name.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';

import { ERROR_CODES } from '@mangostudio/shared/errors';
import { DEFAULT_PROFILE_ID } from '@mangostudio/shared/profiles';
import {
  type ToolIdentityListResponse,
  ToolIdentityListResponseSchema,
  type ToolIdentityUpdateResponse,
  ToolIdentityUpdateResponseSchema,
} from '@mangostudio/shared/tool-identity';
import Value from 'typebox/value';

import { getDb } from '../../../src/db/database';
import { getConfig } from '../../../src/lib/config';
import {
  updateToolIdentity,
  uploadToolIdentityImage,
} from '../../../src/modules/tool-identity/application/tool-identity-service';
import { storeUploadedToolImage } from '../../../src/modules/tool-identity/application/tool-image-service';
import { toolIdentityRoutes } from '../../../src/modules/tool-identity/http/tool-identity-routes';
import { getToolIdentityRow } from '../../../src/modules/tool-identity/infrastructure/tool-identity-repository';
import { errorHandler } from '../../../src/plugins/error-handler';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';

/** A real 1×1 PNG — `file-type` reads magic bytes, so the header must be true. */
const PNG_BYTES = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
  ),
  (character) => character.charCodeAt(0)
);

const SECOND_PNG_BYTES = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jAWYAAAAASUVORK5CYII='
  ),
  (character) => character.charCodeAt(0)
);

const SVG_BYTES = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
);

let userSeq = 0;
let testUser: { id: string; name: string; email: string };
let restoreAuth: (() => void) | null = null;

function mountApp() {
  const { app, restore } = createAuthenticatedApiTestApp(
    testUser,
    errorHandler,
    toolIdentityRoutes
  );
  restoreAuth = restore;
  return app;
}

function jsonRequest(path: string, method: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function uploadRequest(subjectKey: string, bytes: Uint8Array, name: string, type: string): Request {
  const form = new FormData();
  form.append('image', new File([bytes], name, { type }));
  return new Request(`http://localhost/tool-identities/${subjectKey}/image`, {
    method: 'POST',
    body: form,
  });
}

/** Files the current user has on disk, so replacement and cleanup are provable. */
function storedFiles(): string[] {
  const dir = join(getConfig().toolImages.dir, testUser.id);
  return existsSync(dir) ? readdirSync(dir) : [];
}

/** A stand-in remote host: one canned response, and a public address for it. */
function remoteHost(response: Response) {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      fetch: ((input: Parameters<typeof fetch>[0]) => {
        // eslint-disable-next-line @typescript-eslint/no-base-to-string -- The existing conversion accepts URL or arbitrary input and preserves its diagnostic representation.
        calls.push(String(input));
        return Promise.resolve(response);
      }) as unknown as typeof fetch,
      resolveHostname: () => Promise.resolve([{ address: '93.184.216.34', family: 4 as const }]),
    },
  };
}

function pngResponse(bytes: Uint8Array = PNG_BYTES): Response {
  return new Response(bytes, { headers: { 'content-type': 'image/png' } });
}

beforeEach(() => {
  userSeq += 1;
  testUser = {
    id: `tool-image-user-${userSeq}`,
    name: 'Tool Image User',
    email: `tool-image-${userSeq}@mangostudio.test`,
  };
});

afterEach(() => {
  restoreAuth?.();
  restoreAuth = null;
  rmSync(join(getConfig().toolImages.dir, testUser.id), { recursive: true, force: true });
});

describe('tool identity image upload', () => {
  it('does not accept response cache metadata as an image write field', async () => {
    const app = mountApp();
    const response = await app.handle(
      jsonRequest('/tool-identities/agent:claude', 'PUT', {
        image: {
          source: 'url',
          url: 'https://cdn.example.test/logo.png',
          cache: false,
          cacheKey: 'forged',
        },
      })
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: 'Invalid request body',
      code: ERROR_CODES.VALIDATION,
    });
    expect(storedFiles()).toEqual([]);
  });

  it('stores an uploaded PNG and reports it as cached on our origin', async () => {
    const app = mountApp();

    const response = await app.handle(
      uploadRequest('agent:claude', PNG_BYTES, 'logo.png', 'image/png')
    );
    expect(response.status).toBe(200);

    const { identity } = (await response.json()) as ToolIdentityUpdateResponse;
    expect(identity?.image).toEqual({
      source: 'upload',
      url: null,
      cached: true,
      cacheKey: expect.any(String),
    });
    expect(storedFiles()).toHaveLength(1);
  });

  it('refuses an SVG by name, since it is the one users will try', async () => {
    const app = mountApp();

    const response = await app.handle(
      uploadRequest('agent:claude', SVG_BYTES, 'logo.svg', 'image/svg+xml')
    );

    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: string }).error).toContain('SVG');
    expect(storedFiles()).toEqual([]);
  });

  it('refuses a file whose bytes are not the image it claims to be', async () => {
    const app = mountApp();

    const response = await app.handle(
      uploadRequest(
        'agent:claude',
        new TextEncoder().encode('not an image'),
        'logo.png',
        'image/png'
      )
    );

    expect(response.status).toBe(422);
    expect(storedFiles()).toEqual([]);
  });

  it('refuses a file past the size cap', async () => {
    const app = mountApp();
    // A genuine PNG header followed by padding: the type is fine, the size is not.
    const oversize = new Uint8Array(600 * 1024);
    oversize.set(PNG_BYTES, 0);

    const response = await app.handle(
      uploadRequest('agent:claude', oversize, 'logo.png', 'image/png')
    );

    expect(response.status).toBe(422);
    expect(storedFiles()).toEqual([]);
  });

  it('replaces the previous file instead of accumulating them', async () => {
    const app = mountApp();

    await app.handle(uploadRequest('agent:claude', PNG_BYTES, 'first.png', 'image/png'));
    const first = storedFiles();
    await app.handle(uploadRequest('agent:claude', PNG_BYTES, 'second.png', 'image/png'));

    expect(storedFiles()).toHaveLength(1);
    expect(storedFiles()).not.toEqual(first);
  });

  it('keeps a name and monogram that were set before the image', async () => {
    const app = mountApp();

    await app.handle(
      jsonRequest('/tool-identities/agent:claude', 'PUT', { displayName: 'CC', monogram: 'cc' })
    );
    const uploaded = await app.handle(
      uploadRequest('agent:claude', PNG_BYTES, 'logo.png', 'image/png')
    );

    const { identity } = (await uploaded.json()) as ToolIdentityUpdateResponse;
    expect(identity?.displayName).toBe('CC');
    expect(identity?.monogram).toBe('CC');
    expect(identity?.image?.source).toBe('upload');
  });

  it('keeps the image when a later update only renames the tool', async () => {
    const app = mountApp();

    await app.handle(uploadRequest('agent:claude', PNG_BYTES, 'logo.png', 'image/png'));
    const renamed = await app.handle(
      jsonRequest('/tool-identities/agent:claude', 'PUT', { displayName: 'Claude' })
    );

    const { identity } = (await renamed.json()) as ToolIdentityUpdateResponse;
    expect(identity?.image?.source).toBe('upload');
    expect(storedFiles()).toHaveLength(1);
  });
});

describe('tool identity image serving', () => {
  for (const reset of [false, true]) {
    it(`retires cached bytes changed in the same clock tick, reset=${reset}`, async () => {
      const clock = spyOn(Date, 'now').mockReturnValue(1000);
      try {
        const app = mountApp();
        const firstUpload = await app.handle(
          uploadRequest('agent:claude', PNG_BYTES, 'first.png', 'image/png')
        );
        expect(firstUpload.status).toBe(200);
        const firstPayload = (await firstUpload.json()) as ToolIdentityUpdateResponse;
        expect(Value.Check(ToolIdentityUpdateResponseSchema, firstPayload)).toBe(true);
        const firstIdentity = firstPayload.identity;
        const [firstFile] = storedFiles();
        const first = await app.handle(
          new Request('http://localhost/tool-identities/agent:claude/image')
        );
        const firstTag = first.headers.get('etag') ?? '';
        expect(new Uint8Array(await first.arrayBuffer())).toEqual(PNG_BYTES);
        if (reset)
          expect(
            (await app.handle(jsonRequest('/tool-identities/agent:claude', 'DELETE'))).status
          ).toBe(204);
        const nextUpload = await app.handle(
          uploadRequest('agent:claude', SECOND_PNG_BYTES, 'next.png', 'image/png')
        );
        expect(nextUpload.status).toBe(200);
        const nextPayload = (await nextUpload.json()) as ToolIdentityUpdateResponse;
        expect(Value.Check(ToolIdentityUpdateResponseSchema, nextPayload)).toBe(true);
        const nextIdentity = nextPayload.identity;
        expect(firstIdentity?.updatedAt).toBe(1000);
        expect(nextIdentity?.updatedAt).toBe(1000);
        const next = await app.handle(
          new Request('http://localhost/tool-identities/agent:claude/image', {
            headers: { 'If-None-Match': firstTag },
          })
        );
        expect(next.status).toBe(200);
        expect(new Uint8Array(await next.arrayBuffer())).toEqual(SECOND_PNG_BYTES);
        expect(firstIdentity?.image?.cacheKey).toEqual(expect.any(String));
        expect(firstIdentity?.image?.cacheKey).not.toContain(firstFile);
        expect(nextIdentity?.image?.cacheKey).not.toBe(firstIdentity?.image?.cacheKey);
        expect(next.headers.get('etag')).toBe(`"${nextIdentity?.image?.cacheKey}"`);
        const listed = await app.handle(new Request('http://localhost/tool-identities'));
        const list = (await listed.json()) as ToolIdentityListResponse;
        expect(Value.Check(ToolIdentityListResponseSchema, list)).toBe(true);
        expect(list.identities['agent:claude']?.image?.cacheKey).toBe(
          nextIdentity?.image?.cacheKey
        );
        clock.mockReturnValue(1001);
        const rename = await app.handle(
          jsonRequest('/tool-identities/agent:claude', 'PUT', { displayName: 'Renamed' })
        );
        const renamed = ((await rename.json()) as ToolIdentityUpdateResponse).identity;
        expect(renamed?.updatedAt).toBe(1001);
        expect(renamed?.image?.cacheKey).toBe(nextIdentity?.image?.cacheKey);
        const unchanged = await app.handle(
          new Request('http://localhost/tool-identities/agent:claude/image', {
            headers: { 'If-None-Match': next.headers.get('etag') ?? '' },
          })
        );
        expect(unchanged.status).toBe(304);
      } finally {
        clock.mockRestore();
      }
    });
  }

  it('serves the stored bytes with the type recorded at upload time', async () => {
    const app = mountApp();
    await app.handle(uploadRequest('agent:claude', PNG_BYTES, 'logo.png', 'image/png'));

    const response = await app.handle(
      new Request('http://localhost/tool-identities/agent:claude/image')
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    // Pinning the type only means something if the browser is told not to
    // second-guess it.
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG_BYTES);
  });

  it('lets the browser keep the bytes, since the address carries the version', async () => {
    const app = mountApp();
    await app.handle(uploadRequest('agent:claude', PNG_BYTES, 'logo.png', 'image/png'));

    const response = await app.handle(
      new Request('http://localhost/tool-identities/agent:claude/image?v=1')
    );

    // The client asks for `?v=<cacheKey>` and changes the URL for new images.
    // Revalidating on every page that draws the tool would re-transfer up to
    // 512 KiB to be told nothing changed.
    const cacheControl = response.headers.get('cache-control');
    expect(cacheControl).toContain('private');
    expect(cacheControl).toContain('immutable');
    expect(cacheControl).not.toContain('max-age=0');
    expect(response.headers.get('etag')).toBeTruthy();
  });

  it('answers a matching If-None-Match with 304 and no body', async () => {
    const app = mountApp();
    await app.handle(uploadRequest('agent:claude', PNG_BYTES, 'logo.png', 'image/png'));

    const first = await app.handle(
      new Request('http://localhost/tool-identities/agent:claude/image')
    );
    const etag = first.headers.get('etag') ?? '';

    const revalidated = await app.handle(
      new Request('http://localhost/tool-identities/agent:claude/image', {
        headers: { 'If-None-Match': etag },
      })
    );

    expect(revalidated.status).toBe(304);
    expect(await revalidated.arrayBuffer()).toHaveLength(0);
  });

  it('serves the image again when the tag a client holds is stale', async () => {
    const app = mountApp();
    await app.handle(uploadRequest('agent:claude', PNG_BYTES, 'logo.png', 'image/png'));

    const response = await app.handle(
      new Request('http://localhost/tool-identities/agent:claude/image', {
        headers: { 'If-None-Match': '"0"' },
      })
    );

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG_BYTES);
  });

  it('answers 404 for a tool with no stored bytes', async () => {
    const app = mountApp();

    const response = await app.handle(
      new Request('http://localhost/tool-identities/agent:claude/image')
    );

    expect(response.status).toBe(404);
  });

  it('does not serve another user their neighbour’s image', async () => {
    const app = mountApp();
    await app.handle(uploadRequest('agent:claude', PNG_BYTES, 'logo.png', 'image/png'));
    restoreAuth?.();

    const { app: otherApp, restore } = createAuthenticatedApiTestApp(
      { id: `${testUser.id}-other`, name: 'Other', email: `other-${userSeq}@mangostudio.test` },
      errorHandler,
      toolIdentityRoutes
    );
    restoreAuth = restore;

    const response = await otherApp.handle(
      new Request('http://localhost/tool-identities/agent:claude/image')
    );
    expect(response.status).toBe(404);
  });
});

describe('tool identity image reset', () => {
  it('deletes the stored file along with the row', async () => {
    const app = mountApp();
    await app.handle(uploadRequest('agent:claude', PNG_BYTES, 'logo.png', 'image/png'));
    expect(storedFiles()).toHaveLength(1);

    const reset = await app.handle(jsonRequest('/tool-identities/agent:claude', 'DELETE'));

    expect(reset.status).toBe(204);
    expect(storedFiles()).toEqual([]);
  });

  it('drops the file when an update clears every field', async () => {
    const app = mountApp();
    await app.handle(uploadRequest('agent:claude', PNG_BYTES, 'logo.png', 'image/png'));

    const cleared = await app.handle(
      jsonRequest('/tool-identities/agent:claude', 'PUT', {
        displayName: null,
        monogram: null,
        image: null,
      })
    );

    expect(((await cleared.json()) as ToolIdentityUpdateResponse).identity).toBeNull();
    expect(storedFiles()).toEqual([]);
  });
});

describe('tool identity image cleanup ordering', () => {
  /** The row as the service would read it before resolving an image change. */
  function storedRow() {
    return getToolIdentityRow(getDb(), testUser.id, DEFAULT_PROFILE_ID, 'agent:claude');
  }

  it('keeps the file an update replaces until the row write has succeeded', async () => {
    const app = mountApp();
    await app.handle(uploadRequest('agent:claude', PNG_BYTES, 'logo.png', 'image/png'));
    const [original] = storedFiles();

    const resolved = await storeUploadedToolImage(
      new File([PNG_BYTES], 'next.png', { type: 'image/png' }),
      testUser.id
    );

    // The replacement is on disk, but the row still names the original — so
    // until that row is rewritten, the original is still the identity's image.
    expect(storedFiles()).toHaveLength(2);
    expect(storedFiles()).toContain(original);

    // A busy database is enough to lose the write. When that happens the
    // identity has to be exactly what it was, not pointing at a deleted file.
    await resolved.rollback();
    expect(storedFiles()).toEqual([original]);
  });

  it('drops the replaced file once the row has stopped naming it', async () => {
    const app = mountApp();
    await app.handle(uploadRequest('agent:claude', PNG_BYTES, 'logo.png', 'image/png'));
    const [original] = storedFiles();

    await uploadToolIdentityImage(
      getDb(),
      testUser.id,
      'agent:claude',
      new File([PNG_BYTES], 'next.png', { type: 'image/png' })
    );
    const stored = await storedRow();
    expect(storedFiles()).toEqual([basename(stored?.imagePath ?? '')]);

    expect(storedFiles()).toHaveLength(1);
    expect(storedFiles()).not.toContain(original);
  });
});

describe('tool identity image from a URL', () => {
  it('stores only the address when the image is not cached', async () => {
    const remote = remoteHost(pngResponse());

    const identity = await updateToolIdentity(
      getDb(),
      testUser.id,
      'agent:claude',
      { image: { source: 'url', url: 'https://cdn.example.test/logo.png', cache: false } },
      remote.deps
    );

    expect(identity?.image).toEqual({
      source: 'url',
      url: 'https://cdn.example.test/logo.png',
      cached: false,
    });
    // Nothing is fetched: the browser is the one that will load it.
    expect(remote.calls).toEqual([]);
    expect(storedFiles()).toEqual([]);
  });

  it('fetches once and serves it from our origin when caching is asked for', async () => {
    const remote = remoteHost(pngResponse());

    const identity = await updateToolIdentity(
      getDb(),
      testUser.id,
      'agent:claude',
      { image: { source: 'url', url: 'https://cdn.example.test/logo.png', cache: true } },
      remote.deps
    );

    expect(identity?.image?.cached).toBe(true);
    // The address is kept so the user can still see where the image came from.
    expect(identity?.image?.url).toBe('https://cdn.example.test/logo.png');
    expect(remote.calls).toEqual(['https://cdn.example.test/logo.png']);
    expect(storedFiles()).toHaveLength(1);
  });

  it('does not re-download a cached image when an unrelated field changes', async () => {
    const first = remoteHost(pngResponse());
    const image = { source: 'url', url: 'https://cdn.example.test/logo.png', cache: true } as const;
    await updateToolIdentity(getDb(), testUser.id, 'agent:claude', { image }, first.deps);

    const second = remoteHost(pngResponse());
    await updateToolIdentity(
      getDb(),
      testUser.id,
      'agent:claude',
      { displayName: 'Claude', image },
      second.deps
    );

    // A rename re-sends the image the dialog is showing; charging the remote
    // host for it would make every keystroke somebody else's traffic.
    expect(second.calls).toEqual([]);
    expect(storedFiles()).toHaveLength(1);
  });

  it('re-downloads when the address changes and drops the old file', async () => {
    const first = remoteHost(pngResponse());
    await updateToolIdentity(
      getDb(),
      testUser.id,
      'agent:claude',
      { image: { source: 'url', url: 'https://cdn.example.test/one.png', cache: true } },
      first.deps
    );
    const firstFiles = storedFiles();

    const second = remoteHost(pngResponse());
    await updateToolIdentity(
      getDb(),
      testUser.id,
      'agent:claude',
      { image: { source: 'url', url: 'https://cdn.example.test/two.png', cache: true } },
      second.deps
    );

    expect(second.calls).toEqual(['https://cdn.example.test/two.png']);
    expect(storedFiles()).toHaveLength(1);
    expect(storedFiles()).not.toEqual(firstFiles);
  });

  it('refuses a host that resolves inside the network the server sits in', async () => {
    const remote = remoteHost(pngResponse());
    remote.deps.resolveHostname = () =>
      Promise.resolve([{ address: '169.254.169.254', family: 4 as const }]);

    await expect(
      updateToolIdentity(
        getDb(),
        testUser.id,
        'agent:claude',
        { image: { source: 'url', url: 'https://metadata.example.test/logo.png', cache: true } },
        remote.deps
      )
    ).rejects.toThrow('could not be fetched');
    expect(remote.calls).toEqual([]);
    expect(storedFiles()).toEqual([]);
  });

  it('refuses a remote response that is not one of the allowed image types', async () => {
    const remote = remoteHost(
      new Response('<html>login page</html>', { headers: { 'content-type': 'image/png' } })
    );

    await expect(
      updateToolIdentity(
        getDb(),
        testUser.id,
        'agent:claude',
        { image: { source: 'url', url: 'https://cdn.example.test/logo.png', cache: true } },
        remote.deps
      )
    ).rejects.toThrow('PNG, JPEG, or WebP');
    // The advertised content-type said PNG. The bytes decide.
    expect(storedFiles()).toEqual([]);
  });

  it('refuses a remote image past the size cap', async () => {
    const oversize = new Uint8Array(600 * 1024);
    oversize.set(PNG_BYTES, 0);
    const remote = remoteHost(pngResponse(oversize));

    await expect(
      updateToolIdentity(
        getDb(),
        testUser.id,
        'agent:claude',
        { image: { source: 'url', url: 'https://cdn.example.test/huge.png', cache: true } },
        remote.deps
      )
    ).rejects.toThrow('KiB limit');
    expect(storedFiles()).toEqual([]);
  });
});
