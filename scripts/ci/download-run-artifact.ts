#!/usr/bin/env bun
import { downloadRunArtifact } from '../lib/run-artifact';

// Same-run artifact download through the GitHub CLI, replacing
// actions/download-artifact, which has stalled after finishing (#1735).
// Requires `actions: read` on the calling job and GH_TOKEN.
const repository = process.env.GITHUB_REPOSITORY ?? '';
const runId = Number(process.env.GITHUB_RUN_ID);
const name = process.env.ARTIFACT_NAME ?? '';
const destination = process.env.DOWNLOAD_DIR ?? '';
const mode = process.env.EXTRACT_MODE;

if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) {
  throw new Error(`GITHUB_REPOSITORY: expected owner/repo | received ${repository}`);
}
if (!Number.isSafeInteger(runId) || runId < 1) {
  throw new Error(
    `GITHUB_RUN_ID: expected a positive integer | received ${process.env.GITHUB_RUN_ID}`
  );
}
if (name === '') throw new Error('ARTIFACT_NAME: expected an artifact name | received empty');
if (destination === '') throw new Error('DOWNLOAD_DIR: expected a directory | received empty');
if (mode !== 'bundle' && mode !== 'tree') {
  throw new Error(`EXTRACT_MODE: expected bundle | tree | received ${mode}`);
}

await downloadRunArtifact({
  repository,
  runId,
  name,
  destination,
  mode,
  scratchRoot: process.env.RUNNER_TEMP,
});
console.log(`Downloaded run ${runId} artifact ${name} into ${destination}`);
