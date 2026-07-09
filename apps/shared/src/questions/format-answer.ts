/** One answered question, ready to be serialized into the reply message. */
export interface QuestionAnswer {
  question: string;
  header?: string;
  /** Labels of the options the user selected (empty when free text only). */
  selectedLabels: string[];
  /** The user's own free-text answer, when provided. */
  freeText?: string;
}

/**
 * Builds the deterministic user-message body that answers an
 * `ask_user_question` card. The intro line is localized by the caller.
 *
 * // Usage: const body = formatQuestionAnswers(answers, { intro: t.chat.question.answersIntro });
 */
export function formatQuestionAnswers(
  answers: ReadonlyArray<QuestionAnswer>,
  options: { intro: string }
): string {
  const lines = answers.map((answer) => {
    const topic = answer.header?.trim() || answer.question;
    const selection = answer.selectedLabels.join(', ');
    const freeText = answer.freeText?.trim();
    const value =
      selection && freeText ? `${selection} — ${freeText}` : selection || freeText || '';
    return `- ${topic}: ${value}`;
  });
  return [options.intro, ...lines].join('\n');
}
