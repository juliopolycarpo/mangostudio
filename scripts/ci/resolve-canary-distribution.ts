#!/usr/bin/env bun
import { appendFileSync, writeFileSync } from 'node:fs';

import { type CanaryGhReadApi, createCanaryGhApi } from '../lib/canary-gh-api';
import type { CanaryDistribution } from '../lib/canary-promotion';
import {
  type CanaryPromotionSelection,
  resolveCanaryPromotionSource,
} from '../lib/canary-promotion-source';
import { requiredEnv } from '../lib/runner';

/** Where the resolved plan goes: a JSON file and the step's `GITHUB_OUTPUT`. */
export interface ResolveDistributionFiles {
  readonly planPath: string;
  readonly githubOutputPath: string;
}

/**
 * Resolve the retained distribution scopes of the frozen CI attempt through
 * `api`, then write the plan and the step outputs. Nothing is written when a
 * read fails.
 * @example resolveCanaryDistributionToFiles(selection, version, files, createCanaryGhApi());
 */
export function resolveCanaryDistributionToFiles(
  selection: CanaryPromotionSelection,
  version: string,
  files: ResolveDistributionFiles,
  api: CanaryGhReadApi
): CanaryDistribution {
  const plan = resolveCanaryPromotionSource(selection, version, api);
  writeFileSync(files.planPath, `${JSON.stringify(plan, null, 2)}\n`);
  const outputs: string[] = [];
  for (const scope of ['checksums', 'assets', 'npm'] as const) {
    const approval = plan[scope];
    outputs.push(
      `${scope}_id=${approval.artifactId}`,
      `${scope}_name=${approval.artifactName}`,
      `${scope}_digest=${approval.digest}`
    );
  }
  outputs.push(`builder_attempt=${plan.checksums.producerAttempt}`, `built_at=${plan.builtAt}`, '');
  appendFileSync(files.githubOutputPath, outputs.join('\n'));
  return plan;
}

if (import.meta.main) {
  // One client for the process: every read spends the same retry wait budget.
  const plan = resolveCanaryDistributionToFiles(
    {
      repository: requiredEnv('REPO'),
      runId: Number(requiredEnv('SOURCE_RUN_ID')),
      runAttempt: Number(requiredEnv('SOURCE_RUN_ATTEMPT')),
      sourceSha: requiredEnv('SOURCE_SHA'),
    },
    requiredEnv('VERSION'),
    { planPath: requiredEnv('PLAN_PATH'), githubOutputPath: requiredEnv('GITHUB_OUTPUT') },
    createCanaryGhApi()
  );
  console.log(JSON.stringify(plan, null, 2));
}
