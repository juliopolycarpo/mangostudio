/**
 * Route-level contract for checkpoint revert. The replay mechanics live in
 * `modules/file-checkpoints/revert-file-checkpoints.integration.test.ts`; this
 * file pins the status codes the response schema advertises.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { faker } from '@faker-js/faker';
import { ApiErrorResponseSchema, ERROR_CODES } from '@mangostudio/shared/errors';
import { Value } from '@sinclair/typebox/value';
import { getDb } from '../../../src/db/database';
import { fileCheckpointRoutes } from '../../../src/modules/file-checkpoints/http/file-checkpoint-routes';
import { executeCreateFile } from '../../../src/services/tools/builtin/create-file';
import { clearFileFreshness } from '../../../src/services/tools/file-freshness';
import type { ToolContext } from '../../../src/services/tools/types';
import {
  type ChatFixture,
  insertTestChat,
  insertTestUser,
  type UserFixture,
} from '../../support/factories';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';

let user: UserFixture;
let chat: ChatFixture;
let messageId: string;
let workdir: string;
let outsideDir: string;
let restoreAuth: (() => void) | null = null;

beforeEach(async () => {
  clearFileFreshness();
  workdir = mkdtempSync(join(tmpdir(), 'checkpoint-routes-'));
  outsideDir = mkdtempSync(join(tmpdir(), 'checkpoint-routes-outside-'));
  user = await insertTestUser();
  chat = await insertTestChat(user.id);
  messageId = faker.string.uuid();

  await getDb()
    .insertInto('messages')
    .values({
      id: messageId,
      chatId: chat.id,
      role: 'ai',
      text: '',
      imageUrl: null,
      referenceImage: null,
      timestamp: Date.now(),
      isGenerating: 0,
      generationTime: null,
      modelName: null,
      styleParams: null,
      interactionMode: 'chat',
      parts: null,
      providerState: null,
    })
    .execute();
});

afterEach(() => {
  clearFileFreshness();
  restoreAuth?.();
  restoreAuth = null;
  rmSync(workdir, { recursive: true, force: true });
  rmSync(outsideDir, { recursive: true, force: true });
});

function turnContext(): ToolContext {
  return {
    userId: chat.userId,
    chatId: chat.id,
    assistantMessageId: messageId,
    db: getDb(),
    workdir,
    parameters: {},
  };
}

function revert() {
  const { app, restore } = createAuthenticatedApiTestApp(user, fileCheckpointRoutes);
  restoreAuth = restore;
  return app.handle(
    new Request(`http://localhost/chats/${chat.id}/checkpoints/${messageId}/revert`, {
      method: 'POST',
    })
  );
}

describe('POST /chats/:id/checkpoints/:messageId/revert', () => {
  it('returns 403 when a checkpoint path escapes a restricted workdir', async () => {
    await executeCreateFile(
      { path: join(outsideDir, 'planted.txt'), content: 'outside\n' },
      turnContext()
    );
    await getDb()
      .updateTable('chats')
      .set({ workdir, restrictToolsToWorkdir: 1 })
      .where('id', '=', chat.id)
      .execute();

    const response = await revert();

    expect(response.status).toBe(403);
    const body = (await response.json()) as unknown;
    expect(Value.Check(ApiErrorResponseSchema, body)).toBe(true);
    expect(body).toMatchObject({ code: ERROR_CODES.PERMISSION_DENIED });
  });

  it('returns 200 for the same checkpoint when the chat is unrestricted', async () => {
    await executeCreateFile(
      { path: join(outsideDir, 'planted.txt'), content: 'outside\n' },
      turnContext()
    );
    await getDb()
      .updateTable('chats')
      .set({ workdir, restrictToolsToWorkdir: 0 })
      .where('id', '=', chat.id)
      .execute();

    const response = await revert();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revertedFiles: 1 });
  });
});
