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
    expect(job.indexOf(ATTEST_ACTION)).toBeLessThan(job.indexOf('create_or_update_release'));
  });

  test('the rolling canary attests the same subjects from the staged set', () => {
    const job = jobBlock(readWorkflow('canary.yml'), 'github-release-canary');
    expect(job).toContain(ATTEST_ACTION);
    expect(job).toContain('github-canary-assets/SHA256SUMS');
    expect(job).toContain('github-canary-assets/install.sh');
    expect(job).toContain('github-canary-assets/install.ps1');
    expect(job).toContain('attestations: write');
    expect(job).toContain('id-token: write');
    expect(job.indexOf('stage-canary-assets.ts')).toBeLessThan(job.indexOf(ATTEST_ACTION));
    expect(job.indexOf(ATTEST_ACTION)).toBeLessThan(job.indexOf('create_or_update_release'));
  });

  test("ci.yml's canary caller grants the ceiling the called workflow needs", () => {
    const job = jobBlock(readWorkflow('ci.yml'), 'canary');
    expect(job).toContain('attestations: write');
    expect(job).toContain('id-token: write');
  });
});
