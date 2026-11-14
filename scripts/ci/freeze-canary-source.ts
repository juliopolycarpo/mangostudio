#!/usr/bin/env bun
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { CanaryGitHub } from '../lib/canary-github';
import {
  type CanarySourceResolution,
  resolveCanarySourceSnapshot,
  writeCanarySourceSnapshot,
} from '../lib/canary-source-snapshot';
import { requiredEnv } from '../lib/runner';

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode !== 'resolve' && mode !== 'write')
    throw new Error(`Invalid source snapshot mode ${mode}: expected resolve or write`);
  const selectionPath = plainPath(requiredEnv('SELECTION_PATH'));
  const snapshotPath = plainPath(requiredEnv('SNAPSHOT_PATH'));
  if (selectionPath === snapshotPath || basename(snapshotPath) !== 'source.json')
    throw new Error(
      'Source snapshot paths: expected distinct selection file and source.json basename'
    );
  mkdirSync(dirname(selectionPath), { recursive: true });
  mkdirSync(dirname(snapshotPath), { recursive: true });
  if (mode === 'write') {
    const selection: CanarySourceResolution = JSON.parse(readFileSync(selectionPath, 'utf8'));
    const completed = writeCanarySourceSnapshot(selection, {
      sourceSha: requiredEnv('SOURCE_SHA'),
      version: requiredEnv('VERSION'),
      channel: requiredEnv('CHANNEL'),
      executionRevision: requiredEnv('GITHUB_SHA'),
    });
    rmSync(snapshotPath, { force: true });
    writeFileSync(snapshotPath, completed.raw);
    appendFileSync(
      requiredEnv('GITHUB_OUTPUT'),
      `version=${completed.snapshot.version}\nchannel=${completed.snapshot.channel}\nsource_snapshot_path=${snapshotPath}\n`
    );
    return;
  }
  const scratch = mkdtempSync(join(tmpdir(), 'fix-canary-source-snapshot-'));
  try {
    const repository = requiredEnv('REPO');
    const github = new CanaryGitHub(repository, {
      run(args) {
        const result = Bun.spawnSync({
          cmd: ['gh', ...args],
          stdin: 'ignore',
          timeout: 15 * 60_000,
          maxBuffer: 65 * 1024 * 1024,
        });
        return {
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr.toString(),
        };
      },
    });
    const result = await resolveCanarySourceSnapshot(
      {
        repository,
        runId: Number(requiredEnv('GITHUB_RUN_ID')),
        runAttempt: Number(requiredEnv('GITHUB_RUN_ATTEMPT')),
        executionRevision: requiredEnv('GITHUB_SHA'),
      },
      {
        github,
        now: () => new Date(),
        async unzip(bytes) {
          const file = join(scratch, 'source.zip');
          writeFileSync(file, bytes);
          const listing = Bun.spawnSync({
            cmd: ['unzip', '-Z1', file],
            stdin: 'ignore',
            timeout: 60_000,
            maxBuffer: 1024 * 1024,
          });
          if (
            listing.exitCode !== 0 ||
            listing.stdout.toString().replace(/\r?\n$/, '') !== 'source.json'
          )
            throw new Error('Invalid source snapshot ZIP: expected sole source.json');
          const extracted = Bun.spawnSync({
            cmd: ['unzip', '-p', file, 'source.json'],
            stdin: 'ignore',
            timeout: 60_000,
            maxBuffer: 1024 * 1024,
          });
          if (extracted.exitCode !== 0)
            throw new Error('Invalid source snapshot ZIP: expected bounded readable source.json');
          return await Promise.resolve(new Map([['source.json', extracted.stdout]]));
        },
      },
      {
        runId: process.env.RECOVER_SOURCE_RUN_ID,
        runAttempt: process.env.RECOVER_SOURCE_ATTEMPT,
        approvalSha256: process.env.RECOVER_APPROVAL_SHA256,
      }
    );
    writeFileSync(selectionPath, `${JSON.stringify(result, null, 2)}\n`);
    rmSync(snapshotPath, { force: true });
    if (result.snapshotRaw !== undefined) writeFileSync(snapshotPath, result.snapshotRaw);
    const outputs = [
      `sha=${result.source.sourceSha}`,
      `run_id=${result.source.runId}`,
      `run_attempt=${result.source.runAttempt}`,
      `run_number=${result.source.runNumber}`,
      `run_url=${result.source.runUrl}`,
      `workflow_id=${result.source.workflowId}`,
      `workflow_path=${result.source.workflowPath}`,
      `repository=${result.source.repository}`,
      `source_restored=${result.restored}`,
      `selection_path=${selectionPath}`,
      `source_snapshot_path=${snapshotPath}`,
    ];
    if (result.snapshotRaw !== undefined) {
      const snapshot = JSON.parse(result.snapshotRaw) as { version: string; channel: string };
      outputs.push(`version=${snapshot.version}`, `channel=${snapshot.channel}`);
    }
    if (result.expectedApprovalSha256 !== undefined)
      outputs.push(`expected_approval_sha256=${result.expectedApprovalSha256}`);
    if (result.originalAttempt !== undefined)
      outputs.push(`original_source_attempt=${result.originalAttempt}`);
    appendFileSync(requiredEnv('GITHUB_OUTPUT'), `${outputs.join('\n')}\n`);
    console.log(
      JSON.stringify(
        {
          source: result.source,
          restored: result.restored,
          originalAttempt: result.originalAttempt,
        },
        null,
        2
      )
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
function plainPath(value: string): string {
  if (/[\r\n\0]/.test(value))
    throw new Error('Invalid snapshot path: expected plain filesystem path');
  return resolve(value);
}
if (import.meta.main) {
  try {
    await main();
  } catch (caught) {
    console.error(caught instanceof Error ? caught.message : String(caught));
    process.exitCode = 1;
  }
}
