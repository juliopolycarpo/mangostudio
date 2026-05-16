import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { AgentProfile } from '@mangostudio/shared/agents';
import {
  clearRegistry,
  executeTool,
  getAllToolDefinitions,
  getAllTools,
  getTool,
  getToolDefinitionsForAgent,
  getToolDefinitionsForSettings,
  getToolDescriptors,
  registerTool,
} from '../../../src/services/tools/registry';
import type { RegisteredTool, ToolContext, ToolExecutor } from '../../../src/services/tools/types';

const ctx: ToolContext = { userId: 'u1', chatId: 'c1', parameters: {} };

function snapshotRegistry(): RegisteredTool[] {
  return getAllTools().map((tool) => {
    return {
      definition: { ...tool.definition },
      settings: { ...tool.settings, parameterDescriptors: [...tool.settings.parameterDescriptors] },
      execute: tool.execute,
      buildDefinition: tool.buildDefinition,
    };
  });
}

function restoreRegistry(snapshot: RegisteredTool[]): void {
  clearRegistry();
  for (const tool of snapshot) {
    registerTool(tool);
  }
}

function makeTool(
  name: string,
  execute: ToolExecutor = () => Promise.resolve(null)
): RegisteredTool {
  return {
    definition: { name, description: 'desc', parameters: { type: 'object' } },
    settings: {
      title: name,
      description: 'Tool description',
      category: 'system' as const,
      enabledByDefault: true,
      canDisable: true,
      defaultParameters: {},
      parameterDescriptors: [],
    },
    execute,
  };
}

function makeAgentProfile(overrides: Partial<AgentProfile>): AgentProfile {
  return {
    id: 'user:tool-runner',
    name: 'Tool Runner',
    description: '',
    kind: 'user',
    role: 'primary',
    source: { type: 'markdown' },
    systemPrompt: 'Use selected tools only.',
    toolNames: [],
    toolsEnabled: false,
    subagentIds: [],
    metadata: {},
    ...overrides,
  };
}

describe('registerTool / getTool', () => {
  let snapshot: RegisteredTool[];

  beforeEach(() => {
    snapshot = snapshotRegistry();
    clearRegistry();
  });

  afterEach(() => {
    restoreRegistry(snapshot);
  });
  it('registers and retrieves a tool by name', () => {
    registerTool(makeTool('my_tool', () => Promise.resolve('result')));

    const t = getTool('my_tool');
    expect(t).toBeDefined();
    expect(t?.definition.name).toBe('my_tool');
  });

  it('returns undefined for an unknown tool', () => {
    expect(getTool('nonexistent')).toBeUndefined();
  });

  it('overwrites an existing tool registration', () => {
    const exec1 = () => Promise.resolve('v1');
    const exec2 = () => Promise.resolve('v2');

    registerTool(makeTool('dup', exec1));
    registerTool(makeTool('dup', exec2));

    expect(getTool('dup')?.execute).toBe(exec2);
  });
});

describe('getAllTools / getAllToolDefinitions', () => {
  let snapshot: RegisteredTool[];

  beforeEach(() => {
    snapshot = snapshotRegistry();
    clearRegistry();
  });

  afterEach(() => {
    restoreRegistry(snapshot);
  });
  it('returns all registered tools', () => {
    registerTool(makeTool('a'));
    registerTool(makeTool('b'));
    expect(getAllTools()).toHaveLength(2);
  });

  it('returns only definitions via getAllToolDefinitions', () => {
    registerTool(makeTool('x'));
    const defs = getAllToolDefinitions();
    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe('x');
    expect(defs[0].description).toBe('desc');
  });

  it('returns descriptors without executing tools', () => {
    registerTool(makeTool('described_tool'));

    const descriptors = getToolDescriptors();

    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]).toMatchObject({
      name: 'described_tool',
      title: 'described_tool',
      enabled: true,
      category: 'system',
    });
  });

  it('filters disabled tools from provider definitions', () => {
    registerTool(makeTool('enabled_tool'));
    registerTool(makeTool('disabled_tool'));

    const defs = getToolDefinitionsForSettings(
      new Map([['disabled_tool', { enabled: false, parameters: {} }]])
    );

    expect(defs.map((definition) => definition.name)).toEqual(['enabled_tool']);
  });

  it('builds provider definitions from effective settings', () => {
    const tool = makeTool('dynamic_schema_tool');

    registerTool({
      ...tool,
      settings: {
        ...tool.settings,
        defaultParameters: { maxItems: 4 },
        parameterDescriptors: [
          {
            name: 'maxItems',
            label: 'Max items',
            type: 'number',
            required: true,
            defaultValue: 4,
            min: 1,
            max: 8,
          },
        ],
      },
      buildDefinition: (settings) => ({
        ...tool.definition,
        parameters: {
          ...tool.definition.parameters,
          maxItems: settings.parameters.maxItems,
        },
      }),
    });

    const defs = getToolDefinitionsForSettings(
      new Map([['dynamic_schema_tool', { enabled: true, parameters: { maxItems: 2 } }]])
    );

    expect(defs).toHaveLength(1);
    expect(defs[0].parameters).toMatchObject({ maxItems: 2 });
  });

  it('filters provider definitions through an agent allowlist', () => {
    registerTool(makeTool('read_file'));
    registerTool(makeTool('generate_image'));

    const defs = getToolDefinitionsForAgent(
      makeAgentProfile({ toolsEnabled: true, toolNames: ['read_file'] })
    );

    expect(defs.map((definition) => definition.name)).toEqual(['read_file']);
  });

  it('does not expose tools for an empty agent allowlist', () => {
    registerTool(makeTool('read_file'));

    const defs = getToolDefinitionsForAgent(
      makeAgentProfile({ toolsEnabled: true, toolNames: [] })
    );

    expect(defs).toEqual([]);
  });

  it('keeps globally disabled tools disabled for wildcard agents', () => {
    registerTool(makeTool('read_file'));
    registerTool(makeTool('generate_image'));

    const defs = getToolDefinitionsForAgent(
      makeAgentProfile({ toolsEnabled: true, toolNames: ['*'] }),
      new Map([['generate_image', { enabled: false, parameters: {} }]])
    );

    expect(defs.map((definition) => definition.name)).toEqual(['read_file']);
  });
});

describe('executeTool', () => {
  let snapshot: RegisteredTool[];

  beforeEach(() => {
    snapshot = snapshotRegistry();
    clearRegistry();
  });

  afterEach(() => {
    restoreRegistry(snapshot);
  });

  it('executes a registered tool and returns its result', async () => {
    registerTool(
      makeTool('add', (args) => Promise.resolve((args.a as number) + (args.b as number)))
    );

    const result = await executeTool('add', { a: 3, b: 4 }, ctx);
    expect(result).toBe(7);
  });

  it('passes context to the executor', async () => {
    let capturedUserId = '';
    let capturedChatId = '';
    let capturedParameters: Record<string, unknown> = {};
    registerTool(
      makeTool('capture_ctx', (_args, c) => {
        capturedUserId = c.userId;
        capturedChatId = c.chatId;
        capturedParameters = c.parameters;
        return Promise.resolve(null);
      })
    );

    await executeTool(
      'capture_ctx',
      {},
      { ...ctx, parameters: { locale: 'pt-BR' } },
      { enabled: true, parameters: {} }
    );
    expect(capturedUserId).toBe(ctx.userId);
    expect(capturedChatId).toBe(ctx.chatId);
    expect(capturedParameters).toEqual({ locale: 'pt-BR' });
  });

  it('does not execute disabled tools', async () => {
    registerTool(makeTool('off_tool'));

    let threw = false;
    try {
      await executeTool('off_tool', {}, ctx, { enabled: false, parameters: {} });
    } catch (err) {
      threw = true;
      expect((err as Error).message).toContain('disabled');
    }
    expect(threw).toBe(true);
  });

  it('throws for an unknown tool', async () => {
    let threw = false;
    try {
      await executeTool('unknown', {}, ctx);
    } catch (err) {
      threw = true;
      expect((err as Error).message).toContain('Unknown tool');
    }
    expect(threw).toBe(true);
  });
});

describe('clearRegistry', () => {
  let snapshot: RegisteredTool[];

  beforeEach(() => {
    snapshot = snapshotRegistry();
  });

  afterEach(() => {
    restoreRegistry(snapshot);
  });
  it('removes all registrations', () => {
    registerTool(makeTool('z'));
    clearRegistry();
    expect(getAllTools()).toHaveLength(0);
  });
});
