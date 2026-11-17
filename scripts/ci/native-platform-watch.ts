#!/usr/bin/env bun
// Scheduled native platform run helpers for .github/workflows/native-bun-qualification.yml.
//
//   bun ./scripts/ci/native-platform-watch.ts gate
//     Writes `skip=true|false` to GITHUB_OUTPUT: a scheduled run is skipped
//     when main still sits at the commit the last successful scheduled run qualified.
//   bun ./scripts/ci/native-platform-watch.ts report --verdict <result> [--dry-run] [--rehearse failure|success]
//     Opens, comments on or closes the tracking issue for the run's verdict.
//
// Reads GITHUB_REPOSITORY, GITHUB_TOKEN, GITHUB_EVENT_NAME, GITHUB_SHA,
// GITHUB_REF, GITHUB_RUN_ID and GITHUB_SERVER_URL from the Actions environment.

import { appendFileSync } from 'node:fs';

import { GithubNativeWatchApi } from './native-watch/api';
import {
  parseNativeVerdict,
  reportNativeResult,
  shouldSkipScheduledRun,
} from './native-watch/decide';

export type WatchCommand =
  | { readonly kind: 'gate' }
  | {
      readonly kind: 'report';
      readonly verdict: string;
      readonly dryRun: boolean;
      readonly rehearsal?: 'failure' | 'success';
    };

const USAGE = 'gate | report --verdict <result> [--dry-run] [--rehearse failure|success]';

/**
 * Parse the command line; any other shape is refused before network access.
 * @example parseWatchArguments(['report', '--verdict', 'failure', '--dry-run']);
 */
export function parseWatchArguments(args: readonly string[]): WatchCommand {
  const [command, ...rest] = args;
  if (command === 'gate' && rest.length === 0) return { kind: 'gate' };
  if (command === 'report') {
    let verdict: string | undefined;
    let dryRun = false;
    let rehearsal: 'failure' | 'success' | undefined;
    for (let index = 0; index < rest.length; index++) {
      const flag = rest[index];
      if (flag === '--dry-run') dryRun = true;
      else if (flag === '--verdict' && rest[index + 1] !== undefined) verdict = rest[++index];
      else if (flag === '--rehearse' && rest[index + 1] !== undefined) {
        const value = rest[++index];
        if (value !== 'failure' && value !== 'success') {
          throw new Error(
            `Invalid rehearsal ${JSON.stringify(value)}; expected failure or success`
          );
        }
        rehearsal = value;
      } else throw new Error(`Invalid arguments ${JSON.stringify(args)}; expected ${USAGE}`);
    }
    if (verdict === undefined) {
      throw new Error(`Invalid arguments ${JSON.stringify(args)}; expected ${USAGE}`);
    }
    return { kind: 'report', verdict, dryRun, rehearsal };
  }
  throw new Error(`Invalid arguments ${JSON.stringify(args)}; expected ${USAGE}`);
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new Error(`Invalid ${name} ${JSON.stringify(value)}; expected a nonempty value`);
  return value;
}

async function main(): Promise<void> {
  const command = parseWatchArguments(Bun.argv.slice(2));
  const repository = requiredEnvironment('GITHUB_REPOSITORY');
  const api = new GithubNativeWatchApi(repository, requiredEnvironment('GITHUB_TOKEN'));
  const sha = requiredEnvironment('GITHUB_SHA');
  if (command.kind === 'gate') {
    const decision = await shouldSkipScheduledRun({
      api,
      event: requiredEnvironment('GITHUB_EVENT_NAME'),
      sha,
    });
    console.log(decision.reason);
    appendFileSync(requiredEnvironment('GITHUB_OUTPUT'), `skip=${decision.skip}\n`);
    return;
  }
  const runId = Number(requiredEnvironment('GITHUB_RUN_ID'));
  await reportNativeResult({
    api,
    ref: requiredEnvironment('GITHUB_REF'),
    sha,
    runId,
    runUrl: `${requiredEnvironment('GITHUB_SERVER_URL')}/${repository}/actions/runs/${runId}`,
    event: requiredEnvironment('GITHUB_EVENT_NAME'),
    verdict: parseNativeVerdict(command.verdict),
    dryRun: command.dryRun,
    rehearsal: command.rehearsal,
  });
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
