import { isTimestampChatTitle } from '@mangostudio/shared/chat';

/**
 * The name a chat is shown by.
 *
 * A chat nobody has named yet is stored as `New Chat [YYYY-MM-DD HH:MM]`, the
 * form auto-titling looks for, so the first prompt can rename it. That string is
 * a marker, not a name: English whatever the reader's language, Title Case, and
 * a bracketed timestamp that a sidebar row truncates to "New Chat [2026-10-…",
 * leaving the current chat's row nothing but noise. The sidebar's date groups
 * and the palette's relative time already say when a chat was made, so it is
 * shown as the reader's own word for an untitled chat instead. A real title is
 * returned as it is.
 *
 * // Usage: chatTitleLabel(chat.title, t.chat.untitled)
 */
export function chatTitleLabel(title: string, untitled: string): string {
  return title.trim() === '' || isTimestampChatTitle(title) ? untitled : title;
}
