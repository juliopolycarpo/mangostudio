#!/usr/bin/env bun
import { appendFileSync, writeFileSync } from 'node:fs';

import { type CanaryValidationApi, qualifyCanarySource } from '../lib/canary-validation';
import { requiredEnv } from '../lib/runner';

const githubApi: CanaryValidationApi = {
  get(path) {
    const result = Bun.spawnSync(['gh', 'api', path]);
    if (result.exitCode !== 0)
      throw new Error(`GitHub API ${path} failed: ${result.stderr.toString()}`);
    return JSON.parse(result.stdout.toString());
  },
  list(path, key) {
    const result = Bun.spawnSync(['gh', 'api', '--paginate', '--slurp', path]);
    if (result.exitCode !== 0)
      throw new Error(`GitHub API ${path} failed: ${result.stderr.toString()}`);
    const pages: unknown = JSON.parse(result.stdout.toString());
    if (!Array.isArray(pages) || pages.length === 0) {
      throw new Error(`GitHub API ${path}: expected nonempty paginated array`);
    }
    let expectedCount: number | undefined;
    const items = pages.flatMap((page: unknown) => {
      if (
        !page ||
        typeof page !== 'object' ||
        !(key in page) ||
        !Array.isArray(page[key as keyof typeof page])
      ) {
        throw new Error(
          `GitHub API ${path}: expected page.${key} array; received ${JSON.stringify(page)}`
        );
      }
      const count = 'total_count' in page ? page.total_count : undefined;
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
      return page[key as keyof typeof page] as unknown[];
    });
    if (items.length !== expectedCount) {
      throw new Error(
        `GitHub API ${path}: expected complete ${key} collection (${expectedCount}); received ${items.length}`
      );
    }
    return items;
  },
};

const receipt = qualifyCanarySource(
  {
    repository: requiredEnv('REPO'),
    runId: Number(requiredEnv('SOURCE_RUN_ID')),
    runAttempt: Number(requiredEnv('SOURCE_RUN_ATTEMPT')),
    sourceSha: requiredEnv('SOURCE_SHA'),
    ...(process.env.VERIFIED_PUSH_BEFORE_SHA
      ? { pushBeforeSha: process.env.VERIFIED_PUSH_BEFORE_SHA }
      : {}),
  },
  githubApi
);
writeFileSync(requiredEnv('QUALIFICATION_RECEIPT'), `${JSON.stringify(receipt, null, 2)}\n`);
appendFileSync(
  requiredEnv('GITHUB_OUTPUT'),
  `builder_attempt=${receipt.builderAttempt}\nqualified=true\n`
);
console.log(JSON.stringify(receipt, null, 2));
