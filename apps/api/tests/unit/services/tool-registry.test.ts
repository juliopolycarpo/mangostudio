import { describe, expect, it, beforeEach } from 'bun:test';
import {
  registerTool,
  getTool,
  getAllTools,
  getAllToolDefinitions,
  executeTool,
  clearRegistry,
} from '../../../src/services/tools/registry';
import type { ToolContext } from '../../../src/services/tools/types';

const ctx: ToolContext = { userId: 'u1', chatId: 'c1' };

beforeEach(() => {
  clearRegistry();
});

describe('registerTool / getTool', () => {
  it('registers and retrieves a tool by name', () => {
    registerTool({
      definition: {
        name: 'my_tool',
        description: 'Does something',
        parameters: { type: 'object', properties: {} },
      },
      execute: () => Promise.resolve('result'),
    });

    const t = getTool('my_tool');
    expect(t).toBeDefined();
    expect(t!.definition.name).toBe('my_tool');
  });

  it('returns undefined for an unknown tool', () => {
    expect(getTool('nonexistent')).toBeUndefined();
  });

  it('overwrites an existing tool registration', () => {
    const exec1 = () => Promise.resolve('v1');
    const exec2 = () => Promise.resolve('v2');

    registerTool({
      definition: { name: 'dup', description: '', parameters: {} },
      execute: exec1,
    });
    registerTool({
      definition: { name: 'dup', description: '', parameters: {} },
      execute: exec2,
    });

    expect(getTool('dup')!.execute).toBe(exec2);
  });
});

describe('getAllTools / getAllToolDefinitions', () => {
  it('returns all registered tools', () => {
    registerTool({
      definition: { name: 'a', description: '', parameters: {} },
      execute: () => Promise.resolve(null),
    });
    registerTool({
      definition: { name: 'b', description: '', parameters: {} },
      execute: () => Promise.resolve(null),
    });
    expect(getAllTools()).toHaveLength(2);
  });

  it('returns only definitions via getAllToolDefinitions', () => {
    registerTool({
      definition: { name: 'x', description: 'desc', parameters: { type: 'object' } },
      execute: () => Promise.resolve(null),
    });
    const defs = getAllToolDefinitions();
    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe('x');
    expect(defs[0].description).toBe('desc');
  });
});

describe('executeTool', () => {
  it('executes a registered tool and returns its result', async () => {
    registerTool({
      definition: { name: 'add', description: '', parameters: {} },
      execute: (args) => Promise.resolve((args.a as number) + (args.b as number)),
    });

    const result = await executeTool('add', { a: 3, b: 4 }, ctx);
    expect(result).toBe(7);
  });

  it('passes context to the executor', async () => {
    let capturedUserId = '';
    let capturedChatId = '';
    registerTool({
      definition: { name: 'capture_ctx', description: '', parameters: {} },
      execute: (_args, c) => {
        capturedUserId = c.userId;
        capturedChatId = c.chatId;
        return Promise.resolve(null);
      },
    });

    await executeTool('capture_ctx', {}, ctx);
    expect(capturedUserId).toBe(ctx.userId);
    expect(capturedChatId).toBe(ctx.chatId);
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
    registerTool({
      definition: { name: 'z', description: '', parameters: {} },
      execute: () => Promise.resolve(null),
    });
    clearRegistry();
    expect(getAllTools()).toHaveLength(0);
  });
});
