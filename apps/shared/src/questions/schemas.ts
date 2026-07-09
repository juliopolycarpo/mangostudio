import { type Static, Type } from '@sinclair/typebox';

export const ASK_USER_QUESTION_TOOL_NAME = 'ask_user_question';

/** Bounds enforced on `ask_user_question` tool calls. */
export const ASK_USER_QUESTION_MAX_QUESTIONS = 4;
export const QUESTION_MIN_OPTIONS = 2;
export const QUESTION_MAX_OPTIONS = 4;
export const QUESTION_TEXT_MAX_LENGTH = 1000;
export const QUESTION_HEADER_MAX_LENGTH = 24;
export const QUESTION_OPTION_LABEL_MAX_LENGTH = 100;
export const QUESTION_OPTION_DESCRIPTION_MAX_LENGTH = 500;

export const QuestionOptionSchema = Type.Object({
  label: Type.String({ minLength: 1, maxLength: QUESTION_OPTION_LABEL_MAX_LENGTH }),
  description: Type.Optional(Type.String({ maxLength: QUESTION_OPTION_DESCRIPTION_MAX_LENGTH })),
});

export const QuestionSpecSchema = Type.Object({
  question: Type.String({ minLength: 1, maxLength: QUESTION_TEXT_MAX_LENGTH }),
  /** Short chip shown above the question (e.g. "Auth method"). */
  header: Type.Optional(Type.String({ maxLength: QUESTION_HEADER_MAX_LENGTH })),
  options: Type.Array(QuestionOptionSchema, {
    minItems: QUESTION_MIN_OPTIONS,
    maxItems: QUESTION_MAX_OPTIONS,
  }),
  /** When true the user may select more than one option. */
  allowMultiple: Type.Optional(Type.Boolean()),
});

export const AskUserQuestionArgsSchema = Type.Object({
  questions: Type.Array(QuestionSpecSchema, {
    minItems: 1,
    maxItems: ASK_USER_QUESTION_MAX_QUESTIONS,
  }),
});

export type QuestionOption = Static<typeof QuestionOptionSchema>;
export type QuestionSpec = Static<typeof QuestionSpecSchema>;
export type AskUserQuestionArgs = Static<typeof AskUserQuestionArgsSchema>;
