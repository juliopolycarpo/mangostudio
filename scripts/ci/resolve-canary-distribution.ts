#!/usr/bin/env bun
import { appendFileSync, writeFileSync } from 'node:fs';

import {
  type CanaryPromotionApi,
  resolveCanaryPromotionSource,
} from '../lib/canary-promotion-source';
import { requiredEnv } from '../lib/runner';

const githubApi: CanaryPromotionApi = {
  get(path) {
    const result = Bun.spawnSync(['gh', 'api', path]);
    if (result.exitCode !== 0) throw new Error(`GitHub API ${path} failed: ${result.stderr}`);
    return JSON.parse(result.stdout.toString());
  },
  list(path, key) {
    const result = Bun.spawnSync(['gh', 'api', '--paginate', '--slurp', path]);
    if (result.exitCode !== 0) throw new Error(`GitHub API ${path} failed: ${result.stderr}`);
    const pages: unknown = JSON.parse(result.stdout.toString());
    if (!Array.isArray(pages) || pages.length === 0) {
      throw new Error(`GitHub API ${path}: expected nonempty paginated array`);
    }
    let expectedCount: number | undefined;
    const items = pages.flatMap((value: unknown) => {
      if (
        !value ||
        typeof value !== 'object' ||
        !(key in value) ||
        !Array.isArray(value[key as keyof typeof value])
      ) {
        throw new Error(
          `GitHub API ${path}: expected page.${key} array; received ${JSON.stringify(value)}`
        );
      }
      const count = 'total_count' in value ? value.total_count : undefined;
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
        throw new Error(
          `GitHub API ${path}: expected page.total_count nonnegative safe integer; received ${JSON.stringify(count)}`
        );
      }
      if (expectedCount !== undefined && count !== expectedCount) {
        throw new Error(
          `GitHub API ${path}: expected stable total_count ${expectedCount}; received ${count}`
        );
      }
      expectedCount = count;
      return value[key as keyof typeof value] as unknown[];
    });
    if (items.length !== expectedCount) {
      throw new Error(
        `GitHub API ${path}: expected complete ${key} collection (${expectedCount}); received ${items.length}`
      );
    }
    return items;
  },
};

const plan = resolveCanaryPromotionSource(
  {
    repository: requiredEnv('REPO'),
    runId: Number(requiredEnv('SOURCE_RUN_ID')),
    runAttempt: Number(requiredEnv('SOURCE_RUN_ATTEMPT')),
    sourceSha: requiredEnv('SOURCE_SHA'),
  },
  requiredEnv('VERSION'),
  githubApi
);
writeFileSync(requiredEnv('PLAN_PATH'), `${JSON.stringify(plan, null, 2)}\n`);
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
appendFileSync(requiredEnv('GITHUB_OUTPUT'), outputs.join('\n'));
console.log(JSON.stringify(plan, null, 2));
