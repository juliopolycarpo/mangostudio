// Commit-summary comment entrypoint. Reads base..head from git and writes the
// bot comment markdown to stdout. Pure rendering lives in ./commit-log.ts.
// Usage: bun ./scripts/qa-gate/render-commits.ts <base-sha> <head-sha>

import { COMMIT_LOG_FORMAT, parseCommitLog, renderCommitsComment } from './commit-log';

const [, , baseSha, headSha] = process.argv;
if (!baseSha || !headSha) {
  process.stderr.write('Usage: bun ./scripts/qa-gate/render-commits.ts <base-sha> <head-sha>\n');
  process.exit(1);
}

const proc = Bun.spawnSync({
  cmd: ['git', 'log', '--reverse', `--format=${COMMIT_LOG_FORMAT}`, `${baseSha}..${headSha}`],
  stdout: 'pipe',
  stderr: 'pipe',
});
if (proc.exitCode !== 0) {
  process.stderr.write(`[render-commits] git log failed: ${proc.stderr.toString()}\n`);
  process.exit(1);
}

const entries = parseCommitLog(proc.stdout.toString());
process.stdout.write(`${renderCommitsComment(entries, { baseSha, headSha })}\n`);
