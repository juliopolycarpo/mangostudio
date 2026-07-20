export function appendWorkdirPromptSection(
  systemPrompt: string | undefined,
  workdir: string | undefined
): string | undefined {
  if (!workdir) {
    return systemPrompt;
  }

  const section = `Working directory:\n${workdir}`;
  return systemPrompt ? `${systemPrompt}\n\n${section}` : section;
}
