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
