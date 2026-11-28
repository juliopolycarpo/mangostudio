#!/usr/bin/env bun
// Stage 4 of issue #2698 in the runtime build job (.github/workflows/runtime-build.yml):
// two read-only commands around the workflow's download step.
//
//   resolve  lists main push runs and finds a verified base for this checkout's
//            input digest (scripts/lib/runtime-base-reuse.ts). Every refusal exits 0
//            with `reuse=false`, so the job builds from source; only a crash exits 1.
//   verify   re-checks the run the download came from, then checks the downloaded
//            files against it and writes the reuse record the job uploads, and
//            the step summary.
//
// Nothing here can fail a build: the workflow marks both steps `continue-on-error`
// and builds from source unless every one of them succeeded.
//
// Dependency-free: the runtime build job runs it with `bun --no-install`.
// Usage (request context by environment, as the workflow passes it):
//   GH_TOKEN=... REPOSITORY=owner/repo SOURCE_SHA=<sha> EVENT_NAME=push REF=refs/heads/main \
//     CURRENT_RUN_ID=<id> bun ./scripts/ci/runtime-base-reuse.ts resolve \
//     --platform linux-x64 --profile shipping --digest <hex>
//   ... bun ./scripts/ci/runtime-base-reuse.ts verify --platform linux-x64 --profile shipping \
//     --digest <hex> --zig --run-id <id> --artifact-id <id> --dir <downloaded> \
//     --record-out <dir> --summary-out <file>
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { assertNoUnexpectedArguments, fatal, parseArgs } from '../lib/args';
import { createCanaryGhApi } from '../lib/canary-gh-api';
import type { GhCommandRunner } from '../lib/canary-github';
import { ADVISORY_RETRY_POLICY, GitHubRetry } from '../lib/github-retry';
import { log } from '../lib/log';
import {
  buildRuntimeReuseRecord,
  renderRuntimeBaseRefusalSummary,
  renderRuntimeReuseSummary,
  resolveRuntimeBase,
  runtimeBaseContextProblem,
  runtimeReuseArtifactName,
  verifyRuntimeBaseCandidate,
  verifyRuntimeBaseFiles,
} from '../lib/runtime-base-reuse';

/** One request may not eat the step's budget: a hung `gh` is killed here. */
const REQUEST_TIMEOUT_MS = 12_000;

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

function appendIfSet(variable: string, text: string): void {
  const target = process.env[variable];
  if (target) appendFileSync(target, text);
}

function env(name: string): string {
  return process.env[name]?.trim() ?? '';
}

/** A GitHub output value is one line; a refusal reason may not be. */
function oneLine(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim();
}

function requirePositiveFlag(value: string | undefined, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`expected ${flag} a positive integer | received: ${value ?? '(unset)'}`);
  }
  return parsed;
}

if (import.meta.main) {
  const { flags, values, positional } = parseArgs({
    booleanFlags: ['--zig'],
    valueFlags: [
      '--platform',
      '--profile',
      '--digest',
      '--run-id',
      '--artifact-id',
      '--dir',
      '--record-out',
      '--summary-out',
    ],
  });
  const [command, ...rest] = positional;
  assertNoUnexpectedArguments(rest);
  try {
    if (command !== 'resolve' && command !== 'verify') {
      throw new Error(`expected command resolve | verify | received: ${command ?? '(none)'}`);
    }
    const request = {
      repository: env('REPOSITORY'),
      platform: values['--platform'] ?? '',
      profile: values['--profile'] ?? '',
      digest: values['--digest'] ?? '',
      sourceSha: env('SOURCE_SHA'),
      currentRunId: Number(env('CURRENT_RUN_ID')),
      eventName: env('EVENT_NAME'),
      ref: env('REF'),
    };
    // One client for the process: every read spends the same short retry budget.
    const api = createCanaryGhApi(boundedGhRunner, new GitHubRetry(ADVISORY_RETRY_POLICY));

    if (command === 'resolve') {
      const verdict = resolveRuntimeBase(api, request);
      if (!verdict.reuse) {
        const summary = renderRuntimeBaseRefusalSummary(request.platform, verdict.reason);
        console.log(summary);
        appendIfSet('GITHUB_STEP_SUMMARY', summary);
        appendIfSet('GITHUB_OUTPUT', `reuse=false\nreason=${oneLine(verdict.reason)}\n`);
      } else {
        log(
          `verified base for ${request.platform}: run ${verdict.producer.runId} (${verdict.producer.sha}), artifact ${verdict.artifact.name} (${verdict.artifact.id})`
        );
        appendIfSet(
          'GITHUB_OUTPUT',
          [
            'reuse=true',
            `run-id=${verdict.producer.runId}`,
            `artifact-id=${verdict.artifact.id}`,
            `artifact-name=${verdict.artifact.name}`,
            '',
          ].join('\n')
        );
      }
    } else {
      const contextProblem = runtimeBaseContextProblem(request);
      if (contextProblem)
        throw new Error(`expected a reusable context | received: ${contextProblem}`);
      const dir = values['--dir'];
      const recordOut = values['--record-out'];
      if (!dir || !recordOut) throw new Error('expected --dir and --record-out | received: unset');
      // The run the download came from, checked again against what the API says
      // now, and the same artifact the search selected: a swap between the two
      // steps shows as a different id.
      const runId = requirePositiveFlag(values['--run-id'], '--run-id');
      const artifactId = requirePositiveFlag(values['--artifact-id'], '--artifact-id');
      const { producer, artifact } = verifyRuntimeBaseCandidate(
        api,
        request,
        api.get(`repos/${request.repository}/actions/runs/${runId}`),
        Date.now()
      );
      if (producer.runId !== runId || artifact.id !== artifactId) {
        throw new Error(
          `expected run ${runId} artifact ${artifactId} | received: run ${producer.runId} artifact ${artifact.id}`
        );
      }
      const base = verifyRuntimeBaseFiles(dir, {
        platform: request.platform,
        profile: request.profile,
        digest: request.digest,
        zig: flags['--zig'] ?? false,
        producer: {
          runId: producer.runId,
          runAttempt: producer.runAttempt,
          sha: producer.sha,
          repository: request.repository,
        },
      });
      const record = buildRuntimeReuseRecord({
        request,
        producer,
        artifact,
        base,
        reusedBy: {
          repository: request.repository,
          runId: request.currentRunId,
          runAttempt: Number(env('CURRENT_RUN_ATTEMPT')) || 1,
          sha: request.sourceSha,
        },
      });
      mkdirSync(recordOut, { recursive: true });
      writeFileSync(join(recordOut, 'record.json'), `${JSON.stringify(record, null, 2)}\n`);
      const summaryOut = values['--summary-out'];
      if (summaryOut) {
        writeFileSync(
          summaryOut,
          renderRuntimeReuseSummary(record, env('GITHUB_SERVER_URL') || 'https://github.com')
        );
      }
      log(`verified ${base.binaryPath}: ${base.sha256} (${base.bytes} bytes)`);
      appendIfSet(
        'GITHUB_OUTPUT',
        [
          `path=${base.binaryPath}`,
          `record-name=${runtimeReuseArtifactName(request.platform, producer.runId, request.digest)}`,
          `binary-sha256=${base.sha256}`,
          '',
        ].join('\n')
      );
    }
  } catch (caught) {
    fatal(caught instanceof Error ? caught.message : String(caught));
  }
}
