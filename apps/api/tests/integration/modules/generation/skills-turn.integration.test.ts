/**
 * End-to-end skills coverage: a full agentic turn discovers a skill from a
 * fixture source directory, advertises it in the system prompt, and lazily
 * loads its body, a bundled resource file, and a bundled script (run through
 * the real `bash` tool) — all against the real tools registry, skill-content
 * loader, and in-memory database. Only the model is scripted (a named fake
 * provider that drives the tool loop). The third-party source toggle is
 * exercised across turns to prove visibility follows user settings.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb } from '../../../../src/db/database';
import { loadConfigForTest } from '../../../../src/lib/config';
import {
  getAppSettings,
  updateAppSettings,
} from '../../../../src/modules/app-settings/application/app-settings-service';
import type { StreamEvent } from '../../../../src/modules/generation/application/stream-text-turn';
import { streamTextTurn } from '../../../../src/modules/generation/application/stream-text-turn';
import {
  resetSkillsCache,
  setThirdPartySkillDirsForTest,
} from '../../../../src/modules/skills/application/skill-discovery';
import { upsertToolSettings } from '../../../../src/modules/tool-settings/infrastructure/tool-settings-repository';
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

const RESOLVED_MODEL = {
  modelId: 'skills-e2e-model',
  providerType: 'openai-compatible' as const,
  capabilities: { text: true, image: false, streaming: true, tools: true },
};

let user: UserFixture;
let skillsDir: string;
let agentsDir: string;
let previousProvider: AIProvider | null = null;
let captured = false;

/**
 * Named fake provider that scripts a skills turn: advertise → load body →
 * load a bundled file and run a bundled script → finish. It records every
 * request so the test can assert on the system prompt and tool definitions.
 */
class ScriptedSkillsProvider implements AIProvider {
  readonly providerType = 'openai-compatible' as const;
  readonly requests: AgentTurnRequest[] = [];
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

  async *generateAgentTurnStream(req: AgentTurnRequest): AsyncIterable<AgentEvent> {
    await Promise.resolve();
    this.requests.push(req);
    this.iteration += 1;

    if (this.iteration === 1) {
      yield { type: 'tool_call_started', callId: 'skill-body', name: 'skill' };
      yield {
        type: 'tool_call_completed',
        callId: 'skill-body',
        name: 'skill',
        arguments: JSON.stringify({ name: 'pdf-tools' }),
      };
      yield { type: 'turn_completed' };
      return;
    }

    if (this.iteration === 2) {
      const body = JSON.parse(req.toolResults?.[0]?.result ?? '{}') as { baseDir: string };
      yield { type: 'tool_call_started', callId: 'skill-file', name: 'skill' };
      yield {
        type: 'tool_call_completed',
        callId: 'skill-file',
        name: 'skill',
        arguments: JSON.stringify({ name: 'pdf-tools', file: 'reference.md' }),
      };
      yield { type: 'tool_call_started', callId: 'skill-script', name: 'bash' };
      yield {
        type: 'tool_call_completed',
        callId: 'skill-script',
        name: 'bash',
        arguments: JSON.stringify({ command: 'bash scripts/hello.sh', cwd: body.baseDir }),
      };
      yield { type: 'turn_completed' };
      return;
    }

    yield { type: 'assistant_text_delta', text: 'Loaded the pdf-tools skill.' };
    yield { type: 'turn_completed' };
  }
}

/** Minimal single-shot fake: records the system prompt, then ends the turn. */
class PromptCapturingProvider implements AIProvider {
  readonly providerType = 'openai-compatible' as const;
  readonly requests: AgentTurnRequest[] = [];

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
    yield { type: 'assistant_text_delta', text: 'ok' };
    yield { type: 'turn_completed' };
  }
}

function writeSkill(root: string, slug: string, description: string): void {
  const dir = join(root, slug);
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${slug}\ndescription: ${description}\n---\n\n# PDF instructions\n\nUse the reference and the bundled script.\n`,
    'utf8'
  );
  writeFileSync(join(dir, 'reference.md'), 'Reference: run pdftotext on the input.\n', 'utf8');
  const script = join(dir, 'scripts', 'hello.sh');
  writeFileSync(script, '#!/usr/bin/env bash\necho "hello from pdf-tools"\n', 'utf8');
  chmodSync(script, 0o755);
}

async function collectTurn(prompt: string): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of streamTextTurn(
    {
      chatId,
      userId: user.id,
      prompt,
      resolvedModel: RESOLVED_MODEL,
      resolvedAgentProfile: makeAgentProfile({
        toolNames: ['*'],
        toolsEnabled: true,
        role: 'both',
      }),
    },
    getDb()
  )) {
    events.push(event);
  }
  return events;
}

let chatId: string;

beforeEach(async () => {
  skillsDir = mkdtempSync(join(tmpdir(), 'mango-skills-turn-'));
  agentsDir = mkdtempSync(join(tmpdir(), 'mango-skills-turn-agents-'));
  loadConfigForTest({
    auth: { secret: 'test-secret-at-least-32-characters-long', url: 'http://localhost:3001' },
    database: { path: ':memory:' },
    skills: { dir: skillsDir },
  });
  setThirdPartySkillDirsForTest({ agents: agentsDir });
  resetSkillsCache();

  user = await insertTestUser();
  const chat = await insertTestChat(user.id);
  chatId = chat.id;
  // bash is opt-in; enable it so the skill's bundled script can run.
  await upsertToolSettings(getDb(), user.id, 'bash', { enabled: true, parameters: {} });
});

afterEach(() => {
  if (previousProvider) registerProvider(previousProvider);
  previousProvider = null;
  captured = false;
  rmSync(skillsDir, { recursive: true, force: true });
  rmSync(agentsDir, { recursive: true, force: true });
  setThirdPartySkillDirsForTest(null);
  resetSkillsCache();
});

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

describe('skills lazy-load end-to-end turn', () => {
  it('advertises a skill, loads its body, a bundled file, and runs a bundled script', async () => {
    writeSkill(skillsDir, 'pdf-tools', 'Work with PDF files — extract text and fill forms.');
    const provider = new ScriptedSkillsProvider();
    installProvider(provider);

    const events = await collectTurn('Help me with a PDF.');

    // Turn 1 advertised the skill in the system prompt before any load.
    const firstPrompt = provider.requests[0]?.systemPrompt ?? '';
    expect(firstPrompt).toContain('<available-skills>');
    expect(firstPrompt).toContain('pdf-tools');

    const results = events.filter((event) => event.type === 'tool_result');
    const bodyResult = results.find((event) => event.callId === 'skill-body');
    const body = bodyResult?.result as { body: string; baseDir: string; files: string[] };
    expect(bodyResult?.isError).toBe(false);
    expect(body.body).toContain('PDF instructions');
    expect(body.baseDir).toBe(join(skillsDir, 'pdf-tools'));
    expect(body.files).toEqual(expect.arrayContaining(['reference.md', 'scripts/hello.sh']));

    const fileResult = results.find((event) => event.callId === 'skill-file');
    expect((fileResult?.result as { content: string }).content).toContain('pdftotext');

    const scriptResult = results.find((event) => event.callId === 'skill-script');
    expect(scriptResult?.isError).toBe(false);
    expect((scriptResult?.result as { stdout: string }).stdout).toContain('hello from pdf-tools');

    expect(events.some((event) => event.type === 'done')).toBe(true);
  });

  it('flips third-party skill visibility across turns when the source toggle changes', async () => {
    writeSkill(agentsDir, 'agents-skill', 'A skill provided by the .agents directory.');
    const provider = new PromptCapturingProvider();
    installProvider(provider);

    // Third-party sources default off: the .agents skill is not advertised.
    await collectTurn('First turn.');
    expect(provider.requests[0]?.systemPrompt ?? '').not.toContain('agents-skill');

    const current = await getAppSettings(getDb(), user.id);
    await updateAppSettings(getDb(), user.id, {
      ...current,
      skillSources: { agents: true, claude: false },
    });
    resetSkillsCache();

    await collectTurn('Second turn.');
    expect(provider.requests[1]?.systemPrompt ?? '').toContain('agents-skill');
  });
});
