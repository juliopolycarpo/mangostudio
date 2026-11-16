/**
 * A `text` edit on a message whose turn is still streaming. The turn's checkpoint
 * writer keeps its own copy of what it stored and appends later text to the row, so
 * an edit made underneath it would be extended with text that belongs to the old
 * content. Edit the message after the turn settles, or send `isGenerating: false`
 * in the same patch to settle it.
 */
export class GeneratingMessageTextEditError extends Error {
  constructor(messageId: string) {
    super(
      `expected a text edit on a settled message or one that also sets isGenerating: false | received a text edit on generating message ${messageId}`
    );
    this.name = 'GeneratingMessageTextEditError';
  }
}
