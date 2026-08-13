import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { UploadChatAttachmentResponseSchema } from '@mangostudio/shared/chat';
import { ApiErrorResponseSchema, ERROR_CODES } from '@mangostudio/shared/errors';
import { Value } from '@sinclair/typebox/value';
import { getDb } from '../../../src/db/database';
import { getConfig } from '../../../src/lib/config';
import { errorHandler } from '../../../src/plugins/error-handler';
import { uploadRoutes } from '../../../src/routes/upload';
import {
  createApiTestApp,
  createAuthenticatedApiTestApp,
} from '../../support/harness/create-api-test-app';

// Minimal 1×1 PNG file (valid magic bytes: 89 50 4E 47)
const TINY_PNG = new Uint8Array([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a, // PNG signature
  0x00,
  0x00,
  0x00,
  0x0d,
  0x49,
  0x48,
  0x44,
  0x52, // IHDR chunk length + type
  0x00,
  0x00,
  0x00,
  0x01,
  0x00,
  0x00,
  0x00,
  0x01, // width=1, height=1
  0x08,
  0x02,
  0x00,
  0x00,
  0x00,
  0x90,
  0x77,
  0x53,
  0xde, // bit depth, color type, etc.
  0x00,
  0x00,
  0x00,
  0x0c,
  0x49,
  0x44,
  0x41,
  0x54, // IDAT chunk
  0x08,
  0xd7,
  0x63,
  0xf8,
  0xcf,
  0xc0,
  0x00,
  0x00,
  0x00,
  0x02,
  0x00,
  0x01,
  0xe2,
  0x21,
  0xbc,
  0x33,
  0x00,
  0x00,
  0x00,
  0x00,
  0x49,
  0x45,
  0x4e,
  0x44,
  0xae,
  0x42,
  0x60,
  0x82, // IEND chunk
]);

const TEST_USER = {
  id: 'test-user-upload',
  name: 'Upload User',
  email: 'upload@mangostudio.test',
};

const OTHER_USER = {
  id: 'other-user-upload',
  name: 'Other Upload User',
  email: 'other-upload@mangostudio.test',
};

const OWNED_CHAT_ID = 'upload-owned-chat';
const OTHER_CHAT_ID = 'upload-other-chat';

let restoreAuth: (() => void) | null = null;

beforeAll(async () => {
  const now = Date.now();
  const db = getDb();

  await db
    .insertInto('user')
    .values([
      {
        id: TEST_USER.id,
        name: TEST_USER.name,
        email: TEST_USER.email,
        emailVerified: 0,
        image: null,
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
      },
      {
        id: OTHER_USER.id,
        name: OTHER_USER.name,
        email: OTHER_USER.email,
        emailVerified: 0,
        image: null,
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
      },
    ])
    .execute();

  await db
    .insertInto('chats')
    .values([
      {
        id: OWNED_CHAT_ID,
        title: 'Upload Owned Chat',
        createdAt: now,
        updatedAt: now,
        model: null,
        userId: TEST_USER.id,
      },
      {
        id: OTHER_CHAT_ID,
        title: 'Upload Other Chat',
        createdAt: now,
        updatedAt: now,
        model: null,
        userId: OTHER_USER.id,
      },
    ])
    .execute();
});

afterEach(() => {
  restoreAuth?.();
  restoreAuth = null;
});

describe('POST /upload', () => {
  it('rejects an unauthenticated request carrying a valid file with 401', async () => {
    // `errorHandler` is mounted the way `app.ts` mounts it, so these assertions
    // are against the response a client actually receives. Without it the route
    // answers with the framework's own validation object, which is not a shape
    // this API ever emits.
    const app = createApiTestApp(errorHandler, uploadRoutes);

    const formData = new FormData();
    formData.append('image', new File([TINY_PNG], 'tiny.png', { type: 'image/png' }));

    const response = await app.handle(
      new Request('http://localhost/upload', { method: 'POST', body: formData })
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: 'Unauthorized',
      code: ERROR_CODES.UNAUTHORIZED,
    });
  });

  it('rejects an unusable file before the auth guard runs', async () => {
    // File-type validation is part of the route schema, so it fires ahead of
    // the auth `onBeforeHandle` and an anonymous caller sending junk gets 422
    // rather than 401. Pinned rather than accepted as "either is fine": the
    // ordering is what decides whether an unauthenticated caller can probe
    // which files this endpoint accepts, and a change to it should be a
    // deliberate one.
    const app = createApiTestApp(errorHandler, uploadRoutes);

    const formData = new FormData();
    formData.append('image', new Blob(['fake-content'], { type: 'image/png' }), 'test.png');

    const response = await app.handle(
      new Request('http://localhost/upload', { method: 'POST', body: formData })
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: 'Unsupported file type',
      code: ERROR_CODES.VALIDATION,
    });
  });

  it('accepts a valid PNG upload and returns imageUrl', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, uploadRoutes);
    restoreAuth = restore;

    const formData = new FormData();
    formData.append('image', new File([TINY_PNG], 'tiny.png', { type: 'image/png' }));

    const response = await app.handle(
      new Request('http://localhost/upload', {
        method: 'POST',
        body: formData,
      })
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toHaveProperty('imageUrl');
    expect(typeof body.imageUrl).toBe('string');
    expect((body.imageUrl as string).startsWith('/uploads/')).toBe(true);
  });

  it('rejects uploads whose bytes are not the declared image type', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, errorHandler, uploadRoutes);
    restoreAuth = restore;

    const formData = new FormData();
    formData.append(
      'image',
      new File([new TextEncoder().encode('this is plain text')], 'fake.png', {
        type: 'image/png',
      })
    );

    const response = await app.handle(
      new Request('http://localhost/upload', {
        method: 'POST',
        body: formData,
      })
    );

    // The declared MIME type says PNG and the bytes do not. Elysia raises this
    // outside its `VALIDATION` code, and `errorHandler` maps it to 422 with the
    // shared error shape — 400 would mean our own magic-byte check caught it
    // instead, which is a different code path with a different message.
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: 'Unsupported file type',
      code: ERROR_CODES.VALIDATION,
    });
  });
});

describe('POST /upload/chat', () => {
  it('rejects unauthenticated requests', async () => {
    const app = createApiTestApp(uploadRoutes);
    const formData = new FormData();
    formData.append('chatId', OWNED_CHAT_ID);
    formData.append('file', new File([TINY_PNG], 'tiny.png', { type: 'image/png' }));

    const response = await app.handle(
      new Request('http://localhost/upload/chat', {
        method: 'POST',
        body: formData,
      })
    );

    expect(response.status).toBe(401);
  });

  it('returns 404 when the chat belongs to another user', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, uploadRoutes);
    restoreAuth = restore;

    const formData = new FormData();
    formData.append('chatId', OTHER_CHAT_ID);
    formData.append('file', new File([TINY_PNG], 'tiny.png', { type: 'image/png' }));

    const response = await app.handle(
      new Request('http://localhost/upload/chat', {
        method: 'POST',
        body: formData,
      })
    );

    expect(response.status).toBe(404);
  });

  it('stores valid PNG attachments with chat-scoped metadata', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, uploadRoutes);
    restoreAuth = restore;

    const formData = new FormData();
    formData.append('chatId', OWNED_CHAT_ID);
    formData.append('file', new File([TINY_PNG], 'reference.png', { type: 'image/png' }));

    const response = await app.handle(
      new Request('http://localhost/upload/chat', {
        method: 'POST',
        body: formData,
      })
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { attachment: Record<string, unknown> };
    expect(Value.Check(UploadChatAttachmentResponseSchema, body)).toBe(true);

    const attachment = body.attachment as {
      id: string;
      chatId: string;
      messageId: string | null;
      originalName: string;
      mimeType: string;
      kind: string;
      url: string;
    };
    expect(attachment.chatId).toBe(OWNED_CHAT_ID);
    expect(attachment.messageId).toBeNull();
    expect(attachment.originalName).toBe('reference.png');
    expect(attachment.mimeType).toBe('image/png');
    expect(attachment.kind).toBe('image');
    expect(attachment.url).toContain('/uploads/Upload-Owned-Chat_upload-owned-chat/');

    const persisted = await getDb()
      .selectFrom('chat_attachments')
      .select(['relativePath', 'storedName', 'userId'])
      .where('id', '=', attachment.id)
      .executeTakeFirstOrThrow();
    expect(persisted.userId).toBe(TEST_USER.id);
    expect(persisted.storedName).toContain('reference.png');
    expect(existsSync(join(getConfig().uploads.dir, persisted.relativePath))).toBe(true);
  });

  it('stores valid text attachments', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, uploadRoutes);
    restoreAuth = restore;

    const formData = new FormData();
    formData.append('chatId', OWNED_CHAT_ID);
    formData.append('file', new File(['Use this brief.'], 'brief.txt', { type: 'text/plain' }));

    const response = await app.handle(
      new Request('http://localhost/upload/chat', {
        method: 'POST',
        body: formData,
      })
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { attachment: { kind: string; mimeType: string } };
    expect(body.attachment.kind).toBe('text');
    expect(body.attachment.mimeType).toBe('text/plain');
  });

  it('rejects files whose extension does not match detected content', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, errorHandler, uploadRoutes);
    restoreAuth = restore;

    const formData = new FormData();
    formData.append('chatId', OWNED_CHAT_ID);
    formData.append('file', new File([TINY_PNG], 'reference.txt', { type: 'text/plain' }));

    const response = await app.handle(
      new Request('http://localhost/upload/chat', {
        method: 'POST',
        body: formData,
      })
    );

    // A domain check inside the handler, not a schema rejection: 400 with an
    // `ApiErrorResponse` the user can act on. Distinct from the 422 above,
    // which never reaches the handler at all.
    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toContain('application/json');
    const payload = (await response.json()) as { error: string; code?: string };
    expect(Value.Check(ApiErrorResponseSchema, payload)).toBe(true);
    expect(payload.code).toBe(ERROR_CODES.VALIDATION);
    expect(payload.error).toContain('extension does not match');
  });

  it('rejects unsupported binary attachments', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, errorHandler, uploadRoutes);
    restoreAuth = restore;

    const formData = new FormData();
    formData.append('chatId', OWNED_CHAT_ID);
    formData.append(
      'file',
      new File([new Uint8Array([0x00, 0x01, 0x02, 0x03])], 'archive.bin', {
        type: 'application/octet-stream',
      })
    );

    const response = await app.handle(
      new Request('http://localhost/upload/chat', {
        method: 'POST',
        body: formData,
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Unsupported attachment file type.',
      code: ERROR_CODES.VALIDATION,
    });
  });
});
