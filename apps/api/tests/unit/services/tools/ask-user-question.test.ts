import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { MessagePart } from '@mangostudio/shared';
import { executeStandardToolCallsWithProgress } from '../../../../src/modules/generation/application/standard-tool-execution';
import { collectToolExecutionResult } from '../../../../src/modules/generation/application/stream-text-turn-helpers';
import type { StreamEvent } from '../../../../src/modules/generation/application/stream-text-turn-types';
import { isStrictCompatible } from '../../../../src/services/providers/core/tool-mapper';
import { executeTool, getTool } from '../../../../src/services/tools';
import { ToolArgumentError } from '../../../../src/services/tools/arg-parsing';
import {
  ASK_USER_QUESTION_TOOL_NAME,
  parseAskUserQuestionArgs,
  register,
} from '../../../../src/services/tools/builtin/ask-user-question';
import { clearRegistry, getAllTools, registerTool } from '../../../../src/services/tools/registry';
import type { RegisteredTool, ToolContext } from '../../../../src/services/tools/types';

const context: ToolContext = { userId: 'user-question-test', chatId: 'chat-1', parameters: {} };

const VALID_ARGS = {
  questions: [
    {
      question: 'Which deploy target should I use?',
      header: 'Deploy target',
      options: [{ label: 'Staging', description: 'Safe default' }, { label: 'Production' }],
    },
  ],
};

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

let snapshot: RegisteredTool[];

beforeEach(() => {
  snapshot = snapshotRegistry();
  clearRegistry();
  register();
});

afterEach(() => {
  restoreRegistry(snapshot);
});

describe('ask_user_question tool', () => {
  it('registers with the expected definition and settings', () => {
    const tool = getTool(ASK_USER_QUESTION_TOOL_NAME);
    expect(tool).toBeDefined();
    expect(tool?.definition.parameters.required).toEqual(['questions']);
    expect(isStrictCompatible(tool?.definition.parameters)).toBe(true);
    expect(tool?.settings.category).toBe('interaction');
    expect(tool?.settings.enabledByDefault).toBe(true);
    expect(tool?.settings.canDisable).toBe(true);
  });

  it('reads an explicit null for every nested optional as absent', () => {
    // The nested optionals are advertised as ["string", "null"] so the schema
    // stays strict-compatible; QuestionSpec keeps its plain optional keys.
    const parsed = parseAskUserQuestionArgs({
      questions: [
        {
          question: 'Which deploy target should I use?',
          header: null,
          allowMultiple: null,
          options: [
            { label: 'Staging', description: null },
            { label: 'Production', description: 'Live traffic' },
          ],
        },
      ],
    });

    expect(parsed.questions[0]).toEqual({
      question: 'Which deploy target should I use?',
      options: [{ label: 'Staging' }, { label: 'Production', description: 'Live traffic' }],
    });
  });

  it('returns a presented status with the question count', async () => {
    const result = (await executeTool(ASK_USER_QUESTION_TOOL_NAME, VALID_ARGS, context)) as {
      status: string;
      questionCount: number;
      note: string;
    };
    expect(result.status).toBe('presented');
    expect(result.questionCount).toBe(1);
    expect(result.note).toContain('End your turn now');
  });

  it.each([
    ['no questions', { questions: [] }],
    ['too many questions', { questions: Array.from({ length: 5 }, () => VALID_ARGS.questions[0]) }],
    ['a single option', { questions: [{ question: 'Pick?', options: [{ label: 'Only' }] }] }],
    [
      'too many options',
      {
        questions: [
          { question: 'Pick?', options: Array.from({ length: 5 }, (_, i) => ({ label: `${i}` })) },
        ],
      },
    ],
    [
      'a missing option label',
      { questions: [{ question: 'Pick?', options: [{ label: '' }, { label: 'B' }] }] },
    ],
    ['missing questions entirely', {}],
  ])('rejects %s with a descriptive error', async (_name, args) => {
    const error = await executeTool(ASK_USER_QUESTION_TOOL_NAME, args, context).catch(
      (thrown: unknown) => thrown
    );
    expect(error).toBeInstanceOf(ToolArgumentError);
    expect((error as Error).message).toMatch(/Invalid ask_user_question arguments/);
  });

  it('points the model at the field that failed', async () => {
    // The detail is rendered from the first schema error as
    // `${path || '/'}: ${message}`, and the model is expected to self-correct
    // from it — a rejection that stops naming the offending field turns a
    // one-retry fix into a guess. Asserted as the rendered message rather than
    // through the iterator object the renderer reads.
    await expect(
      executeTool(
        ASK_USER_QUESTION_TOOL_NAME,
        { questions: [{ question: 'Pick?', options: [{ label: '' }, { label: 'B' }] }] },
        context
      )
    ).rejects.toThrow(/\(\/questions\/0\/options\/0\/label: .+\)/);

    await expect(executeTool(ASK_USER_QUESTION_TOOL_NAME, {}, context)).rejects.toThrow(
      /\(\/questions: .+\)/
    );
  });
});

describe('ask_user_question execution pipeline', () => {
  async function runPipeline(argsStr: string) {
    const items = [];
    for await (const item of executeStandardToolCallsWithProgress(
      [['call-q1', { name: ASK_USER_QUESTION_TOOL_NAME, argsStr }]],
      {
        userId: 'user-question-test',
        chatId: 'chat-1',
        environmentId: 'local',
        settingsByToolName: new Map(),
        allowedToolNames: new Set([ASK_USER_QUESTION_TOOL_NAME]),
      }
    )) {
      items.push(item);
    }
    return items;
  }

  it('attaches the question part to a successful execution', async () => {
    const items = await runPipeline(JSON.stringify(VALID_ARGS));
    const execution = items.find((item) => item.kind === 'execution');
    expect(execution?.kind).toBe('execution');
    if (execution?.kind !== 'execution') return;

    expect(execution.execution.isError).toBe(false);
    expect(execution.execution.questionPart).toEqual({
      type: 'question',
      toolCallId: 'call-q1',
      questions: VALID_ARGS.questions,
    });
  });

  it('omits the question part on a failed execution', async () => {
    const items = await runPipeline(JSON.stringify({ questions: [] }));
    const execution = items.find((item) => item.kind === 'execution');
    expect(execution?.kind).toBe('execution');
    if (execution?.kind !== 'execution') return;

    expect(execution.execution.isError).toBe(true);
    expect(execution.execution.questionPart).toBeUndefined();
  });

  it('persists the question part and streams the question event', async () => {
    const items = await runPipeline(JSON.stringify(VALID_ARGS));
    const executionItem = items.find((item) => item.kind === 'execution');
    expect(executionItem?.kind).toBe('execution');
    if (executionItem?.kind !== 'execution') return;

    const sink = {
      allParts: [] as MessagePart[],
      nextToolResults: [] as Array<{
        callId: string;
        name: string;
        result: string;
        isError: boolean;
      }>,
      includeSubagentTrace: true,
    };
    const events: StreamEvent[] = [...collectToolExecutionResult(executionItem, sink)];

    expect(sink.allParts).toContainEqual({
      type: 'question',
      toolCallId: 'call-q1',
      questions: VALID_ARGS.questions,
    });
    expect(events).toContainEqual({
      type: 'question',
      part: { type: 'question', toolCallId: 'call-q1', questions: VALID_ARGS.questions },
    });
    expect(sink.nextToolResults).toHaveLength(1);
    expect(sink.nextToolResults[0]?.isError).toBe(false);
  });
});
