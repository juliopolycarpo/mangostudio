/**
 * Tool avatar images: what may be stored, and how it comes back out.
 *
 * The upload and serve halves are exercised through the routes, because the
 * headers are half the security story. The remote-URL half is exercised through
 * the service, which is where the fetch seam is injected — no test here opens a
 * socket or resolves a name.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_PROFILE_ID } from '@mangostudio/shared/profiles';
import type { ToolIdentityUpdateResponse } from '@mangostudio/shared/tool-identity';
import { getDb } from '../../../src/db/database';
import { getConfig } from '../../../src/lib/config';
import { updateToolIdentity } from '../../../src/modules/tool-identity/application/tool-identity-service';
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
  it('stores an uploaded PNG and reports it as cached on our origin', async () => {
    const app = mountApp();

    const response = await app.handle(
      uploadRequest('agent:claude', PNG_BYTES, 'logo.png', 'image/png')
    );
    expect(response.status).toBe(200);

    const { identity } = (await response.json()) as ToolIdentityUpdateResponse;
    expect(identity?.image).toEqual({ source: 'upload', url: null, cached: true });
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
      await storedRow(),
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

    const resolved = await storeUploadedToolImage(
      new File([PNG_BYTES], 'next.png', { type: 'image/png' }),
      await storedRow(),
      testUser.id
    );
    await resolved.commit();

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
