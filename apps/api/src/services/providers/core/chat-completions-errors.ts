/**
 * Reject finish reasons that report a failed Chat Completions generation.
 * @example
 * throwOnChatCompletionsFailure(chunk.choices[0]?.finish_reason);
 */
export function throwOnChatCompletionsFailure(reason: unknown): void {
  if (reason === 'insufficient_system_resource' || reason === 'aborted') {
    throw new Error(`Chat Completions generation failed: ${reason}`);
  }
}
