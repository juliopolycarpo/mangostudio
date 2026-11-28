#!/usr/bin/env bun
import { downloadRunArtifact, downloadSourceRunId } from '../lib/run-artifact';

// Run artifact download through the GitHub CLI, replacing actions/download-artifact,
// which has stalled after finishing (#1735). The current run's artifact unless
// ARTIFACT_RUN_ID names another run of this repository.
// Requires `actions: read` on the calling job and GH_TOKEN.
const repository = process.env.GITHUB_REPOSITORY ?? '';
const name = process.env.ARTIFACT_NAME ?? '';
const destination = process.env.DOWNLOAD_DIR ?? '';
const mode = process.env.EXTRACT_MODE;

if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) {
  throw new Error(`GITHUB_REPOSITORY: expected owner/repo | received ${repository}`);
}
const runId = downloadSourceRunId(process.env);
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
