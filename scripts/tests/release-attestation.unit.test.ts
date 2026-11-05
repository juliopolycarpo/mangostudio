import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT_DIR } from '../lib/config';

const readWorkflow = (name: string): string =>
  readFileSync(join(ROOT_DIR, '.github', 'workflows', name), 'utf8');

const ATTEST_ACTION = 'actions/attest-build-provenance@';

/**
 * A job's block: from its `  <id>:` line to the next job at the same indent.
 */
function jobBlock(workflow: string, jobId: string): string {
  const start = workflow.indexOf(`\n  ${jobId}:\n`);
  expect(start).toBeGreaterThan(-1);
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

describe('release provenance for checksums and install scripts', () => {
  test('the stable release attests SHA256SUMS and both install scripts before publishing', () => {
    const job = jobBlock(readWorkflow('release.yml'), 'github-release');
    expect(job).toContain(ATTEST_ACTION);
    expect(job).toContain('release-assets/SHA256SUMS');
    expect(job).toContain('release-assets/install.sh');
    expect(job).toContain('release-assets/install.ps1');
    expect(job).toContain('attestations: write');
    expect(job).toContain('id-token: write');
    // Attest what is about to be uploaded, not something staged afterwards.
    expect(job.indexOf(ATTEST_ACTION)).toBeLessThan(job.indexOf('publish_release'));
  });

  test('each canary release attests the same subjects from the staged set', () => {
    const job = jobBlock(readWorkflow('canary.yml'), 'github-release-canary');
    expect(job).toContain(ATTEST_ACTION);
    expect(job).toContain('github-canary-assets/SHA256SUMS');
    expect(job).toContain('github-canary-assets/install.sh');
    expect(job).toContain('github-canary-assets/install.ps1');
    expect(job).toContain('attestations: write');
    expect(job).toContain('id-token: write');
    const stage = job.indexOf('stage-approved-canary.ts');
    const attest = job.indexOf(ATTEST_ACTION);
    const publish = job.indexOf('publish-canary.ts');
    for (const index of [stage, attest, publish]) expect(index).toBeGreaterThan(-1);
    expect(stage).toBeLessThan(attest);
    expect(attest).toBeLessThan(publish);
  });

  test('canary approval attests the original archive before reserving its version', () => {
    const job = jobBlock(readWorkflow('canary.yml'), 'approve');
    expect(job).toContain('attestations: write');
    expect(job).toContain('id-token: write');
    expect(job).toContain('.canary-approval/approval.tar.gz');
    expect(job).toContain('.canary-approval/assets/SHA256SUMS');
    const prepare = job.indexOf('prepare-canary-approval.ts');
    const attest = job.indexOf(ATTEST_ACTION);
    const reserve = job.indexOf('id: reservation');
    for (const index of [prepare, attest, reserve]) expect(index).toBeGreaterThan(-1);
    expect(prepare).toBeLessThan(attest);
    expect(attest).toBeLessThan(reserve);
  });
});
