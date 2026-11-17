/**
 * The tool loop hands the executor a `beforeToolStart` hook that commits the
 * call's `running` state durably, in both the standard path and the path that
 * runs image generation beside other tools. Which calls wait for it is decided by
 * the executor (`tool-start-marker.test.ts`); this pins that the loop passes the
 * hook on and that its own per-item checkpoints stay non-durable, because a
 * dropped hook would silently undo the guarantee and a durable per-item write
 * would add a second fsync per call.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test';

import type { ToolExecutionSnapshot } from '@mangostudio/shared/tool-executions';

import { getDb } from '../../../../src/db/database';
import * as realStandardToolExecution from '../../../../src/modules/generation/application/standard-tool-execution';
import type { StandardToolExecutionContext } from '../../../../src/modules/generation/application/standard-tool-execution';
import * as realTurnHelpers from '../../../../src/modules/generation/application/stream-text-turn-helpers';
import type { StreamTextTurnSession } from '../../../../src/modules/generation/application/stream-text-turn-stages';
import type { WriteTurnCheckpointOptions } from '../../../../src/modules/generation/application/turn-checkpoint';
import type { AgentEvent, AgentTurnRequest } from '../../../../src/services/providers/types';

type Call = readonly [callId: string, call: { name: string; argsStr: string }];

const at = (status: ToolExecutionSnapshot['status']): ToolExecutionSnapshot => ({
  status,
  source: 'builtin',
  queuedAt: 1,
});

/**
 * Named fake for the tool executor: announces each call as queued and running,
 * waits on the start marker hook the way the real executor does for a call that
 * is not a plain read, then finishes it.
 */
async function* ScriptedToolProgress(
  calls: readonly Call[],
  context: Pick<StandardToolExecutionContext, 'beforeToolStart'>
) {
  await Promise.resolve();
  for (const [callId, { name }] of calls) {
    yield {
      kind: 'event',
      event: { type: 'tool_execution', callId, name, execution: at('queued') },
    };
    yield {
      kind: 'event',
      event: { type: 'tool_execution', callId, name, execution: at('running') },
    };
    await context.beforeToolStart?.({ callId, name, execution: at('running') });
    yield {
      kind: 'execution',
      execution: {
        callId,
        name,
        args: {},
        result: 'ok',
        resultStr: 'ok',
        isError: false,
        execution: at('succeeded'),
      },
    };
  }
}

/** Records every checkpoint the loop asks for, with the calls that were running at that moment. */
class RecordingCheckpointWriter {
  readonly requests: Array<{ force: boolean; durable: boolean; running: string[] }> = [];

  constructor(private readonly session: () => StreamTextTurnSession) {}

  checkpoint(options: WriteTurnCheckpointOptions = {}): Promise<boolean> {
    const running = this.session()
      .allParts.filter((part) => part.type === 'tool_call' && part.execution?.status === 'running')
      .map((part) => (part.type === 'tool_call' ? part.name : ''));
    this.requests.push({
      force: options.force === true,
      durable: options.durable === true,
      running,
    });
    return Promise.resolve(true);
  }
}

async function runTurn(toolNames: string[]): Promise<RecordingCheckpointWriter['requests']> {
  await mock.module(
    '../../../../src/modules/generation/application/standard-tool-execution',
    () => ({
      ...realStandardToolExecution,
      executeStandardToolCallsWithProgress: (
        calls: readonly Call[],
        context: Pick<StandardToolExecutionContext, 'beforeToolStart'>
      ) => ScriptedToolProgress(calls, context),
    })
  );
  // The image call is not what this file is about; its own durable checkpoints
  // are covered in `image-generation-call.test.ts`.
  await mock.module(
    '../../../../src/modules/generation/application/stream-text-turn-helpers',
    () => ({
      ...realTurnHelpers,
      executeImageGenerationCall: async function* NoImageCall() {
        await Promise.resolve();
        yield* [];
      },
    })
  );
  const { runAgentToolLoop } =
    await import('../../../../src/modules/generation/application/stream-text-turn-stages');

  const session = {
    chatId: 'chat-tool-start',
    userId: 'user-tool-start',
    userMsgId: 'user-msg',
    aiMsgId: 'ai-msg',
    effectivePrompt: 'Hi',
    effectiveSystemPrompt: 'You are helpful',
    continuationSystemPrompt: 'You are helpful',
    toolDefs: [],
    runtimeAttachments: [],
    thinkingEnabled: false,
    reasoningEffort: 'medium',
    multiAgentSettings: { traceVisibility: 'off' },
    allowedToolNames: new Set(toolNames),
    agentRuntime: {
      profile: { id: 'default' },
      runtimeHash: 'hash-1',
      runtimeSettings: { maxToolIterations: 3 },
      toolSettingsByName: new Map(),
    },
    resolvedModel: {
      modelId: 'test-model',
      capabilities: { text: true, image: false, streaming: true, tools: true },
    },
    provider: {
      providerType: 'cursor',
      // The first model turn asks for every tool; the second, after their results, finishes.
      generateAgentTurnStream: function* (req: AgentTurnRequest): Generator<AgentEvent> {
        if (req.toolResults === undefined) {
          for (const name of toolNames) {
            yield { type: 'tool_call_completed', callId: `call-${name}`, name, arguments: '{}' };
          }
        }
        yield { type: 'turn_completed' };
      },
      listModels: () => Promise.resolve([]),
      validateApiKey: () => Promise.resolve(),
      resolveApiKey: () => Promise.resolve('key'),
    },
    input: { chatId: 'chat-tool-start', userId: 'user-tool-start', prompt: 'Hi' },
    db: getDb(),
    executionState: { durableProviderState: null, turnLocalState: null },
    allParts: [],
    fullText: '',
  } as unknown as StreamTextTurnSession;
  const writer = new RecordingCheckpointWriter(() => session);
  session.checkpointWriter = writer as unknown as StreamTextTurnSession['checkpointWriter'];

  for await (const _event of runAgentToolLoop(session)) {
    // consume the whole loop
  }
  return writer.requests;
}

afterEach(() => {
  mock.restore();
});

describe('runAgentToolLoop tool start marker', () => {
  it('commits the running call durably through the hook, and nothing else durably', async () => {
    const requests = await runTurn(['run_shell']);

    const durable = requests.filter((request) => request.durable);
    expect(durable).toEqual([{ force: true, durable: true, running: ['run_shell'] }]);
  });

  it('gives the tools that run beside an image generation the same hook', async () => {
    const requests = await runTurn(['run_shell', 'write_file', 'generate_image']);

    expect(requests.filter((request) => request.durable).map((request) => request.running)).toEqual(
      [['run_shell'], ['write_file']]
    );
  });
});
