/**
 * Built-in tool: ask_user_question
 * Presents 1–4 structured questions to the user as an interactive card in the
 * chat. The tool itself only validates the payload — the execution pipeline
 * emits the `question` message part and SSE event, and the user's selection
 * arrives as the next user message through the normal respond/stream path.
 */

import {
  ASK_USER_QUESTION_MAX_QUESTIONS,
  ASK_USER_QUESTION_TOOL_NAME,
  type AskUserQuestionArgs,
  AskUserQuestionArgsSchema,
  QUESTION_MAX_OPTIONS,
  QUESTION_MIN_OPTIONS,
} from '@mangostudio/shared/questions';
import { Value } from '@sinclair/typebox/value';
import { registerTool } from '../registry';

export { ASK_USER_QUESTION_TOOL_NAME };

interface AskUserQuestionResult {
  status: 'presented';
  questionCount: number;
  note: string;
}

const definition = {
  name: ASK_USER_QUESTION_TOOL_NAME,
  description:
    'Presents structured multiple-choice questions to the user and ends your turn. ' +
    'Use this only when the task is blocked on a genuine decision you cannot resolve yourself. ' +
    `Batch every open question into ONE call (up to ${ASK_USER_QUESTION_MAX_QUESTIONS} questions); never issue parallel calls to this tool. ` +
    'A free-text "own answer" field is always shown, so do not add catch-all options like "Other". ' +
    'CRITICAL: after calling this tool, produce no further tool calls or text — end your turn immediately. ' +
    'The answers arrive as the next user message.',
  parameters: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        minItems: 1,
        maxItems: ASK_USER_QUESTION_MAX_QUESTIONS,
        description: 'The questions to present to the user, all in a single call.',
        items: {
          type: 'object',
          properties: {
            question: {
              type: 'string',
              description: 'The complete question to ask. Clear, specific, ends with "?".',
            },
            header: {
              type: 'string',
              description: 'Very short topic label displayed as a chip (max 24 chars).',
            },
            options: {
              type: 'array',
              minItems: QUESTION_MIN_OPTIONS,
              maxItems: QUESTION_MAX_OPTIONS,
              description: 'The selectable choices (2-4). Distinct and mutually exclusive.',
              items: {
                type: 'object',
                properties: {
                  label: {
                    type: 'string',
                    description: 'Concise display text for this choice (1-5 words).',
                  },
                  description: {
                    type: 'string',
                    description: 'What this option means or its trade-offs.',
                  },
                },
                required: ['label'],
                additionalProperties: false,
              },
            },
            allowMultiple: {
              type: 'boolean',
              description: 'Set true to let the user select more than one option.',
            },
          },
          required: ['question', 'options'],
          additionalProperties: false,
        },
      },
    },
    required: ['questions'],
    additionalProperties: false,
  },
};

// biome-ignore lint/suspicious/useAwait: tool executors are async by contract
async function execute(args: Record<string, unknown>): Promise<AskUserQuestionResult> {
  const validated = parseAskUserQuestionArgs(args);
  return {
    status: 'presented',
    questionCount: validated.questions.length,
    note:
      'The questions were presented to the user. End your turn now — produce no further ' +
      'tool calls or text. The answers arrive as the next user message.',
  };
}

/**
 * Validates raw tool-call args against the shared schema, throwing a
 * descriptive error the model can self-correct from.
 *
 * // Usage: const { questions } = parseAskUserQuestionArgs(args);
 */
export function parseAskUserQuestionArgs(args: Record<string, unknown>): AskUserQuestionArgs {
  if (!Value.Check(AskUserQuestionArgsSchema, args)) {
    const firstError = Value.Errors(AskUserQuestionArgsSchema, args).First();
    const detail = firstError
      ? `${firstError.path || '/'}: ${firstError.message}`
      : 'invalid payload';
    throw new Error(
      `Invalid ask_user_question arguments (${detail}). Provide 1-${ASK_USER_QUESTION_MAX_QUESTIONS} questions, ` +
        `each with ${QUESTION_MIN_OPTIONS}-${QUESTION_MAX_OPTIONS} labeled options.`
    );
  }
  return args;
}

/** Registers this built-in tool. // Usage: register() */
export function register(): void {
  registerTool({
    definition,
    settings: {
      title: 'Ask user questions',
      description:
        'Allows the AI to ask structured multiple-choice questions mid-task through an interactive card.',
      category: 'interaction',
      enabledByDefault: true,
      canDisable: true,
      defaultParameters: {},
      parameterDescriptors: [],
    },
    execute,
  });
}
