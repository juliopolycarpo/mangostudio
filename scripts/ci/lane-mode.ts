#!/usr/bin/env bun
// Preflight's lane-set decision, shared by CI and the sibling workflows'
// `changes` jobs so one rule decides for all of them.
//
//   bun ./scripts/ci/lane-mode.ts <NUL path file> >> "$GITHUB_OUTPUT"
//     Prints `lane_set=full|light` and `lane_reason=<one line>`. The path file
//     is read only for a Dependabot pull request, so push and manual runs may
//     pass a path that does not exist. The reason also goes to the log and the
//     job summary.
//
// Environment (every value comes from the event, never from `github.actor`):
//   EVENT_NAME, PR_AUTHOR (`github.event.pull_request.user.login`), HEAD_REPO,
//   BASE_REPO, PR_NUMBER, GH_TOKEN (read-only `github.token`), GITHUB_API_URL,
//   GITHUB_STEP_SUMMARY.
//
// Dependency-free; runs without `bun install`.

import { appendFileSync } from 'node:fs';

import { readChangedPaths } from '../lib/changed-paths';
import {
  decideLaneMode,
  type FetchLike,
  type LaneModeVerdict,
  readPullRequestLabels,
} from '../lib/lane-mode';

export interface LaneModeDeps {
  readonly fetchImpl: FetchLike;
  readonly readPaths: (file: string | undefined) => readonly string[];
}

/** Run the decision against an environment map; the CLI wraps this with real I/O. */
export async function runLaneMode(
  env: Readonly<Record<string, string | undefined>>,
  changedFile: string | undefined,
  deps: LaneModeDeps
): Promise<LaneModeVerdict> {
  return decideLaneMode(
    {
      eventName: env.EVENT_NAME ?? '',
      author: env.PR_AUTHOR ?? '',
      headRepo: env.HEAD_REPO ?? '',
      baseRepo: env.BASE_REPO ?? '',
    },
    {
      readLabels: () =>
        readPullRequestLabels({
          repository: env.BASE_REPO ?? '',
          pullNumber: env.PR_NUMBER ?? '',
          token: env.GH_TOKEN ?? '',
          apiUrl: env.GITHUB_API_URL,
          fetchImpl: deps.fetchImpl,
        }),
      readPaths: () => deps.readPaths(changedFile),
    }
  );
}

/** The `$GITHUB_OUTPUT` lines for a verdict. The reason is one line by construction. */
export function renderOutputs(verdict: LaneModeVerdict): string {
  return `lane_set=${verdict.laneSet}\nlane_reason=${verdict.reason.replace(/[\r\n]+/g, ' ')}\n`;
}

if (import.meta.main) {
  try {
    const verdict = await runLaneMode(process.env, process.argv[2], {
      fetchImpl: fetch as unknown as FetchLike,
      readPaths: readChangedPaths,
    });
    process.stdout.write(renderOutputs(verdict));
    // stderr, not stdout: stdout is appended to $GITHUB_OUTPUT.
    console.error(`::notice title=Lane set: ${verdict.laneSet}::${verdict.reason}`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `### Lane set: ${verdict.laneSet}\n\n${verdict.reason}\n`
      );
    }
  } catch (error) {
    console.error(`lane-mode: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
