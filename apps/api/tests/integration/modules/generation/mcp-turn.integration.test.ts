/**
 * End-to-end MCP coverage: enabled servers bridge their tools into a full
 * agentic turn as namespaced `mcp__<slug>__<tool>` definitions, the scripted
 * model calls one, and the result is recorded in the persisted message parts —
 * all through the real connection manager, tool bridge, and in-memory database.
 * A real SDK server (over the in-memory transport) backs the calls, so failure
 * modes (server error, oversized output, per-server timeout) degrade to typed
 * error/capped results without failing the turn. Transport spawn/HTTP specifics
 * are covered by the dedicated MCP transport integration tests.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MCP_RESULT_TRUNCATION_MARKER } from '@mangostudio/runtime';
import { getDb } from '../../../../src/db/database';
import { loadConfigForTest } from '../../../../src/lib/config';
import { resolveTurnContext } from '../../../../src/modules/generation/application/resolve-turn-context';
import type { StreamEvent } from '../../../../src/modules/generation/application/stream-text-turn';
import { streamTextTurn } from '../../../../src/modules/generation/application/stream-text-turn';
import {
  resetSkillsCache,
  setThirdPartySkillDirsForTest,
} from '../../../../src/modules/skills/application/skill-discovery';
import {
  closeAllMcpClients,
  setMcpClientConnectorForTest,
} from '../../../../src/services/mcp/connection-manager';
import {
  getProvider,
  registerProvider,
} from '../../../../src/services/providers/core/provider-registry';
import type {
  AgentEvent,
  AgentTurnRequest,
  AIProvider,
} from '../../../../src/services/providers/types';
import { makeAgentProfile } from '../../../integration/routes/_respond-stream-helpers';
import { insertTestChat, insertTestUser, type UserFixture } from '../../../support/factories';
import {
  inMemoryMcpConnector,
  PICTURE_TOOL_NOTES_TEXT,
  PICTURE_TOOL_RESOURCE_TEXT,
} from '../../../support/fixtures/mcp/in-memory-mcp';

const RESOLVED_MODEL = {
  modelId: 'mcp-e2e-model',
  providerType: 'openai-compatible' as const,
  capabilities: { text: true, image: false, streaming: true, tools: true },
};

let user: UserFixture;
let chatId: string;
let skillsDir: string;
let mediaDir: string;
let previousProvider: AIProvider | null = null;
let captured = false;

/**
 * Named fake provider that calls a single named tool on the first iteration,
 * then finishes. Records each request so tests can assert on the exposed tool
 * definitions.
 */
class SingleToolCallProvider implements AIProvider {
  readonly providerType = 'openai-compatible' as const;
  readonly requests: AgentTurnRequest[] = [];
  private iteration = 0;

  constructor(
    private readonly toolName: string,
    private readonly toolArgs: Record<string, unknown> = {}
  ) {}

  generateText(): ReturnType<AIProvider['generateText']> {
    return Promise.resolve({ text: '' });
  }

  listModels(): ReturnType<AIProvider['listModels']> {
    return Promise.resolve([]);
  }

  validateApiKey(): Promise<void> {
    return Promise.resolve();
  }

  resolveApiKey(): Promise<string> {
    return Promise.resolve('test-key');
  }

  async *generateAgentTurnStream(req: AgentTurnRequest): AsyncIterable<AgentEvent> {
    await Promise.resolve();
    this.requests.push(req);
    this.iteration += 1;
    if (this.iteration === 1) {
      yield { type: 'tool_call_started', callId: 'call-1', name: this.toolName };
      yield {
        type: 'tool_call_completed',
        callId: 'call-1',
        name: this.toolName,
        arguments: JSON.stringify(this.toolArgs),
      };
      yield { type: 'turn_completed' };
      return;
    }
    yield { type: 'assistant_text_delta', text: 'done' };
    yield { type: 'turn_completed' };
  }
}

/** Provider that calls a skill and an MCP tool in the same turn, then finishes. */
class SkillPlusMcpProvider implements AIProvider {
  readonly providerType = 'openai-compatible' as const;
  private iteration = 0;

  generateText(): ReturnType<AIProvider['generateText']> {
    return Promise.resolve({ text: '' });
  }

  listModels(): ReturnType<AIProvider['listModels']> {
    return Promise.resolve([]);
  }

  validateApiKey(): Promise<void> {
    return Promise.resolve();
  }

  resolveApiKey(): Promise<string> {
    return Promise.resolve('test-key');
  }

  async *generateAgentTurnStream(): AsyncIterable<AgentEvent> {
    await Promise.resolve();
    this.iteration += 1;
    if (this.iteration === 1) {
      yield { type: 'tool_call_started', callId: 'skill-1', name: 'skill' };
      yield {
        type: 'tool_call_completed',
        callId: 'skill-1',
        name: 'skill',
        arguments: JSON.stringify({ name: 'notes' }),
      };
      yield { type: 'tool_call_started', callId: 'mcp-1', name: 'mcp__echo-server__echo' };
      yield {
        type: 'tool_call_completed',
        callId: 'mcp-1',
        name: 'mcp__echo-server__echo',
        arguments: JSON.stringify({ text: 'cross-feature' }),
      };
      yield { type: 'turn_completed' };
      return;
    }
    yield { type: 'assistant_text_delta', text: 'done' };
    yield { type: 'turn_completed' };
  }
}

async function insertServer(slug: string, timeoutMs: number | null = null): Promise<string> {
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
      command: 'bun',
      argsJson: '[]',
      envJson: '{}',
      url: null,
      enabled: 1,
      timeoutMs,
      createdAt: now,
      updatedAt: now,
    })
    .execute();
  return id;
}

function writeSkill(slug: string, description: string): void {
  const dir = join(skillsDir, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${slug}\ndescription: ${description}\n---\n\nNotes body.\n`,
    'utf8'
  );
}

function agentInput(prompt: string) {
  return {
    chatId,
    userId: user.id,
    prompt,
    resolvedModel: RESOLVED_MODEL,
    resolvedAgentProfile: makeAgentProfile({
      toolNames: ['*'],
      toolsEnabled: true,
      role: 'both' as const,
    }),
  };
}

async function collectTurn(prompt: string): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of streamTextTurn(agentInput(prompt), getDb())) {
    events.push(event);
  }
  return events;
}

type ToolResultEvent = Extract<StreamEvent, { type: 'tool_result' }>;

function toolResult(events: StreamEvent[], callId: string): ToolResultEvent | undefined {
  return events
    .filter((event) => event.type === 'tool_result')
    .find((event) => event.callId === callId);
}

async function loadAiParts(): Promise<Array<Record<string, unknown>>> {
  const row = await getDb()
    .selectFrom('messages')
    .select('parts')
    .where('chatId', '=', chatId)
    .where('role', '=', 'ai')
    .orderBy('timestamp', 'desc')
    .executeTakeFirst();
  const raw = row?.parts;
  return typeof raw === 'string' && raw.trim()
    ? (JSON.parse(raw) as Array<Record<string, unknown>>)
    : [];
}

function installProvider(provider: AIProvider): void {
  // Capture the original provider only on the first install of a test; a second
  // install would otherwise snapshot the fake we just registered, and afterEach
  // would restore that fake instead of the real provider.
  if (!captured) {
    try {
      previousProvider = getProvider('openai-compatible');
    } catch {
      previousProvider = null;
    }
    captured = true;
  }
  registerProvider(provider);
}

beforeEach(async () => {
  skillsDir = mkdtempSync(join(tmpdir(), 'mango-mcp-turn-skills-'));
  mediaDir = mkdtempSync(join(tmpdir(), 'mango-mcp-turn-media-'));
  loadConfigForTest({
    auth: { secret: 'test-secret-at-least-32-characters-long', url: 'http://localhost:3001' },
    database: { path: ':memory:' },
    skills: { dir: skillsDir },
    images: { dir: join(mediaDir, 'images') },
    uploads: { dir: join(mediaDir, 'uploads') },
  });
  setThirdPartySkillDirsForTest({});
  resetSkillsCache();
  setMcpClientConnectorForTest(inMemoryMcpConnector());
  user = await insertTestUser();
  const chat = await insertTestChat(user.id);
  chatId = chat.id;
});

afterEach(async () => {
  if (previousProvider) registerProvider(previousProvider);
  previousProvider = null;
  captured = false;
  setMcpClientConnectorForTest(null);
  await closeAllMcpClients();
  setThirdPartySkillDirsForTest(null);
  resetSkillsCache();
  rmSync(skillsDir, { recursive: true, force: true });
  rmSync(mediaDir, { recursive: true, force: true });
});

describe('MCP tool round trip end-to-end', () => {
  it('bridges a server tool into the turn and records its result in message parts', async () => {
    await insertServer('echo-server');
    const provider = new SingleToolCallProvider('mcp__echo-server__echo', { text: 'hi mcp' });
    installProvider(provider);

    const events = await collectTurn('Use the echo tool.');

    expect(provider.requests[0]?.toolDefinitions?.map((tool) => tool.name)).toContain(
      'mcp__echo-server__echo'
    );

    const result = toolResult(events, 'call-1');
    expect(result?.isError).toBe(false);
    expect(result?.result).toBe('hi mcp');
    expect(events.some((event) => event.type === 'done')).toBe(true);

    const parts = await loadAiParts();
    expect(parts).toContainEqual(
      expect.objectContaining({
        type: 'tool_result',
        toolCallId: 'call-1',
        content: JSON.stringify('hi mcp'),
        isError: false,
      })
    );
  });

  it('maps every supported content block and reloads rich-media provenance', async () => {
    await insertServer('camera');
    const provider = new SingleToolCallProvider('mcp__camera__picture', {});
    installProvider(provider);

    const events = await collectTurn('Take a picture.');

    const mediaEvents = events.filter((event) => event.type === 'mcp_media');
    expect(mediaEvents).toHaveLength(2);
    expect(mediaEvents[0]?.part).toMatchObject({
      type: 'mcp_media',
      toolCallId: 'call-1',
      serverSlug: 'camera',
      toolName: 'picture',
      kind: 'image',
      mimeType: 'image/png',
    });
    expect(mediaEvents[0]?.part.url).toStartWith('/images/mcp-');
    expect(mediaEvents[1]?.part).toMatchObject({
      kind: 'resource',
      mimeType: 'application/pdf',
      uri: 'file:///report.pdf',
    });
    expect(mediaEvents[1]?.part.url).toStartWith('/uploads/');

    // The model-facing result keeps readable text and explicit placeholders
    // for content that cannot be inlined into the provider context.
    const result = toolResult(events, 'call-1');
    expect(result?.isError).toBe(false);
    expect(result?.result).toContain(PICTURE_TOOL_NOTES_TEXT);
    expect(result?.result).toContain('[image content, image/png]');
    expect(result?.result).toContain('[audio content, audio/wav]');
    expect(result?.result).toContain(PICTURE_TOOL_RESOURCE_TEXT);
    expect(result?.result).toContain('[unsupported resource_link content, text/plain]');
    expect(result?.result).toContain('[binary resource file:///report.pdf, application/pdf]');

    // Read the durable row again rather than asserting on the live event
    // objects: this is the same provenance a page reload consumes.
    const reloadedParts = await loadAiParts();
    const reloadedMedia = reloadedParts.filter((part) => part.type === 'mcp_media');
    expect(reloadedMedia).toHaveLength(2);
    expect(reloadedMedia).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'mcp_media',
          toolCallId: 'call-1',
          serverSlug: 'camera',
          toolName: 'picture',
          kind: 'image',
          mimeType: 'image/png',
          url: expect.stringMatching(/^\/images\/mcp-/),
        }),
        expect.objectContaining({
          type: 'mcp_media',
          toolCallId: 'call-1',
          serverSlug: 'camera',
          toolName: 'picture',
          kind: 'resource',
          mimeType: 'application/pdf',
          uri: 'file:///report.pdf',
          url: expect.stringMatching(/^\/uploads\//),
        }),
      ])
    );

    // The stored binary resource is a queryable chat attachment.
    const attachments = await getDb()
      .selectFrom('chat_attachments')
      .selectAll()
      .where('chatId', '=', chatId)
      .execute();
    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.mimeType).toBe('application/pdf');
  });

  it('rejects malformed SDK content as a typed tool error without unsafe persistence', async () => {
    await insertServer('odd-server');
    installProvider(new SingleToolCallProvider('mcp__odd-server__unusual-content'));

    const events = await collectTurn('Inspect unusual content.');

    const result = toolResult(events, 'call-1');
    expect(result?.isError).toBe(true);
    expect(result?.result).toEqual(expect.objectContaining({ error: expect.any(String) }));
    expect(events.filter((event) => event.type === 'mcp_media')).toHaveLength(0);

    const reloadedParts = await loadAiParts();
    expect(reloadedParts.filter((part) => part.type === 'mcp_media')).toHaveLength(0);
    const attachments = await getDb()
      .selectFrom('chat_attachments')
      .select('id')
      .where('chatId', '=', chatId)
      .execute();
    expect(attachments).toHaveLength(0);
  });

  it('hides a disabled server tools on the next turn', async () => {
    const serverId = await insertServer('echo-server');
    const first = new SingleToolCallProvider('mcp__echo-server__echo', { text: 'x' });
    installProvider(first);
    await collectTurn('Turn one.');
    expect(first.requests[0]?.toolDefinitions?.map((tool) => tool.name)).toContain(
      'mcp__echo-server__echo'
    );

    await getDb()
      .updateTable('mcp_servers')
      .set({ enabled: 0 })
      .where('id', '=', serverId)
      .execute();

    const second = new SingleToolCallProvider('mcp__echo-server__echo', { text: 'x' });
    installProvider(second);
    await collectTurn('Turn two.');
    expect(second.requests[0]?.toolDefinitions?.map((tool) => tool.name)).not.toContain(
      'mcp__echo-server__echo'
    );
  });

  it('surfaces a server tool error as a typed error result without failing the turn', async () => {
    await insertServer('echo-server');
    installProvider(new SingleToolCallProvider('mcp__echo-server__boom'));

    const events = await collectTurn('Trigger the error.');

    const result = toolResult(events, 'call-1');
    expect(result?.isError).toBe(true);
    expect(result?.result).toEqual({ error: 'tool exploded' });
    expect(events.some((event) => event.type === 'done')).toBe(true);
  });

  it('caps an oversized server tool result with a truncation marker', async () => {
    await insertServer('echo-server');
    installProvider(new SingleToolCallProvider('mcp__echo-server__big'));

    const events = await collectTurn('Dump a lot of text.');

    const text = toolResult(events, 'call-1')?.result as string;
    expect(text.endsWith(MCP_RESULT_TRUNCATION_MARKER)).toBe(true);
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(70 * 1024);
    expect(events.some((event) => event.type === 'done')).toBe(true);
  });

  it('honors the per-server timeout for a hanging tool', async () => {
    await insertServer('echo-server', 150);
    installProvider(new SingleToolCallProvider('mcp__echo-server__hang'));

    const events = await collectTurn('Call the slow tool.');

    expect(toolResult(events, 'call-1')?.isError).toBe(true);
    expect(events.some((event) => event.type === 'done')).toBe(true);
  });
});

describe('cross-feature turn (skill + MCP)', () => {
  it('exposes both the skill tool and a bridged MCP tool, advertising skills in the prompt', async () => {
    writeSkill('notes', 'Take structured notes.');
    await insertServer('echo-server');

    const context = await resolveTurnContext(agentInput('Prep the turn.'), getDb());
    const toolNames = context.toolDefinitions.map((tool) => tool.name);

    expect(toolNames).toContain('skill');
    expect(toolNames).toContain('mcp__echo-server__echo');
    expect(context.effectiveSystemPrompt ?? '').toContain('<available-skills>');
    expect(context.effectiveSystemPrompt ?? '').toContain('notes');
  });

  it('runs a skill load and an MCP call in a single turn', async () => {
    writeSkill('notes', 'Take structured notes.');
    await insertServer('echo-server');
    installProvider(new SkillPlusMcpProvider());

    const events = await collectTurn('Load notes and echo.');

    expect((toolResult(events, 'skill-1')?.result as { body: string }).body).toContain(
      'Notes body'
    );
    expect(toolResult(events, 'mcp-1')?.result).toBe('cross-feature');
    expect(events.some((event) => event.type === 'done')).toBe(true);
  });
});
