export const WORKDIR_RESTRICTED_PROMPT_LINE =
  'Only paths inside this directory are accessible to tools.';

export function appendWorkdirPromptSection(
  systemPrompt: string | undefined,
  workdir: string | undefined,
  restrictToolsToWorkdir = false
): string | undefined {
  if (!workdir) {
    return systemPrompt;
  }

  const lines = [`Working directory:\n${workdir}`];
  if (restrictToolsToWorkdir) {
    lines.push(WORKDIR_RESTRICTED_PROMPT_LINE);
  }
  const section = lines.join('\n');
  return systemPrompt ? `${systemPrompt}\n\n${section}` : section;
}
