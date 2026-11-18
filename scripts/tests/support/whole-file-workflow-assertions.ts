/**
 * Finds positive `toContain` / `toMatch` assertions that run over a whole
 * workflow or composite-action file inside a test source.
 *
 * Such an assertion passes when the guarded text sits in any job, step or
 * comment of the file, so a test that names one job or step proves nothing
 * about it. The workflow tests read each fact through the block helpers in
 * `workflow-blocks.ts` instead; this scan keeps new tests from drifting back.
 *
 * It is a line-oriented heuristic over test source, not a TypeScript parser:
 * - a name is whole-file when it is bound as `const name = readText(<path>)`
 *   and the path is a `.github/workflows/` or `.github/actions/` literal, or an
 *   identifier that reads as a workflow path (`workflowPath`, `QA_METRICS_PATH`);
 * - a binding stays visible until a line dedents below it, so a later
 *   `const workflow = extractJobBlock(workflow, ...)` in another test is a block;
 * - `.not.` assertions are exempt, because absence anywhere is stricter than
 *   absence in one block;
 * - `toMatch(/^x/m)` with a non-space first character is exempt: column zero is
 *   a top-level key, so the match is already scoped to the workflow root;
 * - a `// whole-file: <reason>` comment on the line above the statement (or
 *   trailing it) opts out when a workflow-wide fact is the point, such as a count.
 */

export interface WholeFileAssertion {
  /** 1-based line of the `expect(` call. */
  line: number;
  /** The whole-file name, or the inline `readText(...)` call. */
  subject: string;
  matcher: 'toContain' | 'toMatch';
}

const WORKFLOW_LITERAL = /^['"`]\.github\/(?:workflows|actions)\//;
const WORKFLOW_IDENTIFIER = /workflow|_PATH$|^path$/i;
const BINDING = /^(\s*)(?:const|let)\s+(\w+)\s*=\s*readText\(\s*([^)]*?)\s*\)/;
const SCOPED_BINDING = /^(\s*)(?:const|let)\s+(\w+)\s*=/;
const EXPECT_SUBJECT = /expect\(\s*(\w+)\b/;
const EXPECT_INLINE = /expect\(\s*(readText\(\s*['"`]\.github\/(?:workflows|actions)\/[^)]*\))/;
const OPT_OUT = /\/\/\s*whole-file:\s*\S/;

function readsWorkflow(argument: string): boolean {
  return WORKFLOW_LITERAL.test(argument) || WORKFLOW_IDENTIFIER.test(argument);
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/**
 * The statement starting at `start`: lines up to the first one that ends it
 * with `;`, so a prettier-wrapped `expect(...)\n  .toContain(...)` stays whole.
 */
function statementFrom(lines: readonly string[], start: number): string {
  const parts: string[] = [];
  for (let index = start; index < lines.length && index < start + 12; index += 1) {
    parts.push(lines[index]);
    if (lines[index].trimEnd().endsWith(';')) break;
  }
  return parts.join('\n');
}

function matcherOf(
  statement: string
): { matcher: 'toContain' | 'toMatch'; argument: string } | null {
  // `.not` between expect() and the matcher means an absence assertion.
  const match = /\)\s*\.(not\s*\.\s*)?(toContain|toMatch)\(\s*([\s\S]*)/.exec(statement);
  if (!match || match[1]) return null;
  return { matcher: match[2] as 'toContain' | 'toMatch', argument: match[3] };
}

export function wholeFileWorkflowAssertions(source: string): WholeFileAssertion[] {
  const lines = source.split('\n');
  // Each name keeps a stack so an inner binding shadows, then restores, an outer one.
  const visible = new Map<string, Array<{ indent: number; wholeFile: boolean }>>();
  const found: WholeFileAssertion[] = [];

  for (const [index, line] of lines.entries()) {
    if (line.trim() === '') continue;
    const indent = indentOf(line);
    // Leaving a block drops every binding declared inside it.
    for (const stack of visible.values()) {
      while (stack.length > 0 && indent < stack[stack.length - 1].indent) stack.pop();
    }

    const bound = SCOPED_BINDING.exec(line);
    if (bound) {
      const whole = BINDING.exec(line);
      const stack = visible.get(bound[2]) ?? [];
      stack.push({
        indent: bound[1].length,
        wholeFile: whole !== null && readsWorkflow(whole[3]),
      });
      visible.set(bound[2], stack);
      continue;
    }

    const inline = EXPECT_INLINE.exec(line);
    const named = EXPECT_SUBJECT.exec(line);
    const innermost = named ? visible.get(named[1])?.at(-1) : undefined;
    const subject = inline?.[1] ?? (named && innermost?.wholeFile ? named[1] : null);
    if (!subject) continue;

    const statement = statementFrom(lines, index);
    const matcher = matcherOf(statement);
    if (!matcher) continue;
    if (matcher.matcher === 'toMatch' && /^\/\^[^\s]/.test(matcher.argument)) continue;
    if (OPT_OUT.test(statement) || (index > 0 && OPT_OUT.test(lines[index - 1]))) continue;
    found.push({ line: index + 1, subject, matcher: matcher.matcher });
  }
  return found;
}
