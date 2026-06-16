const DEFAULT_CHAT_TITLE_PREFIX = 'New Chat';
const TIMESTAMP_CHAT_TITLE_PATTERN = /^New Chat \[[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}\]$/;

export const CHAT_TITLE_PROMPT_LENGTH_MIN = 10;
export const CHAT_TITLE_PROMPT_LENGTH_MAX = 80;
export const CHAT_TITLE_PROMPT_LENGTH_DEFAULT = 30;

function padDatePart(value: number): string {
  return String(value).padStart(2, '0');
}

export function createTimestampChatTitle(date = new Date()): string {
  const year = date.getFullYear();
  const month = padDatePart(date.getMonth() + 1);
  const day = padDatePart(date.getDate());
  const hour = padDatePart(date.getHours());
  const minute = padDatePart(date.getMinutes());

  return `${DEFAULT_CHAT_TITLE_PREFIX} [${year}-${month}-${day} ${hour}:${minute}]`;
}

export function isTimestampChatTitle(title: string): boolean {
  return TIMESTAMP_CHAT_TITLE_PATTERN.test(title);
}

export function clampChatTitlePromptLength(value: number): number {
  if (!Number.isFinite(value)) return CHAT_TITLE_PROMPT_LENGTH_DEFAULT;

  const rounded = Math.round(value);
  if (rounded < CHAT_TITLE_PROMPT_LENGTH_MIN) return CHAT_TITLE_PROMPT_LENGTH_MIN;
  if (rounded > CHAT_TITLE_PROMPT_LENGTH_MAX) return CHAT_TITLE_PROMPT_LENGTH_MAX;
  return rounded;
}

export function createPromptChatTitle(
  prompt: string,
  maxLength = CHAT_TITLE_PROMPT_LENGTH_DEFAULT
): string | null {
  const normalizedPrompt = prompt.replace(/\s+/g, ' ').trim();
  if (normalizedPrompt.length === 0) return null;

  const normalizedMaxLength = clampChatTitlePromptLength(maxLength);
  if (normalizedPrompt.length <= normalizedMaxLength) return normalizedPrompt;

  return `${normalizedPrompt.slice(0, normalizedMaxLength).trimEnd()}...`;
}

const TITLE_QUOTE_CHARS = new Set(['"', "'", '`']);

/**
 * Trims leading and trailing quote/backtick characters in a single linear pass.
 *
 * Replaces a `/^["'`]+|["'`]+$/g` cleanup that backtracks on adversarial model
 * output like `""""…"` (CodeQL js/polynomial-redos).
 */
function trimQuoteChars(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && TITLE_QUOTE_CHARS.has(value[start])) start += 1;
  while (end > start && TITLE_QUOTE_CHARS.has(value[end - 1])) end -= 1;
  return value.slice(start, end);
}

export function sanitizeGeneratedChatTitle(title: string, fallbackTitle: string): string {
  const withoutPrefix = title
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^title\s*:\s*/i, '');
  const normalizedTitle = trimQuoteChars(withoutPrefix).trim();

  if (normalizedTitle.length === 0) return fallbackTitle;
  return createPromptChatTitle(normalizedTitle, CHAT_TITLE_PROMPT_LENGTH_MAX) ?? fallbackTitle;
}
