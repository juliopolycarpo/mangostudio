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

  test('canary identity comes from the release list, not from the npm version', () => {
    const workflow = readText(WORKFLOW_PATH);

    // Canary publishes one release per green commit. Deriving the tag from npm
    // (the old `${npm_version%.*}` strip, for a rolling `v<root>-canary` tag)
    // now names a tag that does not exist, and pinning npm's version as the tag
    // turns a failed GitHub publish into a 404 halfway through the run.
    expect(workflow).toContain('--json tagName,isPrerelease');
    expect(workflow).toContain('asset_version="${release_tag#v}"');
    expect(workflow).toContain('archive_version="$asset_version"');
    expect(workflow).not.toContain('asset_version="${npm_version%.*}"');
    // The canary version the archive reports comes from the tag or, for the
    // frozen release, from its manifest — never parsed back out of release
    // notes, which is what the rolling channel used to do.
    expect(workflow).not.toContain('Canary version:');
  });

  test('asks GitHub to exclude drafts before canary selection', () => {
    const workflow = readText(WORKFLOW_PATH);

    // A newer canary draft has no published assets. The resolver must leave it
    // out before selecting `. [0]`, which is the latest published canary.
    expect(workflow).toContain('gh release list --limit 30 --exclude-drafts');
  });

  test('admits the frozen sha-less canary tag, the way the installers still do', () => {
    const workflow = readText(WORKFLOW_PATH);

    // install.sh, install.ps1 and the hub's release index all accept a canary
    // tag whose sha suffix is absent, because the frozen pre-2026-09 release is
    // one. A resolver that required the dot would call that release unpublished
    // and exit before any lane ran, while every consumer it is meant to mirror
    // kept installing from it.
    const [, resolveStep = ''] = workflow.split('gh release list --limit 30');
    expect(resolveStep).toContain('-canary(\\\\.g?[0-9a-f]{7,40})?$');
    expect(resolveStep).not.toContain('test("-canary\\\\.")');
  });

  test('reads the reported version from the manifest for a sha-less canary tag', () => {
    const workflow = readText(WORKFLOW_PATH);

    // That release's assets carry the bare `<root>-canary` while its binaries
    // report the sha-stamped version, so `archive_version` taken from the tag
    // would fail every `--version` assertion the archive lane makes. Only its
    // manifest records what the bytes call themselves; asset names stay on the
    // tag version, which is what the filenames actually use.
    const [, canaryBranch = ''] = workflow.split('asset_version="${release_tag#v}"');
    expect(canaryBranch).toContain('--pattern canary-manifest.json');
    expect(canaryBranch).toContain(
      'archive_version="$(jq -r \'.version // empty\' legacy-canary-manifest/canary-manifest.json)"'
    );
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
      /health-summary:\n(?:.*\n)*?\s+needs: \[resolve, npm-install, release-archive, install-script\]\n\s+if: \$\{\{ always\(\) \}\}/
    );
  });

  describe('install-script lane', () => {
    test('runs one lane per OS against the pinned identity, with no toolchain setup', () => {
      const workflow = readText(WORKFLOW_PATH);

      expect(workflow).toMatch(/install-script:\n(?:.*\n)*?\s+needs: resolve\n/);
      expect(workflow).toContain('runner: ubuntu-latest');
      expect(workflow).toContain('runner: macos-latest');
      expect(workflow).toContain('runner: windows-latest');
      expect(workflow).toContain('script: install.sh');
      expect(workflow).toContain('script: install.ps1');
    });

    test('a missing script asset is a notice, not a failure', () => {
      const workflow = readText(WORKFLOW_PATH);
      const [, laneBody = ''] = workflow.split(/\n {2}install-script:\n/);
      const [installScriptLane] = laneBody.split(/\n {2}health-summary:\n/);

      // The not-found branch (matched against gh's captured stderr) keeps
      // the step green and records a notice; it never exits non-zero.
      expect(installScriptLane).toMatch(
        /if gh release download "\$RELEASE_TAG" --pattern "\$SCRIPT_NAME"[\s\S]*?else[\s\S]*?if grep -qiE "release not found\|no assets match\|HTTP 404" download-error\.log; then\n\s+echo "No[\s\S]*?GITHUB_STEP_SUMMARY[\s\S]*?SCRIPT_AVAILABLE=false[\s\S]*?fi\n\s+fi/
      );
    });

    test('a gh failure that is not a missing-asset 404 fails the step instead of skipping it', () => {
      const workflow = readText(WORKFLOW_PATH);
      const [, laneBody = ''] = workflow.split(/\n {2}install-script:\n/);
      const [installScriptLane] = laneBody.split(/\n {2}health-summary:\n/);

      // Reproduces the gap: any gh release download failure used to fall
      // straight into the "asset absent" branch — an auth error or rate
      // limit would silently skip the rest of the lane instead of failing
      // it. The else branch's fallback path must exit non-zero.
      expect(installScriptLane).toContain('2>download-error.log');
      expect(installScriptLane).toMatch(
        /else\n\s+echo "gh release download failed for a reason other than a missing asset[\s\S]*?exit 1/
      );
    });

    test('verifies the script against the resolved identity on both shells', () => {
      const workflow = readText(WORKFLOW_PATH);

      expect(workflow).toContain("if: env.SCRIPT_AVAILABLE == 'true' && runner.os != 'Windows'");
      expect(workflow).toContain('bash install-script/install.sh');
      expect(workflow).toContain("if: env.SCRIPT_AVAILABLE == 'true' && runner.os == 'Windows'");
      expect(workflow).toContain('shell: powershell');
      expect(workflow).toContain('install-script\\install.ps1');
      // Canary races the identity resolve pinned; both shells warn instead of
      // failing when --canary/-Canary resolves a newer tag mid-run.
      expect(workflow).toContain('::warning::install.sh resolved canary');
      expect(workflow).toContain('::warning::install.ps1 resolved canary');
    });
  });
});
