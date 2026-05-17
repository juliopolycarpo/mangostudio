import { coverageWorkspaceNames, readWorkspaceCoverageSummary } from './coverage-summary';

const formatPct = (value: number): string => `${value.toFixed(2)}%`;

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

      process.stdout.write(
        `| ${label} | ${formatPct(bucket.pct)} | ${bucket.covered}/${bucket.total} |\n`
      );
    }
    process.stdout.write('\n');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(`## Coverage: ${workspace}\n\n`);
    process.stdout.write(`Coverage summary unavailable: \`${message}\`\n\n`);
  }
}
