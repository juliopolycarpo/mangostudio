#!/usr/bin/env bun
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  type ApprovedArtifact,
  type ArtifactEvidence,
  distributionBundleMember,
  validateArtifactEvidence,
} from '../lib/distribution-artifact';
import { ARTIFACT_DOWNLOAD_RETRY_POLICY, GitHubRetry } from '../lib/github-retry';
import { fetchArtifactZip } from '../lib/run-artifact';

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
  throw new Error(`Distribution repository: expected owner/repo | received ${approval.repository}`);
}
const base = `repos/${approval.repository}/actions`;
const runResult = Bun.spawnSync([
  'gh',
  'api',
  `${base}/runs/${approval.runId}/attempts/${approval.runAttempt}`,
]);
if (runResult.exitCode !== 0)
  throw new Error(`Approved run metadata request failed: ${runResult.stderr}`);
const artifactResult = Bun.spawnSync(['gh', 'api', `${base}/artifacts/${approval.artifactId}`]);
if (artifactResult.exitCode !== 0)
  throw new Error(`Approved artifact metadata request failed: ${artifactResult.stderr}`);
const jobsResult = Bun.spawnSync([
  'gh',
  'api',
  '--paginate',
  '--slurp',
  `${base}/runs/${approval.runId}/attempts/${approval.producerAttempt}/jobs?per_page=100`,
]);
if (jobsResult.exitCode !== 0)
  throw new Error(`Producing attempt jobs request failed: ${jobsResult.stderr}`);
const run: ArtifactEvidence['run'] = JSON.parse(runResult.stdout.toString());
const artifact: ArtifactEvidence['artifact'] = JSON.parse(artifactResult.stdout.toString());
const jobPages: { jobs: ArtifactEvidence['jobs'] }[] = JSON.parse(jobsResult.stdout.toString());
validateArtifactEvidence(approval, { run, artifact, jobs: jobPages.flatMap((page) => page.jobs) });

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
