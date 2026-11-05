#!/usr/bin/env bun
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { CanaryApprovalAcquisition } from '../lib/canary-approval';
import { canaryApprovalChildFailure } from '../lib/canary-approval-diagnostics';
import {
  parseCanaryApprovalSelection,
  prepareCanaryApproval,
} from '../lib/canary-approval-preparation';
import { CanaryGitHub } from '../lib/canary-github';
import { type CanarySource, selectCanarySource } from '../lib/canary-source';
import type { CanaryValidationReceipt } from '../lib/canary-validation';
import { requiredEnv } from '../lib/runner';

/** This adapter runs existing authenticated acquisition/qualification entrypoints. It performs no audits or publication writes. */
async function main(): Promise<void> {
  const output = resolve(requiredEnv('OUTPUT_DIR'));
  if (/[\r\n\0]/.test(output))
    throw new Error('Invalid OUTPUT_DIR: expected plain filesystem path');
  mkdirSync(output, { recursive: true });
  const repository = requiredEnv('REPO');
  const version = requiredEnv('VERSION');
  const revision = requiredEnv('GITHUB_SHA');
  const selectionRaw = process.env.SELECTION_JSON ?? process.env.SOURCE_OUTPUTS_JSON;
  if (!selectionRaw)
    throw new Error(
      'Missing SELECTION_JSON or SOURCE_OUTPUTS_JSON: expected frozen source job outputs'
    );
  const source = parseCanaryApprovalSelection(selectionRaw, repository, version, revision);
  const childOutputs = join(output, 'child-outputs');
  let qualificationIndex = 0;
  const run = (script: string, env: Record<string, string | undefined>) => {
    const result = Bun.spawnSync({
      cmd: ['bun', script],
      env: {
        ...process.env,
        VERIFIED_PUSH_BEFORE_SHA: undefined,
        ...env,
        GITHUB_OUTPUT: childOutputs,
      },
      stdin: 'ignore',
      timeout: 15 * 60_000,
      maxBuffer: 65 * 1024 * 1024,
    });
    if (result.exitCode !== 0)
      throw new Error(
        canaryApprovalChildFailure(
          script.endsWith('/load-canary-approval.ts') ? 'acquisition' : 'qualification',
          result.exitCode,
          result.stdout,
          result.stderr
        )
      );
  };
  const sourceEnv = (selected: CanarySource) => ({
    REPO: selected.repository,
    SOURCE_SHA: selected.sourceSha,
    SOURCE_RUN_ID: String(selected.runId),
    SOURCE_RUN_ATTEMPT: String(selected.runAttempt),
    SOURCE_RUN_NUMBER: String(selected.runNumber),
    SOURCE_RUN_URL: selected.runUrl,
    WORKFLOW_ID: String(selected.workflowId),
    WORKFLOW_PATH: selected.workflowPath,
  });
  const prepared = await prepareCanaryApproval(
    {
      source,
      version,
      executionRevision: revision,
      producerAttempt: Number(requiredEnv('GITHUB_RUN_ATTEMPT')),
      expectedApprovalSha256: process.env.EXPECTED_APPROVAL_SHA256 || undefined,
    },
    {
      async acquire(selected, selectedVersion, executionRevision, expectedApprovalSha256) {
        const acquiredDir = join(output, 'acquired');
        run('./scripts/ci/load-canary-approval.ts', {
          ...sourceEnv(selected),
          VERSION: selectedVersion,
          GITHUB_SHA: executionRevision,
          EXPECTED_APPROVAL_SHA256: expectedApprovalSha256,
          OUTPUT_DIR: acquiredDir,
        });
        const metadata = JSON.parse(readFileSync(join(acquiredDir, 'acquisition.json'), 'utf8'));
        const acquisition: CanaryApprovalAcquisition = {
          origin: metadata.origin,
          distribution: metadata.distribution,
          receipt: metadata.receipt,
          approvalPointer: metadata.approvalPointer,
          earliestApproval: metadata.earliestApproval,
          manifestRaw: readFileSync(join(acquiredDir, 'distribution-manifest.json'), 'utf8'),
          checksumsBundle: readFileSync(join(acquiredDir, 'promotion-checksums.tar.gz')),
          ...(metadata.receipt
            ? { promotionRaw: readFileSync(join(acquiredDir, 'promotion.json'), 'utf8') }
            : {}),
          ...(metadata.hasApprovalPayload
            ? { approvalPayload: readFileSync(join(acquiredDir, 'approval.tar.gz')) }
            : {}),
          ...(metadata.hasPushContext
            ? { pushContextRaw: readFileSync(join(acquiredDir, 'ci-push-context.json'), 'utf8') }
            : {}),
        };
        return await Promise.resolve(acquisition);
      },
      async qualify(selected, verifiedPushBeforeSha) {
        const identity = await new CanaryGitHub(selected.repository).getJson(
          `repos/${selected.repository}/actions/runs/${selected.runId}/attempts/${selected.runAttempt}`
        );
        if (identity.status !== 200)
          throw new Error(
            `Frozen CI identity unavailable: expected HTTP 200; received ${identity.status}`
          );
        const actual = selectCanarySource(
          [identity.body],
          selected.repository,
          selected.workflowId
        );
        if (
          (Object.keys(selected) as (keyof CanarySource)[]).some(
            (key) => actual[key] !== selected[key]
          )
        )
          throw new Error(
            'Frozen CI identity mismatch: expected exact selected run, attempt, source, workflow, number and URL'
          );
        const receiptPath = join(output, `qualification-${qualificationIndex++}.json`);
        run('./scripts/ci/qualify-canary-source.ts', {
          ...sourceEnv(selected),
          VERIFIED_PUSH_BEFORE_SHA: verifiedPushBeforeSha,
          QUALIFICATION_RECEIPT: receiptPath,
        });
        return await Promise.resolve(
          JSON.parse(readFileSync(receiptPath, 'utf8')) as CanaryValidationReceipt
        );
      },
    }
  );
  const generatedDir = join(output, 'assets');
  mkdirSync(generatedDir, { recursive: true });
  for (const [name, bytes] of prepared.generated) writeFileSync(join(generatedDir, name), bytes);
  writeFileSync(join(output, 'promotion.json'), prepared.promotionRaw);
  writeFileSync(join(output, 'distribution-manifest.json'), prepared.acquisition.manifestRaw);
  writeFileSync(join(output, 'promotion-checksums.tar.gz'), prepared.acquisition.checksumsBundle);
  rmSync(join(output, 'ci-push-context.json'), { force: true });
  if (prepared.acquisition.pushContextRaw !== undefined)
    writeFileSync(join(output, 'ci-push-context.json'), prepared.acquisition.pushContextRaw);
  writeFileSync(join(output, 'approval.tar.gz'), prepared.approvalPayload);
  writeFileSync(join(output, 'expected-release.json'), prepared.expectedRaw);
  writeFileSync(join(output, 'qualification-current.json'), json(prepared.currentQualification));
  writeFileSync(join(output, 'qualification-original.json'), json(prepared.originalQualification));
  const {
    checksumsBundle: _bundle,
    approvalPayload: _payload,
    ...acquisitionMetadata
  } = prepared.acquisition;
  writeFileSync(join(output, 'acquisition.json'), json(acquisitionMetadata));
  const metadata = {
    origin: prepared.acquisition.origin,
    source,
    currentExecutionRevision: revision,
    receipt: prepared.receipt,
    approvalPayloadSha256: prepared.payloadSha256,
    approvalArtifactName: prepared.artifactName,
    expectedReleaseSha256: prepared.expectedSha256,
    approvalPointer: prepared.acquisition.approvalPointer,
    earliestApproval: prepared.acquisition.earliestApproval,
  };
  writeFileSync(join(output, 'preparation.json'), json(metadata));
  const outputs = [
    `qualification_json=${JSON.stringify({ current: prepared.currentQualification, original: prepared.originalQualification })}`,
    `approval_origin=${prepared.acquisition.origin}`,
    `approval_payload_sha256=${prepared.payloadSha256}`,
    `approval_artifact_name=${prepared.artifactName}`,
    `expected_release_sha256=${prepared.expectedSha256}`,
    `approval_path=${join(output, 'approval.tar.gz')}`,
    `expected_release_path=${join(output, 'expected-release.json')}`,
    `generated_assets_dir=${generatedDir}`,
    `preparation_path=${join(output, 'preparation.json')}`,
    `acquisition_path=${join(output, 'acquisition.json')}`,
    `builder_attempt=${prepared.receipt.distribution.checksums.producerAttempt}`,
    `built_at=${prepared.receipt.distribution.builtAt}`,
    `approved_run_id=${prepared.receipt.selectedRun.runId}`,
    `approved_run_attempt=${prepared.receipt.selectedRun.runAttempt}`,
    `approved_run_number=${prepared.receipt.selectedRun.runNumber}`,
    `approved_run_url=${prepared.receipt.selectedRun.runUrl}`,
    `approved_workflow_id=${prepared.receipt.selectedRun.workflowId}`,
    `approved_workflow_path=${prepared.receipt.selectedRun.workflowPath}`,
    `approval_execution_revision=${prepared.receipt.workflowRevision}`,
    `manifest_sha256=${prepared.receipt.manifestSha256}`,
  ];
  for (const scope of ['checksums', 'assets', 'npm'] as const) {
    const item = prepared.receipt.distribution[scope];
    outputs.push(
      `${scope}_id=${item.artifactId}`,
      `${scope}_name=${item.artifactName}`,
      `${scope}_digest=${item.digest}`
    );
  }
  if (prepared.acquisition.approvalPointer) {
    const pointer = prepared.acquisition.approvalPointer;
    outputs.push(
      `approval_artifact_id=${pointer.artifactId}`,
      `approval_artifact_digest=${pointer.artifactDigest}`,
      `approval_run_id=${pointer.runId}`,
      `approval_producer_attempt=${pointer.producerAttempt}`
    );
  }
  appendFileSync(requiredEnv('GITHUB_OUTPUT'), `${outputs.join('\n')}\n`);
  console.log(json(metadata));
}
function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
if (import.meta.main) {
  try {
    await main();
  } catch (caught) {
    console.error(caught instanceof Error ? caught.message : String(caught));
    process.exitCode = 1;
  }
}
