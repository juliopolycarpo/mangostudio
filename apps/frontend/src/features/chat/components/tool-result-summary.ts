import type { Messages } from '@mangostudio/shared/i18n';

type SummaryLabels = Messages['tools']['summary'];

/** The countable thing a tool produced. Each unit has a singular i18n key too. */
type ToolSummaryUnit = 'item' | 'file' | 'line' | 'hit' | 'replacement' | 'call';

/**
 * What a finished call produced, in the terms that tool deals in.
 *
 * `exit` is its own shape because a non-zero exit code is not a quantity — a
 * shell that failed has no count worth showing, and `0 lines` would read as a
 * successful empty run.
 */
export type ToolResultSummary =
  | { kind: 'count'; unit: ToolSummaryUnit; count: number }
  | { kind: 'exit'; code: number };

/** Tools whose repeated calls are counted in files, not in their own units. */
const FILE_TARGET_TOOLS = new Set([
  'read_file',
  'write_file',
  'edit_file',
  'replace_range',
  'create_file',
  'delete_file',
  'move_file',
]);

function count(unit: ToolSummaryUnit, value: number): ToolResultSummary | null {
  return Number.isFinite(value) && value >= 0
    ? { kind: 'count', unit, count: Math.round(value) }
    : null;
}

function arrayLength(value: unknown): number | null {
  return Array.isArray(value) ? value.length : null;
}

function lineCount(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  if (value.length === 0) return 0;
  return value.replace(/\n$/, '').split('\n').length;
}

/**
 * Parses a tool result payload, tolerating the plain strings and partial
 * objects a still-streaming or legacy call leaves behind.
 */
function parseResult(result: string | null | undefined): Record<string, unknown> | null {
  if (!result) return null;
  try {
    const parsed: unknown = JSON.parse(result);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Derives the right-aligned outcome for one finished call — `12 items`,
 * `84 lines`, `exit 1` — from its own result payload.
 *
 * Returns null whenever the payload does not answer the question: a summary
 * invented from a shape this build does not recognize would be a number the
 * user has no way to check.
 *
 * Usage: getToolResultSummary('grep', '{"matches":[…]}', { pattern: 'x' })
 */
export function getToolResultSummary(
  name: string,
  result: string | null | undefined,
  args: Record<string, unknown> = {}
): ToolResultSummary | null {
  const payload = parseResult(result);

  switch (name) {
    case 'list_directory': {
      const entries = arrayLength(payload?.entries);
      return entries === null ? null : count('item', entries);
    }
    case 'glob': {
      const matches = arrayLength(payload?.matches);
      return matches === null ? null : count('file', matches);
    }
    case 'grep': {
      const matches = arrayLength(payload?.matches);
      return matches === null ? null : count('hit', matches);
    }
    case 'read_file': {
      const { startLine, endLine, totalLines } = payload ?? {};
      if (typeof startLine === 'number' && typeof endLine === 'number') {
        return count('line', Math.max(0, endLine - startLine + 1));
      }
      return typeof totalLines === 'number' ? count('line', totalLines) : null;
    }
    case 'edit_file': {
      const replacements = payload?.replacements;
      return typeof replacements === 'number' ? count('replacement', replacements) : null;
    }
    case 'apply_patch': {
      const files = arrayLength(payload?.files);
      return files === null ? null : count('file', files);
    }
    case 'write_file':
    case 'create_file': {
      // The written body is the argument, not the result: the result reports
      // bytes, and bytes are not what a reader is scanning the rail for.
      const lines = lineCount(args.content);
      return lines === null ? null : count('line', lines);
    }
    case 'replace_range': {
      const { startLine, endLine } = args;
      if (typeof startLine !== 'number' || typeof endLine !== 'number') return null;
      return count('line', Math.max(0, endLine - startLine + 1));
    }
    case 'bash':
    case 'zsh':
    case 'powershell': {
      const exitCode = payload?.exitCode;
      if (typeof exitCode === 'number' && exitCode !== 0) return { kind: 'exit', code: exitCode };
      const lines = lineCount(payload?.stdout);
      return lines === null ? null : count('line', lines);
    }
    default:
      return null;
  }
}

/**
 * The outcome for a collapsed run of same-name calls.
 *
 * Search and listing tools total their own units, because the sum is the answer
 * the run was asked for. Everything else counts the calls themselves — summing
 * the lines of four separate reads produces a number that describes no file.
 *
 * Usage: getToolGroupSummary('read_file', calls)
 */
export function getToolGroupSummary(
  name: string,
  calls: ReadonlyArray<{ result: string | null; args: Record<string, unknown> }>
): ToolResultSummary | null {
  if (calls.length === 0) return null;

  if (name === 'list_directory' || name === 'glob' || name === 'grep') {
    const summaries = calls.map((call) => getToolResultSummary(name, call.result, call.args));
    const totals = summaries.filter(
      (summary): summary is Extract<ToolResultSummary, { kind: 'count' }> =>
        summary?.kind === 'count'
    );
    if (totals.length === calls.length) {
      return count(
        totals[0].unit,
        totals.reduce((sum, summary) => sum + summary.count, 0)
      );
    }
  }

  return count(FILE_TARGET_TOOLS.has(name) ? 'file' : 'call', calls.length);
}

const PLURAL_KEY: Record<ToolSummaryUnit, keyof SummaryLabels> = {
  item: 'items',
  file: 'files',
  line: 'lines',
  hit: 'hits',
  replacement: 'replacements',
  call: 'calls',
};

/**
 * Renders a summary into the active locale, picking the singular form at one.
 *
 * Usage: formatToolSummary({ kind: 'count', unit: 'line', count: 84 }, t.tools.summary)
 */
export function formatToolSummary(summary: ToolResultSummary, labels: SummaryLabels): string {
  if (summary.kind === 'exit') {
    return labels.exitCode.replace('{code}', String(summary.code));
  }
  const key = summary.count === 1 ? summary.unit : PLURAL_KEY[summary.unit];
  return labels[key].replace('{count}', summary.count.toLocaleString());
}
