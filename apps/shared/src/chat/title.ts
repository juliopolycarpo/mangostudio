const DEFAULT_CHAT_TITLE_PREFIX = 'New Chat';

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
