/**
 * The tool loop asks its checkpoint writer for a durable commit exactly when a
 * tool that is not a plain read starts, in both the standard path and the path
 * that runs image generation beside other tools. The helper that decides is
 * covered in `tool-start-durability.test.ts`; this pins that the loop passes
 * its answer on, because a dropped flag would silently undo the guarantee.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test';

import type { ToolExecutionSnapshot } from '@mangostudio/shared/tool-executions';

import { getDb } from '../../../../src/db/database';
import * as realStandardToolExecution from '../../../../src/modules/generation/application/standard-tool-execution';
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
 * then finishes it, the way the real generator reports progress.
 */
async function* ScriptedToolProgress(calls: readonly Call[]) {
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
    return Promise.resolve(false);
  }
}

async function runTurn(toolNames: string[]): Promise<RecordingCheckpointWriter['requests']> {
  await mock.module(
    '../../../../src/modules/generation/application/standard-tool-execution',
    () => ({
      ...realStandardToolExecution,
      executeStandardToolCallsWithProgress: (calls: readonly Call[]) => ScriptedToolProgress(calls),
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

describe('runAgentToolLoop durable checkpoints', () => {
  it('commits only the running state of a mutating tool durably', async () => {
    const requests = await runTurn(['run_shell']);

    const durable = requests.filter((request) => request.durable);
    expect(durable).toEqual([{ force: true, durable: true, running: ['run_shell'] }]);
  });

  it('does not commit a read-only tool durably at any state', async () => {
    const requests = await runTurn(['read_file']);

    expect(requests.filter((request) => request.durable)).toEqual([]);
  });

  it('does the same for the tools that run beside an image generation', async () => {
    const requests = await runTurn(['run_shell', 'read_file', 'generate_image']);

    expect(requests.filter((request) => request.durable).map((request) => request.running)).toEqual(
      [['run_shell']]
    );
  });

  it('commits one durable checkpoint per mutating tool in a batch, and none for the read', async () => {
    const requests = await runTurn(['run_shell', 'read_file', 'write_file']);

    expect(requests.filter((request) => request.durable).map((request) => request.running)).toEqual(
      [['run_shell'], ['write_file']]
    );
  });
});
