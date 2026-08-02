/**
 * End-to-end coverage of the MCP resources/prompts endpoints' application
 * layer over a real SDK server (in-memory transport): capability gating
 * against a tools-only server, resource listing/reading with text inlining
 * and binary attach-to-chat, and prompt listing/resolution.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setMcpTransportFactoryForTest } from '@mangostudio/runtime';
import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import { ERROR_CODES } from '@mangostudio/shared/errors';
import { getDb } from '../../../../src/db/database';
import { loadConfigForTest } from '../../../../src/lib/config';
import {
  getMcpServerPrompt,
  listMcpServerPrompts,
  listMcpServerResources,
  readMcpServerResource,
} from '../../../../src/modules/mcp-servers/application/mcp-resource-prompt-service';
import { McpServerError } from '../../../../src/modules/mcp-servers/domain/mcp-server';
import {
  closeAllMcpClients,
  setMcpClientConnectorForTest,
} from '../../../../src/services/mcp/connection-manager';
import { insertTestChat, insertTestUser, type UserFixture } from '../../../support/factories';
import { createEchoMcpServer } from '../../../support/fixtures/mcp/create-echo-mcp-server';
import {
  createLibraryMcpServer,
  LIBRARY_NOTES_TEXT,
  LIBRARY_NOTES_URI,
  LIBRARY_REPORT_URI,
} from '../../../support/fixtures/mcp/create-library-mcp-server';
import { inMemoryMcpConnector } from '../../../support/fixtures/mcp/in-memory-mcp';

let user: UserFixture;
let uploadsDir: string;

async function insertServer(slug: string): Promise<string> {
  const id = `${user.id}-${slug}`;
  const now = Date.now();
  await getDb()
    .insertInto('mcp_servers')
    .values({
      id,
      userId: user.id,
      name: `Server ${slug}`,
      slug,
      transport: 'stdio',
      environmentId: LOCAL_ENVIRONMENT_ID,
      command: 'bun',
      argsJson: '[]',
      envJson: '{}',
      url: null,
      enabled: 1,
      timeoutMs: null,
      createdAt: now,
      updatedAt: now,
    })
    .execute();
  return id;
}

beforeEach(async () => {
  uploadsDir = mkdtempSync(join(tmpdir(), 'mango-mcp-resources-'));
  loadConfigForTest({
    auth: { secret: 'test-secret-at-least-32-characters-long', url: 'http://localhost:3001' },
    database: { path: ':memory:' },
    uploads: { dir: uploadsDir },
  });
  setMcpClientConnectorForTest(inMemoryMcpConnector(createLibraryMcpServer));
  user = await insertTestUser();
});

afterEach(async () => {
  setMcpClientConnectorForTest(null);
  setMcpTransportFactoryForTest(null);
  await closeAllMcpClients();
  rmSync(uploadsDir, { recursive: true, force: true });
});

describe('capability gating', () => {
  it('rejects resources and prompts on a tools-only server with a 404 code', async () => {
    setMcpClientConnectorForTest(inMemoryMcpConnector(createEchoMcpServer));
    const id = await insertServer('tools-only');

    for (const call of [
      () => listMcpServerResources(getDb(), user.id, id),
      () => readMcpServerResource(getDb(), user.id, id, { uri: LIBRARY_NOTES_URI }),
      () => listMcpServerPrompts(getDb(), user.id, id),
      () => getMcpServerPrompt(getDb(), user.id, id, { name: 'greet' }),
    ]) {
      const error = await call().then(
        () => null,
        (thrown: unknown) => thrown
      );
      expect(error).toBeInstanceOf(McpServerError);
      expect((error as McpServerError).status).toBe(404);
      expect((error as McpServerError).code).toBe(ERROR_CODES.UNSUPPORTED);
    }
  });

  it('rejects an unknown server with NOT_FOUND before connecting', async () => {
    const error = await listMcpServerResources(getDb(), user.id, 'missing-id').then(
      () => null,
      (thrown: unknown) => thrown
    );
    expect(error).toBeInstanceOf(McpServerError);
    expect((error as McpServerError).status).toBe(404);
    expect((error as McpServerError).code).toBe(ERROR_CODES.NOT_FOUND);
  });
});

describe('resources', () => {
  it('lists the advertised resources', async () => {
    const id = await insertServer('library');

    const { resources } = await listMcpServerResources(getDb(), user.id, id);

    expect(resources).toEqual([
      {
        uri: LIBRARY_NOTES_URI,
        name: 'notes',
        description: 'Project notes.',
        mimeType: 'text/markdown',
        sizeBytes: LIBRARY_NOTES_TEXT.length,
      },
      { uri: LIBRARY_REPORT_URI, name: 'report', mimeType: 'application/pdf' },
    ]);
  });

  it('reads a text resource inline and never inlines binary payloads', async () => {
    const id = await insertServer('library');

    const text = await readMcpServerResource(getDb(), user.id, id, { uri: LIBRARY_NOTES_URI });
    expect(text.contents).toEqual([
      {
        uri: LIBRARY_NOTES_URI,
        mimeType: 'text/markdown',
        text: LIBRARY_NOTES_TEXT,
        isBinary: false,
      },
    ]);
    expect(text.attachments).toBeUndefined();

    const binary = await readMcpServerResource(getDb(), user.id, id, { uri: LIBRARY_REPORT_URI });
    expect(binary.contents).toEqual([
      { uri: LIBRARY_REPORT_URI, mimeType: 'application/pdf', isBinary: true },
    ]);
  });

  it('persists contents as chat attachments when a chatId is provided', async () => {
    const id = await insertServer('library');
    const chat = await insertTestChat(user.id);

    const response = await readMcpServerResource(getDb(), user.id, id, {
      uri: LIBRARY_REPORT_URI,
      chatId: chat.id,
    });

    expect(response.attachments).toHaveLength(1);
    const attachment = response.attachments?.[0];
    expect(attachment).toMatchObject({
      chatId: chat.id,
      mimeType: 'application/pdf',
      kind: 'pdf',
      originalName: 'report.pdf',
    });
    expect(attachment?.url).toStartWith('/uploads/');

    const rows = await getDb()
      .selectFrom('chat_attachments')
      .selectAll()
      .where('chatId', '=', chat.id)
      .execute();
    expect(rows).toHaveLength(1);
    expect(existsSync(join(uploadsDir, rows[0]?.relativePath ?? ''))).toBe(true);
  });

  it('rejects attaching to a chat the user does not own', async () => {
    const id = await insertServer('library');
    const otherUser = await insertTestUser();
    const foreignChat = await insertTestChat(otherUser.id);

    const error = await readMcpServerResource(getDb(), user.id, id, {
      uri: LIBRARY_NOTES_URI,
      chatId: foreignChat.id,
    }).then(
      () => null,
      (thrown: unknown) => thrown
    );

    expect(error).toBeInstanceOf(McpServerError);
    expect((error as McpServerError).status).toBe(404);
  });
});

describe('prompts', () => {
  it('lists prompts with their argument descriptors', async () => {
    const id = await insertServer('library');

    const { prompts } = await listMcpServerPrompts(getDb(), user.id, id);

    expect(prompts).toEqual([
      {
        name: 'summarize',
        description: 'Summarize a topic.',
        arguments: [{ name: 'topic', description: 'What to summarize.', required: true }],
      },
      { name: 'greet', description: 'A fixed greeting.', arguments: [] },
    ]);
  });

  it('resolves a prompt with arguments to flattened message text', async () => {
    const id = await insertServer('library');

    const prompt = await getMcpServerPrompt(getDb(), user.id, id, {
      name: 'summarize',
      arguments: { topic: 'mangoes' },
    });

    expect(prompt).toEqual({
      description: 'Summarize a topic.',
      messages: [{ role: 'user', text: 'Summarize mangoes.' }],
    });
  });
});
