#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { type CanaryApprovalDependencies, loadCanaryApproval } from '../lib/canary-approval';
import { CanaryGitHub } from '../lib/canary-github';
import type { CanaryDistribution } from '../lib/canary-promotion';
import type { CanarySource } from '../lib/canary-source';
import { requiredEnv } from '../lib/runner';

async function main(): Promise<void> {
  const source: CanarySource = {
    repository: requiredEnv('REPO'),
    sourceSha: requiredEnv('SOURCE_SHA'),
    runId: Number(requiredEnv('SOURCE_RUN_ID')),
    runAttempt: Number(requiredEnv('SOURCE_RUN_ATTEMPT')),
    runNumber: Number(requiredEnv('SOURCE_RUN_NUMBER')),
    runUrl: requiredEnv('SOURCE_RUN_URL'),
    workflowId: Number(requiredEnv('WORKFLOW_ID')),
    workflowPath: requiredEnv('WORKFLOW_PATH'),
  };
  const outputArg = requiredEnv('OUTPUT_DIR');
  if (/[\r\n\0]/.test(outputArg))
    throw new Error('Invalid OUTPUT_DIR: expected plain filesystem path');
  const output = resolve(outputArg);
  mkdirSync(output, { recursive: true });
  const scratch = mkdtempSync(join(tmpdir(), 'fix-canary-approval-acquisition-'));
  let sequence = 0;
  const run = (args: readonly string[]) =>
    Bun.spawnSync({
      cmd: [...args],
      stdin: 'ignore',
      timeout: 15 * 60_000,
      maxBuffer: 65 * 1024 * 1024,
    });
  const github = new CanaryGitHub(source.repository, {
    run(args) {
      const result = run(['gh', ...args]);
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr.toString() };
    },
  });
  const deps: CanaryApprovalDependencies = {
    github,
    async verifyAttestation(bytes, policy) {
      const file = join(scratch, `subject-${sequence++}.bin`);
      writeFileSync(file, bytes);
      const result = run([
        'gh',
        'attestation',
        'verify',
        file,
        '--repo',
        source.repository,
        '--signer-workflow',
        `${source.repository}/.github/workflows/${policy.workflow}`,
        '--source-digest',
        policy.sourceSha,
        '--source-ref',
        policy.sourceRef,
        '--signer-digest',
        policy.signerSha,
      ]);
      if (result.exitCode !== 0)
        throw new Error(
          `Approval provenance refused: expected ${policy.workflow} from ${policy.sourceRef}@${policy.sourceSha}`
        );
      await Promise.resolve();
    },
    async unzip(bytes) {
      const file = join(scratch, `approval-${sequence++}.zip`);
      writeFileSync(file, bytes);
      const listing = run(['unzip', '-Z1', file]);
      if (listing.exitCode !== 0)
        throw new Error('Invalid approval ZIP: expected readable archive');
      const names = listing.stdout
        .toString()
        .replace(/\r?\n$/, '')
        .split(/\r?\n/);
      if (names.length !== 1 || names[0] !== 'approval.tar.gz')
        throw new Error('Invalid approval ZIP: expected sole flat approval.tar.gz');
      const unpacked = run(['unzip', '-p', file, 'approval.tar.gz']);
      if (unpacked.exitCode !== 0 || unpacked.stdout.byteLength > 64 * 1024 * 1024)
        throw new Error('Invalid approval ZIP: expected bounded approval.tar.gz payload');
      return await Promise.resolve(new Map([['approval.tar.gz', unpacked.stdout]]));
    },
    async resolveDistribution(selected, version) {
      const identity = await github.getJson(
        `repos/${selected.repository}/actions/runs/${selected.runId}/attempts/${selected.runAttempt}`
      );
      const actual = identity.body;
      if (
        identity.status !== 200 ||
        !actual ||
        typeof actual !== 'object' ||
        !('workflow_id' in actual) ||
        !('run_number' in actual) ||
        !('path' in actual) ||
        !('html_url' in actual) ||
        actual.workflow_id !== selected.workflowId ||
        actual.run_number !== selected.runNumber ||
        actual.path !== selected.workflowPath ||
        actual.html_url !== selected.runUrl
      )
        throw new Error(
          'Frozen CI identity mismatch: expected selected workflow, run number and URL'
        );
      const planPath = join(scratch, 'ci-plan.json');
      const outputs = join(scratch, 'ci-outputs');
      const result = Bun.spawnSync({
        cmd: ['bun', './scripts/ci/resolve-canary-distribution.ts'],
        stdin: 'ignore',
        timeout: 15 * 60_000,
        maxBuffer: 65 * 1024 * 1024,
        env: {
          ...process.env,
          REPO: selected.repository,
          SOURCE_SHA: selected.sourceSha,
          SOURCE_RUN_ID: String(selected.runId),
          SOURCE_RUN_ATTEMPT: String(selected.runAttempt),
          VERSION: version,
          PLAN_PATH: planPath,
          GITHUB_OUTPUT: outputs,
        },
      });
      if (result.exitCode !== 0)
        throw new Error(
          'Original CI distribution unavailable: immutable metadata resolution failed; recover original approved bytes or publish the next source version'
        );
      return await Promise.resolve(
        JSON.parse(readFileSync(planPath, 'utf8')) as CanaryDistribution
      );
    },
    async downloadCiChecksums(distribution) {
      const approval = distribution.checksums;
      const directory = join(scratch, 'ci-checksums');
      const result = Bun.spawnSync({
        cmd: ['bun', './scripts/ci/download-approved-distribution.ts'],
        stdin: 'ignore',
        timeout: 15 * 60_000,
        maxBuffer: 65 * 1024 * 1024,
        env: {
          ...process.env,
          GITHUB_REPOSITORY: approval.repository,
          SOURCE_SHA: approval.sourceSha,
          APPROVED_RUN_ID: String(approval.runId),
          APPROVED_RUN_ATTEMPT: String(approval.runAttempt),
          PRODUCER_ATTEMPT: String(approval.producerAttempt),
          ARTIFACT_ID: String(approval.artifactId),
          ARTIFACT_NAME: approval.artifactName,
          ARTIFACT_DIGEST: approval.digest,
          RUNTIME_PROFILE: 'shipping',
          VERIFY_ATTESTATION: 'true',
          DOWNLOAD_DIR: directory,
        },
      });
      if (result.exitCode !== 0)
        throw new Error(
          'Original CI checksums unavailable or invalid: recover approved artifact bytes; rebuilding a partial version is forbidden'
        );
      const bundles = readdirSync(directory).filter((name) => /\.tar(?:\.gz)?$/.test(name));
      if (bundles.length !== 1 || !bundles[0])
        throw new Error('CI checksum download: expected sole verified bundle');
      return await Bun.file(join(directory, bundles[0])).bytes();
    },
  };
  try {
    const acquisition = await loadCanaryApproval(
      source,
      requiredEnv('VERSION'),
      requiredEnv('GITHUB_SHA'),
      deps,
      process.env.EXPECTED_APPROVAL_SHA256 || undefined
    );
    for (const name of [
      'promotion.json',
      'approval.tar.gz',
      'promotion-checksums.tar.gz',
      'distribution-manifest.json',
      'ci-push-context.json',
      'acquisition.json',
    ])
      rmSync(join(output, name), { force: true });
    writeFileSync(join(output, 'promotion-checksums.tar.gz'), acquisition.checksumsBundle);
    writeFileSync(join(output, 'distribution-manifest.json'), acquisition.manifestRaw);
    if (acquisition.pushContextRaw !== undefined)
      writeFileSync(join(output, 'ci-push-context.json'), acquisition.pushContextRaw);
    if (acquisition.receipt)
      writeFileSync(
        join(output, 'promotion.json'),
        acquisition.promotionRaw ?? `${JSON.stringify(acquisition.receipt, null, 2)}\n`
      );
    if (acquisition.approvalPayload)
      writeFileSync(join(output, 'approval.tar.gz'), acquisition.approvalPayload);
    const metadata = {
      origin: acquisition.origin,
      distribution: acquisition.distribution,
      receipt: acquisition.receipt,
      approvalPointer: acquisition.approvalPointer,
      earliestApproval: acquisition.earliestApproval,
      hasApprovalPayload: acquisition.approvalPayload !== undefined,
      hasPushContext: acquisition.pushContextRaw !== undefined,
      manifestSha256: createHash('sha256').update(acquisition.manifestRaw).digest('hex'),
    };
    writeFileSync(join(output, 'acquisition.json'), `${JSON.stringify(metadata, null, 2)}\n`);
    const outputs = [
      `approval_origin=${acquisition.origin}`,
      `acquisition_path=${join(output, 'acquisition.json')}`,
      `builder_attempt=${acquisition.distribution.checksums.producerAttempt}`,
      `built_at=${acquisition.distribution.builtAt}`,
    ];
    for (const scope of ['checksums', 'assets', 'npm'] as const) {
      const item = acquisition.distribution[scope];
      outputs.push(
        `${scope}_id=${item.artifactId}`,
        `${scope}_name=${item.artifactName}`,
        `${scope}_digest=${item.digest}`
      );
    }
    if (acquisition.approvalPayload)
      outputs.push(
        `approval_payload_sha256=${createHash('sha256').update(acquisition.approvalPayload).digest('hex')}`
      );
    if (acquisition.approvalPointer) {
      const pointer = acquisition.approvalPointer;
      outputs.push(
        `approval_artifact_id=${pointer.artifactId}`,
        `approval_artifact_digest=${pointer.artifactDigest}`,
        `approval_run_id=${pointer.runId}`,
        `approval_producer_attempt=${pointer.producerAttempt}`,
        `approval_execution_revision=${pointer.executionRevision}`
      );
    }
    appendFileSync(requiredEnv('GITHUB_OUTPUT'), `${outputs.join('\n')}\n`);
    console.log(JSON.stringify(metadata, null, 2));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
if (import.meta.main) {
  try {
    await main();
  } catch (caught) {
    console.error(caught instanceof Error ? caught.message : String(caught));
    process.exitCode = 1;
  }
}
