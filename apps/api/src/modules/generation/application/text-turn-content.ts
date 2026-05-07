export class EmptyTextTurnError extends Error {
  constructor() {
    super('A prompt or attachment is required.');
    this.name = 'EmptyTextTurnError';
  }
}

export function normalizeTextTurnAttachmentIds(attachmentIds: string[] | undefined): string[] {
  if (!attachmentIds) return [];
  return Array.from(new Set(attachmentIds.map((id) => id.trim()).filter(Boolean)));
}

export function assertTextTurnHasContent(prompt: string, attachmentIds: string[]): void {
  if (prompt.trim().length === 0 && attachmentIds.length === 0) {
    throw new EmptyTextTurnError();
  }
}
