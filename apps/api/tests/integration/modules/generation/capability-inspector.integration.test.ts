/**
 * Capability inspector integration coverage against the real runtime
 * resolver, tool bridge, skill discovery, and in-memory database. The core
 * guarantee under test: the names the inspector reports as `enabled` are
 * exactly the tool definitions `resolveTurnContext` hands the provider for
 * the same chat/model/agent selection. Also pins the safety envelope — no
 * server commands, environment values, or tool parameter schemas ever appear
 * in the serialized response.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  connectInProcessRuntime,
  createLocalRuntimeManifest,
  createRuntimeMethodHandlers,
  RuntimeHost,
} from '@mangostudio/runtime';
import { libraryLocationsFor, withLibraryLocations } from '@mangostudio/shared/app-settings';
import { ChatCapabilitiesResponseSchema } from '@mangostudio/shared/capabilities';
import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import { DEFAULT_PROFILE_ID } from '@mangostudio/shared/profiles';
import {
  RUNTIME_CONSENT_PRESETS,
  type RuntimeCapabilityAllow,
} from '@mangostudio/shared/runtime-home';
import Value from 'typebox/value';
import { getDb } from '../../../../src/db/database';
import { loadConfigForTest } from '../../../../src/lib/config';
import { updateAgentProfile } from '../../../../src/modules/agents/application/agent-settings-service';
import {
  getAppSettings,
  updateAppSettings,
} from '../../../../src/modules/app-settings/application/app-settings-service';
import { ChatNotFoundError } from '../../../../src/modules/chats/domain/chat-ownership';
import {
  effectiveToolNames,
  inspectChatCapabilities,
} from '../../../../src/modules/generation/application/inspect-chat-capabilities';
import { resolveTurnContext } from '../../../../src/modules/generation/application/resolve-turn-context';
import {
  resetSkillsCache,
  setThirdPartySkillDirsForTest,
} from '../../../../src/modules/skills/application/skill-discovery';
import { updateSkillSetting } from '../../../../src/modules/skills/application/skill-settings-service';
import { upsertToolSettings } from '../../../../src/modules/tool-settings/infrastructure/tool-settings-repository';
import {
  closeAllMcpClients,
  setMcpClientConnectorForTest,
} from '../../../../src/services/mcp/connection-manager';
import {
  getProvider,
  registerProvider,
} from '../../../../src/services/providers/core/provider-registry';
import type { AgentEvent, AIProvider } from '../../../../src/services/providers/types';
import { RuntimeClient } from '../../../../src/services/runtime-client/runtime-client';
import {
  RuntimeConnectionManager,
  setRuntimeConnectionManagerForTests,
} from '../../../../src/services/runtime-client/runtime-connection-manager';
import { insertTestChat, insertTestUser, type UserFixture } from '../../../support/factories';
import { makeFakeMcpHandle } from '../../../support/fixtures/mcp/fake-handle';

const MODEL_ID = 'capability-e2e-model';
const SECRET_ENV_VALUE = 'super-secret-env-value';
const SECRET_COMMAND = 'secret-command-binary';
/** Long enough that `mcp__alpha__<name>` exceeds the 64-char provider cap. */
const OVERLONG_TOOL = 'l'.repeat(60);

let user: UserFixture;
let chatId: string;
let skillsDir: string;
let agentsDir: string;
let previousProvider: AIProvider | null = null;

/** Named minimal fake so model routing resolves to a live provider object. */
class NoopProvider implements AIProvider {
  readonly providerType = 'openai-compatible' as const;

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
    yield { type: 'turn_completed' };
  }
}

async function insertServer(slug: string, enabled: number): Promise<string> {
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
      command: SECRET_COMMAND,
      argsJson: '[]',
      envJson: JSON.stringify({ SECRET_TOKEN: SECRET_ENV_VALUE }),
      url: null,
      enabled,
      timeoutMs: null,
      createdAt: now,
      updatedAt: now,
    })
    .execute();
  return id;
}

async function insertConnectorForModel(): Promise<void> {
  await getDb()
    .insertInto('secret_metadata')
    .values({
      id: `${user.id}-connector`,
      name: 'Capability Test Connector',
      provider: 'openai-compatible',
      configured: 1,
      source: 'config-file',
      maskedSuffix: null,
      updatedAt: Date.now(),
      lastValidatedAt: null,
      lastValidationError: null,
      enabledModels: JSON.stringify([MODEL_ID]),
      userId: user.id,
      baseUrl: null,
      organizationId: null,
      projectId: null,
    })
    .execute();
}

function writeSkill(root: string, slug: string): void {
  const dir = join(root, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${slug}\ndescription: Capability inspector fixture skill.\n---\n\nBody.\n`,
    'utf8'
  );
}

async function allowAllToolsForDefaultAgent(): Promise<void> {
  await updateAgentProfile(getDb(), user.id, 'default', {
    name: 'Default',
    description: '',
    role: 'both',
    systemPrompt: '',
    toolNames: ['*'],
    toolsEnabled: true,
    subagentIds: [],
    metadata: {},
  });
}

/**
 * Runs `body` against a Local runtime that announces `allow` as its consent —
 * what `mangostudio-runtime setup --slot host` on this machine would produce.
 */
async function withRuntimeConsent<T>(
  allow: RuntimeCapabilityAllow,
  body: () => Promise<T>
): Promise<T> {
  const manager = new RuntimeConnectionManager({
    resolveEnvironment: (userId) =>
      Promise.resolve({
        id: LOCAL_ENVIRONMENT_ID,
        userId,
        name: 'Local',
        transportKind: 'in-process' as const,
        config: {},
        enabled: true,
      }),
    connectors: {
      'in-process': async (_definition, onUnavailable) => {
        let host: RuntimeHost | undefined;
        const registry = createRuntimeMethodHandlers({
          runtimeVersion: 'test',
          emit: (event) => host?.emit(event),
        });
        host = new RuntimeHost({
          runtimeVersion: 'test',
          manifest: createLocalRuntimeManifest(allow),
          handlers: registry.handlers,
          onClose: () => void registry.close(),
        });
        const connection = await connectInProcessRuntime(host, { hubVersion: 'test' });
        return {
          client: new RuntimeClient(connection.client, onUnavailable),
          close: () => connection.close(),
        };
      },
    },
  });

  setRuntimeConnectionManagerForTests(manager);
  try {
    return await body();
  } finally {
    await manager.closeAll();
    setRuntimeConnectionManagerForTests(undefined);
  }
}

function inspect(overrides: Partial<Parameters<typeof inspectChatCapabilities>[0]> = {}) {
  return inspectChatCapabilities({
    db: getDb(),
    userId: user.id,
    chatId,
    model: MODEL_ID,
    ...overrides,
  });
}

beforeEach(async () => {
  skillsDir = mkdtempSync(join(tmpdir(), 'mango-capability-skills-'));
  agentsDir = mkdtempSync(join(tmpdir(), 'mango-capability-agents-'));
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
  await insertConnectorForModel();
  await allowAllToolsForDefaultAgent();

  try {
    previousProvider = getProvider('openai-compatible');
  } catch {
    previousProvider = null;
  }
  registerProvider(new NoopProvider());
});

afterEach(async () => {
  if (previousProvider) registerProvider(previousProvider);
  previousProvider = null;
  setMcpClientConnectorForTest(null);
  await closeAllMcpClients();
  setThirdPartySkillDirsForTest(null);
  resetSkillsCache();
  rmSync(skillsDir, { recursive: true, force: true });
  rmSync(agentsDir, { recursive: true, force: true });
});

describe('inspectChatCapabilities', () => {
  it('reports exactly the tool names resolveTurnContext hands the provider', async () => {
    await insertServer('alpha', 1);
    setMcpClientConnectorForTest(() =>
      Promise.resolve(
        makeFakeMcpHandle({
          listTools: () =>
            Promise.resolve([
              { name: 'echo', description: '', inputSchema: { type: 'object' } },
              { name: OVERLONG_TOOL, description: '', inputSchema: { type: 'object' } },
            ]),
        })
      )
    );
    // Disable one builtin so the parity covers a filtered candidate too.
    await upsertToolSettings(getDb(), user.id, 'generate_image', {
      enabled: false,
      parameters: {},
    });

    const [capabilities, turnContext] = [
      await inspect(),
      await resolveTurnContext(
        { chatId, userId: user.id, prompt: 'parity probe', model: MODEL_ID },
        getDb()
      ),
    ];

    const turnNames = turnContext.toolDefinitions.map((definition) => definition.name);
    expect(effectiveToolNames(capabilities)).toEqual(turnNames);
    expect(capabilities.counts.effectiveTools).toBe(turnNames.length);
    expect(turnNames).toContain('mcp__alpha__echo');
    expect(turnNames).not.toContain('generate_image');
    expect(Value.Check(ChatCapabilitiesResponseSchema, capabilities)).toBe(true);
  });

  it('explains filtered, disabled, and unavailable entries with typed reasons', async () => {
    await insertServer('alpha', 1);
    await insertServer('beta', 0);
    setMcpClientConnectorForTest(() =>
      Promise.resolve(
        makeFakeMcpHandle({
          listTools: () =>
            Promise.resolve([
              { name: 'echo', description: '', inputSchema: { type: 'object' } },
              { name: OVERLONG_TOOL, description: '', inputSchema: { type: 'object' } },
            ]),
        })
      )
    );
    await upsertToolSettings(getDb(), user.id, 'mcp__alpha__echo', {
      enabled: false,
      parameters: {},
    });

    const capabilities = await inspect();

    const disabledMcpTool = capabilities.tools.find((tool) => tool.name === 'mcp__alpha__echo');
    expect(disabledMcpTool?.state).toBe('disabled');
    expect(disabledMcpTool?.reason).toBe('tool-setting-disabled');

    const overlong = capabilities.tools.find((tool) => tool.name.startsWith('mcp__alpha__llllll'));
    expect(overlong?.state).toBe('unavailable');
    expect(overlong?.reason).toBe('name-over-provider-limit');

    const alpha = capabilities.mcpServers.find((server) => server.slug === 'alpha');
    expect(alpha?.state).toBe('enabled');
    expect(alpha?.effectiveToolCount).toBe(0);

    const beta = capabilities.mcpServers.find((server) => server.slug === 'beta');
    expect(beta?.state).toBe('disabled');
    expect(beta?.reason).toBe('server-disabled');
    expect(beta?.health).toBe('disabled');
  });

  it('names the refusing machine on servers a denied runtime would reject', async () => {
    await insertServer('alpha', 1);
    let connectCalls = 0;
    setMcpClientConnectorForTest(() => {
      connectCalls += 1;
      return Promise.resolve(
        makeFakeMcpHandle({
          listTools: () =>
            Promise.resolve([{ name: 'echo', description: '', inputSchema: { type: 'object' } }]),
        })
      );
    });

    const capabilities = await withRuntimeConsent(
      { ...RUNTIME_CONSENT_PRESETS.full, mcp: false },
      () => inspect()
    );

    const alpha = capabilities.mcpServers.find((server) => server.slug === 'alpha');
    expect(alpha?.state).toBe('unavailable');
    expect(alpha?.reason).toBe('runtime-denied');
    expect(alpha?.environmentName).toBe('Local');
    // The peer refuses mcp.connect; the inspector must not spend the listing
    // budget rediscovering that, nor report it as a generic server failure.
    expect(connectCalls).toBe(0);
    expect(capabilities.tools.some((tool) => tool.source === 'mcp')).toBe(false);
  });

  it('shrinks the turn tool list on a readonly machine and explains every drop', async () => {
    // The plan's regression bar for the cosmetic filter: a readonly machine
    // must reach the provider with fewer tools than a full one, the inspector
    // must name why for each, and the turn must still resolve — a refused
    // capability is a state, not a failed turn.
    const full = await resolveTurnContext(
      { chatId, userId: user.id, prompt: 'full probe', model: MODEL_ID },
      getDb()
    );

    const [capabilities, readonlyTurn] = await withRuntimeConsent(
      RUNTIME_CONSENT_PRESETS.readonly,
      async () =>
        [
          await inspect(),
          await resolveTurnContext(
            { chatId, userId: user.id, prompt: 'readonly probe', model: MODEL_ID },
            getDb()
          ),
        ] as const
    );

    const fullNames = full.toolDefinitions.map((definition) => definition.name);
    const readonlyNames = readonlyTurn.toolDefinitions.map((definition) => definition.name);
    expect(readonlyNames.length).toBeLessThan(fullNames.length);
    expect(fullNames).toContain('write_file');
    expect(readonlyNames).not.toContain('write_file');
    expect(readonlyNames).toContain('read_file');

    // The inspector is the same projection the turn used, so parity holds
    // under denial too — and every withheld tool carries the machine's name.
    expect(effectiveToolNames(capabilities)).toEqual(readonlyNames);
    const denied = capabilities.tools.filter((tool) => tool.reason === 'runtime-denied');
    expect(denied.length).toBeGreaterThan(0);
    expect(denied.every((tool) => tool.environmentName === 'Local')).toBe(true);
    expect(denied.every((tool) => tool.state === 'unavailable')).toBe(true);
    expect(capabilities.tools.find((tool) => tool.name === 'write_file')?.reason).toBe(
      'runtime-denied'
    );
    expect(Value.Check(ChatCapabilitiesResponseSchema, capabilities)).toBe(true);
  });

  it('reports allowlist exclusions as disabled while preserving turn parity', async () => {
    await updateAgentProfile(getDb(), user.id, 'default', {
      name: 'Default',
      description: '',
      role: 'both',
      systemPrompt: '',
      toolNames: [],
      toolsEnabled: true,
      subagentIds: [],
      metadata: {},
    });

    const [capabilities, turnContext] = [
      await inspect(),
      await resolveTurnContext(
        { chatId, userId: user.id, prompt: 'allowlist parity probe', model: MODEL_ID },
        getDb()
      ),
    ];
    const excludedTool = capabilities.tools.find((tool) => tool.reason === 'agent-allowlist');

    expect(excludedTool?.state).toBe('disabled');
    expect(effectiveToolNames(capabilities)).toEqual(
      turnContext.toolDefinitions.map((definition) => definition.name)
    );
  });

  it('reports skill provenance: enabled, disabled, and shadowed copies', async () => {
    writeSkill(skillsDir, 'notes');
    writeSkill(skillsDir, 'draft');
    writeSkill(agentsDir, 'notes');
    const settings = await getAppSettings(getDb(), user.id);
    await updateAppSettings(
      getDb(),
      user.id,
      withLibraryLocations(settings, DEFAULT_PROFILE_ID, {
        ...libraryLocationsFor(settings),
        home: { ...libraryLocationsFor(settings).home, 'agents-skills': true },
      })
    );
    resetSkillsCache();
    await updateSkillSetting(getDb(), user.id, 'mango:draft', { enabled: false });

    const capabilities = await inspect();

    const bySkillKey = new Map(capabilities.skills.map((skill) => [skill.key, skill]));
    expect(bySkillKey.get('mango:notes')?.state).toBe('enabled');
    expect(bySkillKey.get('mango:draft')?.state).toBe('disabled');
    expect(bySkillKey.get('mango:draft')?.reason).toBe('skill-disabled');
    expect(bySkillKey.get('agents:notes')?.state).toBe('unavailable');
    expect(bySkillKey.get('agents:notes')?.reason).toBe('skill-shadowed');
    expect(capabilities.counts.effectiveSkills).toBe(1);
  });

  it('never serializes commands, environment values, or tool schemas', async () => {
    await insertServer('alpha', 1);
    setMcpClientConnectorForTest(() =>
      Promise.resolve(
        makeFakeMcpHandle({
          listTools: () =>
            Promise.resolve([
              {
                name: 'echo',
                description: '',
                inputSchema: {
                  type: 'object',
                  properties: { leaky_argument_name: { type: 'string' } },
                },
              },
            ]),
        })
      )
    );

    const serialized = JSON.stringify(await inspect());

    expect(serialized).not.toContain(SECRET_ENV_VALUE);
    expect(serialized).not.toContain(SECRET_COMMAND);
    expect(serialized).not.toContain('leaky_argument_name');
    expect(serialized).not.toContain('inputSchema');
  });

  it('rejects a chat owned by another user', async () => {
    const stranger = await insertTestUser();
    await expect(inspect({ userId: stranger.id })).rejects.toBeInstanceOf(ChatNotFoundError);
  });
});
