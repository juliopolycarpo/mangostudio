import { formatQuestionAnswers, type QuestionAnswer } from '@mangostudio/shared/questions';
import type { MessagePart } from '@mangostudio/shared/types';
import { useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { SectionCard } from '@/components/ui/SectionCard';
import { Textarea } from '@/components/ui/Textarea';
import { useI18n } from '@/hooks/use-i18n';
import { ChoiceButton } from './ChoiceButton';

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
    <SectionCard
      label={interactive ? labels.title : labels.answered}
      className="w-full max-w-2xl gap-4 text-sm text-fg"
    >
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
              {question.header && <Badge variant="neutral">{question.header}</Badge>}
              <p className="font-medium text-fg">{question.question}</p>
            </div>
            {question.allowMultiple && (
              <p className="text-xs text-fg-muted">{labels.multiSelectHint}</p>
            )}
            <div className="space-y-2">
              {question.options.map((option, optionIndex) => (
                <ChoiceButton
                  key={option.label}
                  selected={draft?.selectedLabels.includes(option.label) ?? false}
                  disabled={!interactive}
                  marker={`${OPTION_LETTERS[optionIndex] ?? ''})`}
                  onClick={() =>
                    toggleOption(questionIndex, option.label, question.allowMultiple ?? false)
                  }
                >
                  <span className="block font-medium text-fg">{option.label}</span>
                  {option.description && (
                    <span className="block text-xs text-fg-muted">{option.description}</span>
                  )}
                </ChoiceButton>
              ))}
            </div>
            {interactive && (
              <Textarea
                value={draft?.freeText ?? ''}
                onChange={(event) => updateDraft(questionIndex, { freeText: event.target.value })}
                placeholder={labels.ownAnswerPlaceholder}
                rows={1}
                className="min-h-8"
              />
            )}
          </div>
        );
      })}

      {interactive && (
        <div className="flex justify-end">
          <Button type="button" disabled={!allAnswered} onClick={handleSubmit}>
            {labels.submit}
          </Button>
        </div>
      )}
    </SectionCard>
  );
}
