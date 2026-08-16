import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { SUBAGENT_MAX_TURNS_MAX, SUBAGENT_MAX_TURNS_MIN } from '@mangostudio/shared/app-settings';
import { register } from '../../../../src/services/tools/builtin/delegate-to-agent';
import {
  clearRegistry,
  executeTool,
  getAllTools,
  getTool,
  registerTool,
} from '../../../../src/services/tools/registry';
import type {
  DelegateToAgentInput,
  RegisteredTool,
  ToolContext,
} from '../../../../src/services/tools/types';

function snapshotRegistry(): RegisteredTool[] {
  return getAllTools().map((tool) => ({
    definition: { ...tool.definition },
    settings: { ...tool.settings, parameterDescriptors: [...tool.settings.parameterDescriptors] },
    execute: tool.execute,
    buildDefinition: tool.buildDefinition,
  }));
}

function restoreRegistry(snapshot: RegisteredTool[]): void {
  clearRegistry();
  for (const tool of snapshot) {
    registerTool(tool);
  }
}

describe('delegate_to_agent', () => {
  let snapshot: RegisteredTool[];

  beforeEach(() => {
    snapshot = snapshotRegistry();
    clearRegistry();
    register();
  });

  afterEach(() => {
    restoreRegistry(snapshot);
  });

  it('registers with expected settings', () => {
    const tool = getTool('delegate_to_agent');
    expect(tool).toBeDefined();
    expect(tool?.definition.name).toBe('delegate_to_agent');
    expect(tool?.settings.enabledByDefault).toBe(true);
    expect(tool?.settings.canDisable).toBe(true);
    expect(tool?.settings.category).toBe('system');
  });

  it('executes delegation with only required args', async () => {
    const captured: DelegateToAgentInput[] = [];
    const ctx: ToolContext = {
      userId: 'u1',
      chatId: 'c1',
      parameters: {},
      delegateToAgent: (input) => {
        captured.push(input);
        return Promise.resolve('delegated result');
      },
    };

    const result = await executeTool(
      'delegate_to_agent',
      {
        agentId: 'explore',
        task: 'Find files',
      },
      ctx
    );

    expect(result).toBe('delegated result');
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      agentId: 'explore',
      task: 'Find files',
    });
  });

  it('passes optional fields through execute', async () => {
    const captured: DelegateToAgentInput[] = [];
    const ctx: ToolContext = {
      userId: 'u1',
      chatId: 'c1',
      parameters: {},
      delegateToAgent: (input) => {
        captured.push(input);
        return Promise.resolve('ok');
      },
    };

    await executeTool(
      'delegate_to_agent',
      {
        agentId: 'explore',
        task: 'Summarize',
        context: 'Previous work context',
        expectedOutput: 'Markdown summary',
        maxTurns: 3,
      },
      ctx
    );

    expect(captured[0]).toMatchObject({
      agentId: 'explore',
      task: 'Summarize',
      context: 'Previous work context',
      expectedOutput: 'Markdown summary',
      maxTurns: 3,
    });
  });

  it('clamps maxTurns to bounds', async () => {
    const captured: DelegateToAgentInput[] = [];
    const ctx: ToolContext = {
      userId: 'u1',
      chatId: 'c1',
      parameters: {},
      delegateToAgent: (input) => {
        captured.push(input);
        return Promise.resolve('ok');
      },
    };

    await executeTool(
      'delegate_to_agent',
      {
        agentId: 'explore',
        task: 'Do work',
        maxTurns: SUBAGENT_MAX_TURNS_MAX + 100,
      },
      ctx
    );
    expect(captured[0].maxTurns).toBe(SUBAGENT_MAX_TURNS_MAX);

    await executeTool(
      'delegate_to_agent',
      {
        agentId: 'explore',
        task: 'Do work',
        maxTurns: SUBAGENT_MAX_TURNS_MIN - 1,
      },
      ctx
    );
    expect(captured[1].maxTurns).toBe(SUBAGENT_MAX_TURNS_MIN);
  });

  it('reads an explicit null for every optional argument as absent', async () => {
    const captured: DelegateToAgentInput[] = [];
    const ctx: ToolContext = {
      userId: 'u1',
      chatId: 'c1',
      parameters: {},
      delegateToAgent: (input) => {
        captured.push(input);
        return Promise.resolve('ok');
      },
    };

    await executeTool(
      'delegate_to_agent',
      {
        agentId: 'explore',
        task: 'Do work',
        context: null,
        expectedOutput: null,
        maxTurns: null,
      },
      ctx
    );

    expect(captured[0]).toEqual({ agentId: 'explore', task: 'Do work' });
  });

  it('rejects a malformed optional argument instead of dropping it', async () => {
    const ctx: ToolContext = {
      userId: 'u1',
      chatId: 'c1',
      parameters: {},
      delegateToAgent: () => Promise.resolve('ok'),
    };

    await expect(
      executeTool('delegate_to_agent', { agentId: 'explore', task: 'Do work', context: 42 }, ctx)
    ).rejects.toThrow('Field "context" must be a string.');

    await expect(
      executeTool('delegate_to_agent', { agentId: 'explore', task: 'Do work', maxTurns: 2.5 }, ctx)
    ).rejects.toThrow('Field "maxTurns" must be an integer.');
  });

  it('throws when delegateToAgent is not available', async () => {
    const ctx: ToolContext = {
      userId: 'u1',
      chatId: 'c1',
      parameters: {},
    };

    let threw = false;
    try {
      await executeTool('delegate_to_agent', { agentId: 'explore', task: 'Test' }, ctx);
    } catch (err) {
      threw = true;
      expect((err as Error).message).toBe('Delegation is not available in this runtime.');
    }
    expect(threw).toBe(true);
  });

  it('throws when agentId is empty', async () => {
    const ctx: ToolContext = {
      userId: 'u1',
      chatId: 'c1',
      parameters: {},
      delegateToAgent: () => Promise.resolve('ok'),
    };

    let threw = false;
    try {
      await executeTool('delegate_to_agent', { agentId: '   ', task: 'Test' }, ctx);
    } catch (err) {
      threw = true;
      expect((err as Error).message).toBe('Missing required field "agentId".');
    }
    expect(threw).toBe(true);
  });

  it('throws when task is empty', async () => {
    const ctx: ToolContext = {
      userId: 'u1',
      chatId: 'c1',
      parameters: {},
      delegateToAgent: () => Promise.resolve('ok'),
    };

    let threw = false;
    try {
      await executeTool('delegate_to_agent', { agentId: 'explore', task: '' }, ctx);
    } catch (err) {
      threw = true;
      expect((err as Error).message).toBe('Missing required field "task".');
    }
    expect(threw).toBe(true);
  });
});
