// Regex-level GitHub workflow block extraction shared by the workflow policy
// tests. Isolating a single block keeps an assertion about one job or section
// from being masked or satisfied by a later one that happens to share the
// same content.

/**
 * Isolate a single top-level job's block (up to the next `  <job>:` header or
 * EOF). Returns '' when the job is absent.
 */
export function extractJobBlock(workflow: string, job: string): string {
  return new RegExp(`\\n  ${job}:\\n([\\s\\S]*?)(?=\\n  \\S|$)`).exec(workflow)?.[1] ?? '';
}

/** Isolate the body of the top-level `jobs:` section. */
function extractJobsBlock(workflow: string): string {
  return /\njobs:\n([\s\S]*?)(?=\n\S|$)/.exec(workflow)?.[1] ?? '';
}

/** Split the `jobs:` section into per-job blocks, in declaration order. */
export function extractJobBlocks(workflow: string): Array<{ job: string; block: string }> {
  const jobsBlock = extractJobsBlock(workflow);
  const headers = [...jobsBlock.matchAll(/^ {2}([\w-]+):$/gm)];
  return headers.map((header, index) => {
    const next = headers[index + 1];
    return {
      job: header[1],
      block: jobsBlock.slice(header.index ?? 0, next?.index),
    };
  });
}

/**
 * Split a job block into per-step blocks, in declaration order. Each block
 * starts at the step's `- ` list item, so keys are visible regardless of the
 * order they were written in.
 */
export function extractStepBlocks(jobBlock: string): string[] {
  return extractStepBlocksAtIndent(jobBlock, 6);
}

/**
 * Split YAML step lists whose `- ` markers sit at a fixed indent. Workflow job
 * steps use indent 6; composite-action steps use indent 4.
 */
export function extractStepBlocksAtIndent(source: string, indent: number): string[] {
  const marker = new RegExp(`^ {${indent}}- `, 'gm');
  const headers = [...source.matchAll(marker)];
  return headers.map((header, index) => {
    const next = headers[index + 1];
    return source.slice(header.index ?? 0, next?.index);
  });
}

/** One line of a `run:` script, with its 1-based position in the file. */
export interface RunScriptLine {
  readonly line: number;
  readonly text: string;
}

/**
 * Every line of every `run:` script in a workflow or composite-action manifest.
 *
 * Both spellings are covered, because a policy over script text is worthless if
 * it can only see one of them: the inline `run: <command>`, and the block scalar
 * (`run: |`) whose script is the indented lines that follow. A grep for `run:`
 * and an expression on the same line reads only the first, which is the minority
 * form here.
 *
 * Line-based rather than block-based on purpose: workflow job steps sit at
 * indent 6 and composite-action steps at indent 4, so a walk that must reach
 * every `run:` in the repository cannot assume either. The script ends at the
 * first non-blank line indented no deeper than the `run:` key itself — which is
 * the key's own column, not the line's, so a `- run:` step's sibling keys are
 * not mistaken for script.
 *
 * `defaults.run` is skipped, and that is a statement about the Actions schema
 * rather than a special case: it is the one place `run` names a mapping
 * (`shell:`, `working-directory:`) instead of a script, so reading its children
 * as script text would report a legal `working-directory: ${…}` as an injection.
 *
 * // Usage: runScriptLines(readText('.github/workflows/ci.yml')) // [{ line: 42, text: '          bun run check' }, …]
 */
export function runScriptLines(source: string): RunScriptLine[] {
  const found: RunScriptLine[] = [];
  let scriptIndent = -1;
  let previousKey = '';

  source.split('\n').forEach((text, index) => {
    const trimmed = text.trim();
    if (trimmed === '') return;

    const opener = /^(\s*)(-\s+)?run:(.*)$/.exec(text);
    if (opener) {
      const [, indent, marker, inline] = opener;
      const isDefaultsMapping = previousKey === 'defaults:';
      previousKey = trimmed;
      scriptIndent = isDefaultsMapping ? -1 : indent.length + (marker?.length ?? 0);
      if (
        !isDefaultsMapping &&
        inline.trim() !== '' &&
        !inline.trimStart().startsWith('|') &&
        !inline.trimStart().startsWith('>')
      ) {
        found.push({ line: index + 1, text });
      }
      return;
    }

    // A comment must not become the `previousKey` a `defaults:` block is
    // recognised by, or one written between the two keys would re-open the
    // mapping as a script.
    if (!trimmed.startsWith('#')) previousKey = trimmed;
    if (scriptIndent < 0) return;
    if (text.search(/\S/) <= scriptIndent) {
      scriptIndent = -1;
      return;
    }
    found.push({ line: index + 1, text });
  });

  return found;
}

/** Isolate the body of the top-level `on:` trigger section. */
export function extractOnBlock(workflow: string): string {
  return /\non:\n([\s\S]*?)(?=\n\S|$)/.exec(workflow)?.[1] ?? '';
}

/** List the keys declared at the top level of a section body (indent 2). */
export function sectionKeys(sectionBody: string): string[] {
  return [...sectionBody.matchAll(/^ {2}([\w-]+):/gm)].map((match) => match[1]);
}

/** Parse a job block's inline `needs: [a, b]` list. Returns [] when absent. */
export function parseNeedsList(jobBlock: string): string[] {
  const list = /\n\s+needs: \[([^\]]*)\]/.exec(jobBlock)?.[1];
  return list
    ? list
        .split(',')
        .map((need) => need.trim())
        .filter(Boolean)
    : [];
}

/**
 * Jobs that must appear in an aggregate gate's `needs`: every job except the
 * gate itself and any job that directly lists the gate in its own `needs`.
 * That second clause excludes canary-style publishers without naming them.
 */
export function expectedGateNeeds(workflow: string): string[] {
  return extractJobBlocks(workflow)
    .filter(({ job, block }) => job !== 'gate' && !parseNeedsList(block).includes('gate'))
    .map(({ job }) => job)
    .sort();
}
