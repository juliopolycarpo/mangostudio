import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT_DIR } from '../lib/config';
import { readText } from './support/read-text';

// The nightly verifies published distribution bytes (npm, GitHub Release
// archives), not source rebuilds that per-PR CI already covers. These tests pin
// that contract so an edit cannot quietly reintroduce the redundant rebuild
// pattern or let matrix lanes drift onto different channel identities.

const WORKFLOW_PATH = '.github/workflows/nightly-distribution-health.yml';

describe('nightly distribution health workflow', () => {
  test('the redundant extended Windows smoke workflow stays deleted', () => {
    expect(existsSync(join(ROOT_DIR, '.github/workflows/extended.yml'))).toBe(false);
  });

  test('runs on the nightly schedule and manual dispatch only, read-only', () => {
    const workflow = readText(WORKFLOW_PATH);

    expect(workflow).toContain('schedule:');
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).not.toContain('pull_request');
    expect(workflow).toContain('permissions:\n  contents: read');
  });

  test('every lane consumes the identity pinned once by the resolve job', () => {
    const workflow = readText(WORKFLOW_PATH);

    // Lanes depend on resolve and never re-read rolling dist-tags/releases, so
    // a canary publish landing mid-run cannot make the matrix disagree.
    expect(workflow).toMatch(/npm-install:\n(?:.*\n)*?\s+needs: resolve\n/);
    expect(workflow).toMatch(/release-archive:\n(?:.*\n)*?\s+needs: resolve\n/);
    for (const output of ['npm_version', 'release_tag', 'asset_version', 'archive_version']) {
      expect(workflow).toContain(`needs.resolve.outputs.${output}`);
    }
    const [, laneJobs = ''] = workflow.split(/\n {2}npm-install:\n/);
    expect(laneJobs).not.toContain('registry.npmjs.org');
    expect(laneJobs).not.toContain('dist-tags');
  });

  test('archive lanes verify against the SHA256SUMS snapshot pinned at resolve time', () => {
    const workflow = readText(WORKFLOW_PATH);

    expect(workflow).toMatch(/upload-artifact[\s\S]*?name: pinned-checksums/);
    expect(workflow).toMatch(/download-artifact[\s\S]*?name: pinned-checksums/);
    expect(workflow).toContain('pinned-checksums/SHA256SUMS');
  });

  test('uses no build or dependency caches — published bytes only', () => {
    const workflow = readText(WORKFLOW_PATH);

    expect(workflow).not.toContain('actions/cache');
    expect(workflow).not.toContain('setup-mango');
    expect(workflow).not.toContain('bun install');
  });

  test('uploads failure diagnostics only, with bounded retention', () => {
    const workflow = readText(WORKFLOW_PATH);

    expect(workflow).toMatch(
      /if: failure\(\)\n\s+uses: actions\/upload-artifact[\s\S]*?retention-days: 14/
    );
    // The pinned-checksums handoff artifact is functional, not diagnostic;
    // keep it at the 1-day minimum.
    expect(workflow).toMatch(/name: pinned-checksums\n\s+path: [^\n]+\n\s+retention-days: 1\n/);
  });

  test('the summary job always reports every lane result', () => {
    const workflow = readText(WORKFLOW_PATH);

    expect(workflow).toMatch(
      /health-summary:\n(?:.*\n)*?\s+needs: \[resolve, npm-install, release-archive\]\n\s+if: \$\{\{ always\(\) \}\}/
    );
  });
});
