// Renders workspace coverage tables into the Test job step summary.
// When the suite failed, the tests fragment (if present) is prepended so
// failure counts and error headlines lead, and coverage stays below.
// A green run writes the same coverage tables as before (empty lead).
// Usage: bun ./scripts/qa-gate/render-coverage-summary.ts [test-metrics.json]

import { coverageWorkspaceNames, readWorkspaceCoverageSummary } from './coverage-summary';
import { renderTestFailureLead } from './render/test-failures';

const formatPct = (value: number): string => `${value.toFixed(2)}%`;

const fragmentPath = process.argv[2];
if (fragmentPath && (await Bun.file(fragmentPath).exists())) {
  try {
    const fragment = JSON.parse(await Bun.file(fragmentPath).text()) as TestMetricsFragment;
    process.stdout.write(renderTestFailureLead(fragment.tests));
  } catch {
    // Keep the coverage tables even when the fragment is unreadable.
  }
}

for (const workspace of coverageWorkspaceNames()) {
  try {
    const summary = await readWorkspaceCoverageSummary(workspace);
    process.stdout.write(`## Coverage: ${workspace}\n\n`);
    process.stdout.write('| metric | pct | covered/total |\n');
    process.stdout.write('|---|---|---|\n');
    for (const [label, bucket] of Object.entries(summary)) {
      if (!bucket) {
        process.stdout.write(`| ${label} | n/a | n/a |\n`);
        continue;
      }

      const pct = bucket.pct === null ? 'n/a' : formatPct(bucket.pct);
      process.stdout.write(`| ${label} | ${pct} | ${bucket.covered}/${bucket.total} |\n`);
    }
    process.stdout.write('\n');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(`## Coverage: ${workspace}\n\n`);
    process.stdout.write(`Coverage summary unavailable: \`${message}\`\n\n`);
  }
}
