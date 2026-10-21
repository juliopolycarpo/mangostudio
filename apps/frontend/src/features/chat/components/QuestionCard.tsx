import { formatQuestionAnswers, type QuestionAnswer } from '@mangostudio/shared/questions';
import type { MessagePart } from '@mangostudio/shared/types';
import { useId, useState } from 'react';
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
  const idBase = useId();
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
      className="w-full max-w-(--timeline-card-max) gap-4 text-sm text-fg"
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
              <p id={`${idBase}-q${questionIndex}`} className="font-medium text-fg">
                {question.question}
              </p>
            </div>
            {question.allowMultiple && (
              <p id={`${idBase}-q${questionIndex}-hint`} className="text-xs text-fg-muted">
                {labels.multiSelectHint}
              </p>
            )}
            {/* The options are one answer to the question above them, so they are
                a group named by it (and described by the "select one or more"
                line when that applies): a single-select and a multi-select no
                longer sound the same. */}
            <fieldset
              aria-labelledby={`${idBase}-q${questionIndex}`}
              aria-describedby={
                question.allowMultiple ? `${idBase}-q${questionIndex}-hint` : undefined
              }
              className="min-w-0 space-y-2"
            >
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
            </fieldset>
            {interactive && (
              <Textarea
                value={draft?.freeText ?? ''}
                onChange={(event) => updateDraft(questionIndex, { freeText: event.target.value })}
                placeholder={labels.ownAnswerPlaceholder}
                rows={1}
                // One line that grows with what is typed, up to a cap. The
                // resize grip is for a field that is meant to be dragged
                // taller; on a one-row answer box it read as a stray glyph in
                // the corner. Engines without `field-sizing` keep the single
                // row and scroll inside it.
                className="field-sizing-content max-h-40 min-h-8 resize-none"
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
