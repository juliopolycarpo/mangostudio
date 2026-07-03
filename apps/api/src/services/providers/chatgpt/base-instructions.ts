/**
 * Pinned base instructions sent as `instructions` on every ChatGPT backend
 * request.
 *
 * The backend reserves the `instructions` field for a Codex-style agent
 * preamble and may reject or degrade requests whose instructions drift from
 * that shape, so the user-facing MangoStudio system prompt travels as the
 * first input item instead (see CHATGPT_RESPONSES_POLICY). Kept in one file so
 * a backend policy change is a one-line diff.
 */

export const CHATGPT_BASE_INSTRUCTIONS = [
  'You are a general-purpose AI assistant running inside MangoStudio.',
  'Follow the instructions in the first developer message: it defines your role, tone, and constraints for this conversation.',
  'When tools are available, use them when they help you answer accurately, and report tool failures honestly instead of guessing.',
  'Be direct and concise by default; expand detail only when the task calls for it.',
].join('\n');
