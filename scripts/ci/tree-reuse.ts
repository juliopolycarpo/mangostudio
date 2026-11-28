#!/usr/bin/env bun
// Shadow step of the Preflight job on a main push: computes whether the pushed
// commit's tree was already tested by its pull request's last CI run
// (scripts/lib/tree-reuse.ts) and reports the verdict. It is advisory and
// consumed by nothing: it writes no step or job output, skips nothing, and
// always exits 0, whatever the reads return.
//
// Dependency-free: Preflight runs it without `bun install`.
// Usage: GH_TOKEN=... REPOSITORY=owner/repo PUSH_SHA=<sha> PUSH_BEFORE=<sha> bun ./scripts/ci/tree-reuse.ts
import { appendFileSync } from 'node:fs';

import { createCanaryGhApi } from '../lib/canary-gh-api';
import type { GhCommandRunner } from '../lib/canary-github';
import { ADVISORY_RETRY_POLICY, GitHubRetry } from '../lib/github-retry';
import { resolveTreeReuse, type TreeReuseVerdict } from '../lib/tree-reuse';

/** One request may not eat the step's one-minute budget: a hung `gh` is killed here. */
const REQUEST_TIMEOUT_MS = 10_000;

const boundedGhRunner: GhCommandRunner = {
  run(args) {
    const result = Bun.spawnSync({
      cmd: ['gh', ...args],
      stdin: 'ignore',
      timeout: REQUEST_TIMEOUT_MS,
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr.toString(),
    };
  },
};

/** Markdown for the step summary and the log; says in its first line that nothing was skipped. */
export function renderTreeReuseSummary(
  verdict: TreeReuseVerdict,
  context: { readonly repository: string; readonly sha: string; readonly serverUrl: string }
): string {
  const heading = '### Tree reuse (shadow; this run skipped nothing)';
  if (verdict.reuse) {
    const link = `${context.serverUrl}/${context.repository}/actions/runs/${verdict.runId}`;
    return [
      heading,
      '',
      `Verdict: **would reuse**. Commit \`${context.sha}\` holds tree \`${verdict.tree}\`, which pull request run [${verdict.runId}](${link}) already tested as merge commit \`${verdict.mergeCommit}\`.`,
      '',
    ].join('\n');
  }
  return [heading, '', 'Verdict: **full run**', '', `Reason: ${verdict.reason}`, ''].join('\n');
}

if (import.meta.main) {
  try {
    const repository = process.env.REPOSITORY ?? '';
    const sha = process.env.PUSH_SHA ?? '';
    const verdict = resolveTreeReuse(
      createCanaryGhApi(boundedGhRunner, new GitHubRetry(ADVISORY_RETRY_POLICY)),
      { repository, sha, before: process.env.PUSH_BEFORE ?? '' }
    );
    const summary = renderTreeReuseSummary(verdict, {
      repository,
      sha,
      serverUrl: process.env.GITHUB_SERVER_URL ?? 'https://github.com',
    });
    console.log(summary);
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
    }
  } catch (error) {
    // Advisory by design: an unexpected failure is logged, never raised.
    console.log(
      `Tree reuse shadow: no verdict (${error instanceof Error ? error.message : String(error)})`
    );
  }
  process.exitCode = 0;
}
