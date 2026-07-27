/**
 * Markdown subagent locations that share a known framing dialect. Returns
 * undefined when the location is unknown so callers can skip dialect-aware
 * strategy filtering instead of guessing.
 */
export type MarkdownSubagentDialect = 'claude' | 'cursor' | 'mangostudio';

export function dialectForMarkdownSubagentLocation(
  locationId: string | undefined
): MarkdownSubagentDialect | undefined {
  if (locationId === 'claude-agents') return 'claude';
  if (locationId === 'cursor-agents') return 'cursor';
  if (locationId === 'mango-agents') return 'mangostudio';
  return undefined;
}
