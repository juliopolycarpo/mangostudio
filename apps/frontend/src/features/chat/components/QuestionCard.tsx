import type { MessagePart } from '@mangostudio/shared';
import { formatQuestionAnswers, type QuestionAnswer } from '@mangostudio/shared/questions';
import { Check, CircleHelp } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '@/hooks/use-i18n';

type QuestionPart = Extract<MessagePart, { type: 'question' }>;

interface QuestionAnswerDraft {
  readonly selectedLabels: ReadonlyArray<string>;
  readonly freeText: string;
}

interface QuestionCardProps {
  part: QuestionPart;
  /** Present only while the card is answerable (last message, no generation). */
  onSubmit?: (prompt: string) => void;
}

const OPTION_LETTERS = ['a', 'b', 'c', 'd'];

/**
 * Interactive card for an ask_user_question tool call: option buttons plus a
 * free-text "own answer" per question, submitted as one user message. Renders
 * inert (read-only) when no submit callback is provided.
 *
 * Usage: <QuestionCard part={part} onSubmit={onQuestionSubmit} />
 */
export function QuestionCard({ part, onSubmit }: QuestionCardProps) {
  const { t } = useI18n();
  const labels = t.chat.question;
  const [drafts, setDrafts] = useState<ReadonlyArray<QuestionAnswerDraft>>(() =>
    part.questions.map(() => ({ selectedLabels: [], freeText: '' }))
  );
  const interactive = Boolean(onSubmit);

  const updateDraft = (index: number, patch: Partial<QuestionAnswerDraft>) => {
    setDrafts((current) =>
      current.map((draft, draftIndex) => (draftIndex === index ? { ...draft, ...patch } : draft))
    );
  };

  const toggleOption = (questionIndex: number, label: string, allowMultiple: boolean) => {
    const draft = drafts[questionIndex];
    if (!draft) return;
    const isSelected = draft.selectedLabels.includes(label);
    const selectedLabels = allowMultiple
      ? isSelected
        ? draft.selectedLabels.filter((selected) => selected !== label)
        : [...draft.selectedLabels, label]
      : isSelected
        ? []
        : [label];
    updateDraft(questionIndex, { selectedLabels });
  };

  const allAnswered = drafts.every(
    (draft) => draft.selectedLabels.length > 0 || draft.freeText.trim().length > 0
  );

  const handleSubmit = () => {
    if (!onSubmit || !allAnswered) return;
    const answers: QuestionAnswer[] = part.questions.map((question, index) => {
      const draft = drafts[index];
      const freeText = draft?.freeText.trim();
      return {
        question: question.question,
        ...(question.header ? { header: question.header } : {}),
        selectedLabels: [...(draft?.selectedLabels ?? [])],
        ...(freeText ? { freeText } : {}),
      };
    });
    onSubmit(formatQuestionAnswers(answers, { intro: labels.answersIntro }));
  };

  return (
    <div className="max-w-2xl w-full rounded-2xl border border-outline-variant/15 bg-surface-container-low p-4 sm:p-5 text-sm text-on-surface space-y-4">
      <div className="flex items-center gap-2 text-on-surface-variant">
        <CircleHelp size={16} className="text-primary" />
        <span className="text-xs font-bold uppercase tracking-widest">
          {interactive ? labels.title : labels.answered}
        </span>
      </div>

      {part.questions.map((question, questionIndex) => {
        const draft = drafts[questionIndex];
        return (
          <div
            // Questions are position-stable within a card, so the index is a
            // valid identity and avoids collisions on duplicate question text.
            // biome-ignore lint/suspicious/noArrayIndexKey: no per-question id exists
            key={`${part.toolCallId}-q-${questionIndex}`}
            className="space-y-2"
          >
            <div className="flex flex-wrap items-center gap-2">
              {question.header && (
                <span className="rounded-full bg-surface-container-high px-2 py-0.5 text-xs text-on-surface-variant">
                  {question.header}
                </span>
              )}
              <p className="font-medium text-on-surface">{question.question}</p>
            </div>
            {question.allowMultiple && (
              <p className="text-xs text-on-surface-variant/70">{labels.multiSelectHint}</p>
            )}
            <div className="space-y-1.5">
              {question.options.map((option, optionIndex) => {
                const selected = draft?.selectedLabels.includes(option.label) ?? false;
                return (
                  <button
                    key={option.label}
                    type="button"
                    disabled={!interactive}
                    onClick={() =>
                      toggleOption(questionIndex, option.label, question.allowMultiple ?? false)
                    }
                    className={`flex w-full items-start gap-2.5 rounded-xl border px-3 py-2 text-left transition-colors duration-150 ${
                      selected
                        ? 'border-primary/50 bg-primary/10'
                        : 'border-outline-variant/15 bg-surface-container-high'
                    } ${interactive ? 'cursor-pointer hover:border-outline-variant/40' : 'cursor-default opacity-70'}`}
                  >
                    <span
                      className={`mt-0.5 text-xs font-semibold ${selected ? 'text-primary' : 'text-on-surface-variant/70'}`}
                    >
                      {selected ? <Check size={14} /> : `${OPTION_LETTERS[optionIndex] ?? ''})`}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium text-on-surface">{option.label}</span>
                      {option.description && (
                        <span className="block text-xs text-on-surface-variant/80">
                          {option.description}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
            {interactive && (
              <textarea
                value={draft?.freeText ?? ''}
                onChange={(event) => updateDraft(questionIndex, { freeText: event.target.value })}
                placeholder={labels.ownAnswerPlaceholder}
                rows={1}
                className="w-full resize-y rounded-xl border border-outline-variant/15 bg-surface-container-high px-3 py-2 text-sm text-on-surface placeholder:text-on-surface-variant/50 focus:border-primary/50 focus:outline-none"
              />
            )}
          </div>
        );
      })}

      {interactive && (
        <div className="flex justify-end">
          <button
            type="button"
            disabled={!allAnswered}
            onClick={handleSubmit}
            className="rounded-xl bg-primary px-4 py-2 text-sm font-medium text-on-primary transition-opacity duration-150 disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
          >
            {labels.submit}
          </button>
        </div>
      )}
    </div>
  );
}
