import type { TextContextMessage } from '../types';

/** Flattens chat context into a single prompt for the Cursor local agent. */
export function buildCursorAgentPrompt(params: {
  systemPrompt?: string;
  history: TextContextMessage[];
  prompt: string;
  /** Project root for MangoStudio-routed file/shell tools (absolute paths). */
  workspaceDir?: string;
}): string {
  const sections: string[] = [];

  if (params.workspaceDir?.trim()) {
    sections.push(
      `Workspace root:\n${params.workspaceDir.trim()}\n\n` +
        'Use absolute paths under this directory when calling file or shell tools.'
    );
  }

  if (params.systemPrompt?.trim()) {
    sections.push(`System instructions:\n${params.systemPrompt.trim()}`);
  }

  if (params.history.length > 0) {
    const transcript = params.history
      .map((message) => {
        const speaker = message.role === 'user' ? 'User' : 'Assistant';
        return `${speaker}: ${message.text}`;
      })
      .join('\n\n');
    sections.push(`Conversation so far:\n${transcript}`);
  }

  sections.push(`User: ${params.prompt}`);
  return sections.join('\n\n');
}
