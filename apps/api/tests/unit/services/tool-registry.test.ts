import { describe, expect, it, beforeEach } from 'bun:test';
import {
  registerTool,
  getTool,
  getAllTools,
  getAllToolDefinitions,
  getToolDefinitionsForSettings,
  getToolDescriptors,
  executeTool,
  clearRegistry,
} from '../../../src/services/tools/registry';
import type { ToolContext, ToolExecutor } from '../../../src/services/tools/types';

const ctx: ToolContext = { userId: 'u1', chatId: 'c1', parameters: {} };

function makeTool(name: string, execute: ToolExecutor = () => Promise.resolve(null)) {
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

beforeEach(() => {
  clearRegistry();
});

describe('registerTool / getTool', () => {
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
});

describe('executeTool', () => {
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
  it('removes all registrations', () => {
    registerTool(makeTool('z'));
    clearRegistry();
    expect(getAllTools()).toHaveLength(0);
  });
});
