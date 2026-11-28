#!/usr/bin/env bun
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { CanaryGitHub } from '../lib/canary-github';
import {
  type ApprovedArtifact,
  type ArtifactEvidence,
  distributionBundleMember,
  validateArtifactEvidence,
} from '../lib/distribution-artifact';
import {
  ARTIFACT_DOWNLOAD_RETRY_POLICY,
  GitHubRetry,
  malformedResponse,
} from '../lib/github-retry';
import { fetchArtifactZip } from '../lib/run-artifact';

/** The reads of `CanaryGitHub` this script needs; tests pass a client over a named fake runner. */
export type ApprovedMetadataReader = Pick<CanaryGitHub, 'getJson' | 'list'>;

/**
 * Read the run, artifact and producing-attempt jobs of an approved distribution
 * through the shared retry client. A status other than 200 fails naming the
 * request and the status received; a 404 is never retried.
 * @example validateArtifactEvidence(approval, await readApprovedEvidence(approval, new CanaryGitHub(repo)));
 */
export async function readApprovedEvidence(
  approval: ApprovedArtifact,
  github: ApprovedMetadataReader
): Promise<ArtifactEvidence> {
  const base = `repos/${approval.repository}/actions`;
  const read = async (what: string, path: string): Promise<unknown> => {
    const response = await github.getJson(path);
    if (response.status !== 200) {
      throw malformedResponse(
        { request: `GET ${path}` },
        `HTTP 200 for ${what}`,
        `HTTP ${response.status} ${JSON.stringify(response.body)}`
      );
    }
    return response.body;
  };
  const run = (await read(
    'approved run metadata',
    `${base}/runs/${approval.runId}/attempts/${approval.runAttempt}`
  )) as ArtifactEvidence['run'];
  const artifact = (await read(
    'approved artifact metadata',
    `${base}/artifacts/${approval.artifactId}`
  )) as ArtifactEvidence['artifact'];
  const jobs = (await github.list(
    `${base}/runs/${approval.runId}/attempts/${approval.producerAttempt}/jobs?per_page=100`,
    'jobs'
  )) as ArtifactEvidence['jobs'];
  return { run, artifact, jobs };
}

async function main(): Promise<void> {
  // The cross-run promotion path deliberately requires unzip (Ubuntu consumers).
  // Same-run consumers go through download-run-artifact.ts, which shares the
  // bounded fetch below.
  const approval: ApprovedArtifact = {
    repository: process.env.GITHUB_REPOSITORY ?? '',
    sourceSha: process.env.SOURCE_SHA ?? '',
    runId: Number(process.env.APPROVED_RUN_ID),
    runAttempt: Number(process.env.APPROVED_RUN_ATTEMPT),
    producerAttempt: Number(process.env.PRODUCER_ATTEMPT),
    artifactId: Number(process.env.ARTIFACT_ID),
    artifactName: process.env.ARTIFACT_NAME ?? '',
    digest: process.env.ARTIFACT_DIGEST ?? '',
  };
  if (process.env.RUNTIME_PROFILE !== 'shipping' || process.env.VERIFY_ATTESTATION !== 'true') {
    throw new Error(
      'Cross-run distribution: expected runtime-profile=shipping and verify-attestation=true'
    );
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(approval.repository)) {
    throw new Error(
      `Distribution repository: expected owner/repo | received ${approval.repository}`
    );
  }
  validateArtifactEvidence(
    approval,
    await readApprovedEvidence(approval, new CanaryGitHub(approval.repository))
  );

  const directory = process.env.DOWNLOAD_DIR;
  if (!directory) throw new Error('DOWNLOAD_DIR: expected download directory | received empty');
  mkdirSync(directory, { recursive: true });
  const archive = join(directory, `artifact-${approval.artifactId}.zip`);
  // Bounded and retried once, and the ZIP bytes must match the approved digest.
  await new GitHubRetry(ARTIFACT_DOWNLOAD_RETRY_POLICY).anyFailure(
    `Artifact ${approval.artifactId}`,
    () =>
      fetchArtifactZip({
        repository: approval.repository,
        artifactId: approval.artifactId,
        digest: approval.digest,
        archive,
      })
  );
  const actual = approval.digest;
  const listing = Bun.spawnSync(['unzip', '-Z1', archive]);
  if (listing.exitCode !== 0)
    throw new Error(`Artifact ${approval.artifactId}: expected readable ZIP`);
  const member = distributionBundleMember(listing.stdout.toString());
  const extract = Bun.spawn(['unzip', '-p', archive, member], {
    stdout: Bun.file(join(directory, member)),
    stderr: 'inherit',
  });
  if ((await extract.exited) !== 0)
    throw new Error(`Artifact ${approval.artifactId}: bundle extraction failed`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `\nApproved distribution: ${approval.repository}@${approval.sourceSha}; run ${approval.runId}, selected attempt ${approval.runAttempt}, producer attempt ${approval.producerAttempt}; artifact ${approval.artifactId} (${approval.artifactName}), ${actual}.\n`
    );
  }
}

if (import.meta.main) await main();
