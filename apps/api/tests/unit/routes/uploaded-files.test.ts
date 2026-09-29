import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  createUploadedFileRoutes,
  resolveUploadedFile,
  UPLOADED_FILE_CACHE_CONTROL,
} from '../../../src/routes/uploaded-files';

const temporaryDirs: string[] = [];

afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fresh directory under the OS temp root, removed after the test. */
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirs.push(dir);
  return dir;
}

/**
 * Routes over a fresh uploads directory (plus a sibling directory outside it
 * for escape attempts), and a `get` that drives them in process.
 */
async function buildUploads() {
  const uploadsDir = tempDir('uploads-');
  const outsideDir = tempDir('outside-');
  writeFileSync(join(outsideDir, 'secret.txt'), 'SECRET');
  writeFileSync(join(uploadsDir, 'photo.png'), 'png-bytes');

  const app = createUploadedFileRoutes(uploadsDir);
  await app.modules;
  const get = (path: string, headers?: Record<string, string>) =>
    app.handle(new Request(`http://localhost${path}`, { headers }));
  return { uploadsDir, outsideDir, get };
}

/** `status body` in one string, so a failure shows both sides of the outcome. */
async function outcome(response: Response): Promise<string> {
  return `${response.status} ${await response.text()}`;
}

describe('GET /uploads/*', () => {
  test('serves an upload with validators and a non-immutable cache directive', async () => {
    const { get } = await buildUploads();
    const response = await get('/uploads/photo.png');

    expect(await outcome(response)).toBe('200 png-bytes');
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('cache-control')).toBe(UPLOADED_FILE_CACHE_CONTROL);
    expect(response.headers.get('cache-control')).not.toContain('immutable');
    expect(response.headers.get('etag')).toMatch(/^"[0-9a-f]+-[0-9a-f]+"$/);
    expect(response.headers.get('last-modified')).not.toBeNull();
  });

  test('serves a file uploaded after the routes were built', async () => {
    const { uploadsDir, get } = await buildUploads();

    // The attachment layout: a chat directory and a timestamp directory that
    // did not exist when the server started.
    mkdirSync(join(uploadsDir, 'Chat_abc', '1710000000000'), { recursive: true });
    writeFileSync(join(uploadsDir, 'Chat_abc', '1710000000000', 'later.pdf'), 'pdf-bytes');
    writeFileSync(join(uploadsDir, 'later.png'), 'later-bytes');

    expect(await outcome(await get('/uploads/later.png'))).toBe('200 later-bytes');
    const attachment = await get('/uploads/Chat_abc/1710000000000/later.pdf');
    expect(await outcome(attachment)).toBe('200 pdf-bytes');
    expect(attachment.headers.get('content-type')).toBe('application/pdf');
  });

  test('builds over a missing uploads directory and serves it once it exists', async () => {
    const uploadsDir = join(tempDir('uploads-root-'), 'not-yet');

    // A directory walk at registration throws ENOENT here; request-time
    // resolution has nothing to read until a request arrives.
    const app = createUploadedFileRoutes(uploadsDir);
    const registration = await Promise.resolve(app.modules).then(
      () => 'registered',
      (error: unknown) => `registration read the directory: ${String(error)}`
    );
    expect(registration).toBe('registered');
    const get = (path: string) => app.handle(new Request(`http://localhost${path}`));

    expect((await get('/uploads/photo.png')).status).toBe(404);
    mkdirSync(uploadsDir);
    writeFileSync(join(uploadsDir, 'photo.png'), 'png-bytes');
    expect(await outcome(await get('/uploads/photo.png'))).toBe('200 png-bytes');
  });

  test('answers 304 to a matching If-None-Match, with the validators', async () => {
    const { get } = await buildUploads();
    const etag = (await get('/uploads/photo.png')).headers.get('etag') ?? '';

    for (const ifNoneMatch of [etag, `W/${etag}`, `"other", ${etag}`]) {
      const response = await get('/uploads/photo.png', { 'if-none-match': ifNoneMatch });
      expect(await outcome(response)).toBe('304 ');
      expect(response.headers.get('etag')).toBe(etag);
      expect(response.headers.get('cache-control')).toBe(UPLOADED_FILE_CACHE_CONTROL);
    }
  });

  test('answers 304 to If-Modified-Since at or after the file mtime', async () => {
    const { get } = await buildUploads();
    const lastModified = (await get('/uploads/photo.png')).headers.get('last-modified') ?? '';

    const echoed = await get('/uploads/photo.png', { 'if-modified-since': lastModified });
    expect(await outcome(echoed)).toBe('304 ');

    const stale = await get('/uploads/photo.png', {
      'if-modified-since': new Date(0).toUTCString(),
    });
    expect(await outcome(stale)).toBe('200 png-bytes');
  });

  test('ignores If-Modified-Since when If-None-Match does not match', async () => {
    const { get } = await buildUploads();
    const lastModified = (await get('/uploads/photo.png')).headers.get('last-modified') ?? '';

    const response = await get('/uploads/photo.png', {
      'if-none-match': '"stale"',
      'if-modified-since': lastModified,
    });
    expect(await outcome(response)).toBe('200 png-bytes');
  });

  test('revalidates to the new bytes when an upload is replaced on disk', async () => {
    const { uploadsDir, get } = await buildUploads();
    const etag = (await get('/uploads/photo.png')).headers.get('etag') ?? '';

    writeFileSync(join(uploadsDir, 'photo.png'), 'replaced-bytes');
    utimesSync(join(uploadsDir, 'photo.png'), new Date(), new Date(Date.now() + 5_000));

    const response = await get('/uploads/photo.png', { 'if-none-match': etag });
    expect(await outcome(response)).toBe('200 replaced-bytes');
  });

  test('404s a missing file, a directory and the bare prefix', async () => {
    const { uploadsDir, get } = await buildUploads();
    mkdirSync(join(uploadsDir, 'Chat_abc'));

    for (const path of ['/uploads/missing.png', '/uploads/Chat_abc', '/uploads/', '/uploads']) {
      expect(`${path} -> ${(await get(path)).status}`).toBe(`${path} -> 404`);
    }
  });

  test('rejects an encoded traversal out of the uploads directory', async () => {
    const { outsideDir, get } = await buildUploads();
    const path = `/uploads/..%2f${basename(outsideDir)}%2fsecret.txt`;

    const response = await get(path);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('SECRET');
  });

  test('rejects a symlinked file that resolves outside the uploads directory', async () => {
    const { uploadsDir, outsideDir, get } = await buildUploads();
    symlinkSync(join(outsideDir, 'secret.txt'), join(uploadsDir, 'escape.txt'));

    const response = await get('/uploads/escape.txt');
    expect(await outcome(response)).not.toContain('SECRET');
    expect(response.status).toBe(404);
  });

  test('rejects a file under a symlinked directory that resolves outside', async () => {
    const { uploadsDir, outsideDir, get } = await buildUploads();
    symlinkSync(outsideDir, join(uploadsDir, 'escape-dir'), 'dir');

    const response = await get('/uploads/escape-dir/secret.txt');
    expect(await outcome(response)).not.toContain('SECRET');
    expect(response.status).toBe(404);
  });

  test('serves a symlink that stays inside the uploads directory', async () => {
    const { uploadsDir, get } = await buildUploads();
    symlinkSync(join(uploadsDir, 'photo.png'), join(uploadsDir, 'alias.png'));

    expect(await outcome(await get('/uploads/alias.png'))).toBe('200 png-bytes');
  });

  test('does not serve dotfiles', async () => {
    const { uploadsDir, get } = await buildUploads();
    writeFileSync(join(uploadsDir, '.env'), 'TOKEN=1');
    mkdirSync(join(uploadsDir, '.git'));
    writeFileSync(join(uploadsDir, '.git', 'config'), 'git-config');

    for (const path of ['/uploads/.env', '/uploads/.git/config']) {
      expect(`${path} -> ${(await get(path)).status}`).toBe(`${path} -> 404`);
    }
  });
});

describe('resolveUploadedFile', () => {
  test('resolves a contained regular file to its real path', async () => {
    const uploadsDir = tempDir('uploads-');
    writeFileSync(join(uploadsDir, 'photo.png'), 'png-bytes');

    const file = await resolveUploadedFile(uploadsDir, 'photo.png');
    expect(file?.stats.size).toBe('png-bytes'.length);
    expect(file?.filePath.endsWith(`${basename(uploadsDir)}/photo.png`)).toBe(true);
  });

  test('refuses segments no upload writer produces', async () => {
    const uploadsDir = tempDir('uploads-');
    writeFileSync(join(uploadsDir, 'photo.png'), 'png-bytes');

    for (const requested of ['', 'a//photo.png', 'photo.png\0.txt', 'a\\photo.png', '../x']) {
      expect(
        `${JSON.stringify(requested)} -> ${await resolveUploadedFile(uploadsDir, requested)}`
      ).toBe(`${JSON.stringify(requested)} -> null`);
    }
  });
});
