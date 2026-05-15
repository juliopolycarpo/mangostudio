/**
 * Built-in tool: delegate_to_agent
 * Delegates bounded work to an allowed subagent during the current turn.
 */

import { SUBAGENT_MAX_TURNS_MAX, SUBAGENT_MAX_TURNS_MIN } from '@mangostudio/shared/app-settings';

import { registerTool } from '../registry';
import type { DelegateToAgentInput, ToolContext } from '../types';

export const DELEGATE_TO_AGENT_TOOL_NAME = 'delegate_to_agent';

const definition = {
  name: DELEGATE_TO_AGENT_TOOL_NAME,
  description:
    'Delegates bounded exploration or execution work to an allowed subagent and returns a concise result for this turn.',
  parameters: {
    type: 'object',
    properties: {
      agentId: {
        type: 'string',
        description: 'Target subagent id, such as "explore" or "user:researcher".',
      },
      task: {
        type: 'string',
        description: 'Specific, bounded task for the subagent to perform.',
      },
      context: {
        type: 'string',
        description: 'Optional context that helps the subagent avoid rediscovery.',
      },
      expectedOutput: {
        type: 'string',
        description: 'Optional format or acceptance criteria for the result.',
      },
      maxTurns: {
        type: 'number',
        minimum: SUBAGENT_MAX_TURNS_MIN,
        maximum: SUBAGENT_MAX_TURNS_MAX,
        description: 'Optional maximum subagent model/tool turns for this delegation.',
      },
    },
    required: ['agentId', 'task'],
    additionalProperties: false,
  },
};

async function execute(args: Record<string, unknown>, context: ToolContext): Promise<unknown> {
  if (!context.delegateToAgent) {
    throw new Error('Delegation is not available in this runtime.');
  }

  return context.delegateToAgent(parseDelegateArgs(args));
}

export function register(): void {
  registerTool({
    definition,
    settings: {
      title: 'Delegate to agent',
      description: 'Allows primary agents to delegate bounded work to configured subagents.',
      category: 'system',
      enabledByDefault: true,
      canDisable: true,
      defaultParameters: {},
      parameterDescriptors: [],
    },
    execute,
  });
}

function parseDelegateArgs(args: Record<string, unknown>): DelegateToAgentInput {
  const agentId = getRequiredString(args.agentId, 'agentId');
  const task = getRequiredString(args.task, 'task');
  const context = getOptionalString(args.context);
  const expectedOutput = getOptionalString(args.expectedOutput);
  const maxTurns = getOptionalInteger(args.maxTurns);

  return {
    agentId,
    task,
    ...(context ? { context } : {}),
    ...(expectedOutput ? { expectedOutput } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
  };
}

function getRequiredString(value: unknown, name: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new Error(`Missing required delegation field "${name}".`);
  return text;
}

function getOptionalString(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || undefined;
}

function getOptionalInteger(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('Delegation field "maxTurns" must be a finite number.');
  }
  return Math.max(SUBAGENT_MAX_TURNS_MIN, Math.min(SUBAGENT_MAX_TURNS_MAX, Math.round(value)));
}

register();
