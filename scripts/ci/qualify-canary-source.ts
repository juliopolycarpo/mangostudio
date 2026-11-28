#!/usr/bin/env bun
import { appendFileSync, writeFileSync } from 'node:fs';

import { type CanaryGhReadApi, createCanaryGhApi } from '../lib/canary-gh-api';
import {
  type CanaryValidationReceipt,
  type CanaryValidationSource,
  qualifyCanarySource,
} from '../lib/canary-validation';
import { requiredEnv } from '../lib/runner';

/** Where the receipt goes: a JSON file and the step's `GITHUB_OUTPUT`. */
export interface QualificationFiles {
  readonly receiptPath: string;
  readonly githubOutputPath: string;
}

/**
 * Qualify the frozen CI run through `api`, then write the receipt and the step
 * outputs. Nothing is written when a read fails.
 * @example qualifyCanarySourceToFiles(source, files, createCanaryGhApi());
 */
export function qualifyCanarySourceToFiles(
  source: CanaryValidationSource,
  files: QualificationFiles,
  api: CanaryGhReadApi
): CanaryValidationReceipt {
  const receipt = qualifyCanarySource(source, api);
  writeFileSync(files.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  appendFileSync(
    files.githubOutputPath,
    `builder_attempt=${receipt.builderAttempt}\nqualified=true\n`
  );
  return receipt;
}

if (import.meta.main) {
  // One client for the process: the dozens of reads spend one retry wait budget.
  const receipt = qualifyCanarySourceToFiles(
    {
      repository: requiredEnv('REPO'),
      runId: Number(requiredEnv('SOURCE_RUN_ID')),
      runAttempt: Number(requiredEnv('SOURCE_RUN_ATTEMPT')),
      sourceSha: requiredEnv('SOURCE_SHA'),
      ...(process.env.VERIFIED_PUSH_BEFORE_SHA
        ? { pushBeforeSha: process.env.VERIFIED_PUSH_BEFORE_SHA }
        : {}),
    },
    {
      receiptPath: requiredEnv('QUALIFICATION_RECEIPT'),
      githubOutputPath: requiredEnv('GITHUB_OUTPUT'),
    },
    createCanaryGhApi()
  );
  console.log(JSON.stringify(receipt, null, 2));
}
