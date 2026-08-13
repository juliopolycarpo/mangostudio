import { describe, expect, it } from 'bun:test';
import {
  ASK_USER_QUESTION_MAX_QUESTIONS,
  AskUserQuestionArgsSchema,
  formatQuestionAnswers,
} from '@mangostudio/shared/questions';
import Value from 'typebox/value';

const INTRO = 'My answers to your questions:';

function validQuestion(overrides: Record<string, unknown> = {}) {
  return {
    question: 'Which deploy target?',
    options: [{ label: 'Staging' }, { label: 'Production' }],
    ...overrides,
  };
}

describe('AskUserQuestionArgsSchema', () => {
  it('accepts 1 to 4 questions with 2 to 4 options each', () => {
    expect(Value.Check(AskUserQuestionArgsSchema, { questions: [validQuestion()] })).toBe(true);
    expect(
      Value.Check(AskUserQuestionArgsSchema, {
        questions: Array.from({ length: ASK_USER_QUESTION_MAX_QUESTIONS }, () => validQuestion()),
      })
    ).toBe(true);
  });

  it('rejects empty and oversized question lists', () => {
    expect(Value.Check(AskUserQuestionArgsSchema, { questions: [] })).toBe(false);
    expect(
      Value.Check(AskUserQuestionArgsSchema, {
        questions: Array.from({ length: ASK_USER_QUESTION_MAX_QUESTIONS + 1 }, () =>
          validQuestion()
        ),
      })
    ).toBe(false);
  });

  it('rejects option lists outside 2-4 and missing labels', () => {
    expect(
      Value.Check(AskUserQuestionArgsSchema, {
        questions: [validQuestion({ options: [{ label: 'Only one' }] })],
      })
    ).toBe(false);
    expect(
      Value.Check(AskUserQuestionArgsSchema, {
        questions: [
          validQuestion({
            options: Array.from({ length: 5 }, (_, i) => ({ label: `Option ${i}` })),
          }),
        ],
      })
    ).toBe(false);
    expect(
      Value.Check(AskUserQuestionArgsSchema, {
        questions: [validQuestion({ options: [{ label: '' }, { label: 'Ok' }] })],
      })
    ).toBe(false);
  });
});

describe('formatQuestionAnswers', () => {
  it('formats a single-select answer using the header as the topic', () => {
    const body = formatQuestionAnswers(
      [
        {
          question: 'Which deploy target should I use?',
          header: 'Deploy target',
          selectedLabels: ['Staging'],
        },
      ],
      { intro: INTRO }
    );
    expect(body).toBe(`${INTRO}\n- Deploy target: Staging`);
  });

  it('falls back to the question when no header is provided', () => {
    const body = formatQuestionAnswers(
      [{ question: 'Which deploy target?', selectedLabels: ['Production'] }],
      { intro: INTRO }
    );
    expect(body).toBe(`${INTRO}\n- Which deploy target?: Production`);
  });

  it('joins multi-select labels and appends free text after a dash', () => {
    const body = formatQuestionAnswers(
      [
        {
          question: 'Which features?',
          header: 'Features',
          selectedLabels: ['Auth', 'Billing'],
          freeText: 'also add audit logs',
        },
      ],
      { intro: INTRO }
    );
    expect(body).toBe(`${INTRO}\n- Features: Auth, Billing — also add audit logs`);
  });

  it('supports free-text-only answers and multiple questions', () => {
    const body = formatQuestionAnswers(
      [
        { question: 'Q1?', header: 'One', selectedLabels: [], freeText: 'my own answer' },
        { question: 'Q2?', selectedLabels: ['B'] },
      ],
      { intro: INTRO }
    );
    expect(body).toBe(`${INTRO}\n- One: my own answer\n- Q2?: B`);
  });
});
