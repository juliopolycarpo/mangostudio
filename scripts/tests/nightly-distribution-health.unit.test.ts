import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT_DIR } from '../lib/config';
import { readText } from './support/read-text';
import {
  extractJobBlock,
  extractJobBlocks,
  extractOnBlock,
  extractStepBlock,
  extractStepBlocks,
  extractTopLevelBlock,
  parseNeedsList,
  sectionKeys,
} from './support/workflow-blocks';

// The nightly verifies published distribution bytes (npm, GitHub Release
// archives), not source rebuilds that per-PR CI already covers. These tests pin
// that contract so an edit cannot quietly reintroduce the redundant rebuild
// pattern or let matrix lanes drift onto different channel identities.
//
// Assertions name the job or step that must carry a line and read that block,
// because several jobs here repeat the same runner, env and artifact lines: a
// whole-file match would stay green after the line left the job it guards.

const WORKFLOW_PATH = '.github/workflows/nightly-distribution-health.yml';
const IDENTITY_STEP = 'Pin one immutable identity for every lane';
const LINUX_STEP = 'Run the install script and verify its own report (Linux/macOS)';
const WINDOWS_STEP = 'Run the install script and verify its own report (Windows)';

const resolveStep = (workflow: string, name: string) =>
  extractStepBlock(extractJobBlock(workflow, 'resolve'), name);
const installScriptStep = (workflow: string, name: string) =>
  extractStepBlock(extractJobBlock(workflow, 'install-script'), name);

/** Returns the `run:` body of the Windows install-script step, failing loudly when it is absent. */
function windowsRunBlock(workflow: string): string {
  const [, body = ''] = installScriptStep(workflow, WINDOWS_STEP).split('        run: |\n');
  if (!body.includes('install.ps1')) {
    throw new Error(
      `(nightly workflow): expected Windows step "${WINDOWS_STEP}" with a run block invoking install.ps1 | received: ${body.length} bytes`
    );
  }
  return body;
}

describe('nightly distribution health workflow', () => {
  test('the redundant extended Windows smoke workflow stays deleted', () => {
    expect(existsSync(join(ROOT_DIR, '.github/workflows/extended.yml'))).toBe(false);
  });

  test('runs on the nightly schedule and manual dispatch only, read-only', () => {
    const workflow = readText(WORKFLOW_PATH);

    expect(sectionKeys(extractOnBlock(workflow))).toEqual(['schedule', 'workflow_dispatch']);
    expect(workflow).not.toContain('pull_request');
    const permissions = extractTopLevelBlock(workflow, 'permissions');
    expect(sectionKeys(permissions)).toEqual(['contents']);
    expect(permissions).toMatch(/^ {2}contents: read$/m);
  });

  test('every lane consumes the identity pinned once by the resolve job', () => {
    const workflow = readText(WORKFLOW_PATH);

    // Lanes depend on resolve and never re-read rolling dist-tags/releases, so
    // a canary publish landing mid-run cannot make the matrix disagree. Each
    // lane must name the outputs it uses in its own block: the same expression
    // appearing in a sibling lane does not wire this one.
    const outputsByLane = {
      'npm-install': ['npm_version', 'stable_version'],
      'release-archive': ['release_tag', 'asset_version', 'archive_version'],
      'install-script': ['release_tag', 'asset_version', 'archive_version', 'channel'],
    };
    for (const [lane, outputs] of Object.entries(outputsByLane)) {
      const block = extractJobBlock(workflow, lane);
      expect(block, `${lane} needs`).toMatch(/^ {4}needs: resolve$/m);
      for (const output of outputs) {
        expect(block, `${lane} reads resolve output ${output}`).toContain(
          `needs.resolve.outputs.${output}`
        );
      }
    }
    for (const { job, block } of extractJobBlocks(workflow)) {
      if (job === 'resolve') continue;
      expect(block, `${job} re-reads the registry`).not.toContain('registry.npmjs.org');
      expect(block, `${job} re-reads dist-tags`).not.toContain('dist-tags');
    }
  });

  test('canary identity comes from the release list, not from the npm version', () => {
    const workflow = readText(WORKFLOW_PATH);
    const identity = resolveStep(workflow, IDENTITY_STEP);

    // Canary publishes one release per green commit. Deriving the tag from npm
    // (the old `${npm_version%.*}` strip, for a rolling `v<root>-canary` tag)
    // now names a tag that does not exist, and pinning npm's version as the tag
    // turns a failed GitHub publish into a 404 halfway through the run.
    expect(identity).toContain('--json tagName,isPrerelease');
    // eslint-disable-next-line no-template-curly-in-string -- GitHub expressions and shell placeholders are literal fixture input.
    expect(identity).toContain('asset_version="${release_tag#v}"');
    expect(identity).toContain('archive_version="$asset_version"');
    // eslint-disable-next-line no-template-curly-in-string -- GitHub expressions and shell placeholders are literal fixture input.
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
    expect(resolveStep(workflow, IDENTITY_STEP)).toContain(
      'gh release list --limit 30 --exclude-drafts'
    );
  });

  test('admits the frozen sha-less canary tag, the way the installers still do', () => {
    const workflow = readText(WORKFLOW_PATH);

    // install.sh, install.ps1 and the hub's release index all accept a canary
    // tag whose sha suffix is absent, because the frozen pre-2026-09 release is
    // one. A resolver that required the dot would call that release unpublished
    // and exit before any lane ran, while every consumer it is meant to mirror
    // kept installing from it.
    const [, resolver = ''] = resolveStep(workflow, IDENTITY_STEP).split(
      'gh release list --limit 30'
    );
    expect(resolver).toContain('-canary(\\\\.g?[0-9a-f]{7,40})?$');
    expect(resolver).not.toContain('test("-canary\\\\.")');
  });

  test('reads the reported version from the manifest for a sha-less canary tag', () => {
    const workflow = readText(WORKFLOW_PATH);

    // That release's assets carry the bare `<root>-canary` while its binaries
    // report the sha-stamped version, so `archive_version` taken from the tag
    // would fail every `--version` assertion the archive lane makes. Only its
    // manifest records what the bytes call themselves; asset names stay on the
    // tag version, which is what the filenames actually use.
    const [, canaryBranch = ''] = resolveStep(workflow, IDENTITY_STEP).split(
      // eslint-disable-next-line no-template-curly-in-string -- GitHub expressions and shell placeholders are literal fixture input.
      'asset_version="${release_tag#v}"'
    );
    expect(canaryBranch).toContain('--pattern canary-manifest.json');
    expect(canaryBranch).toContain(
      'archive_version="$(jq -r \'.version // empty\' legacy-canary-manifest/canary-manifest.json)"'
    );
  });

  test('archive lanes verify against the SHA256SUMS snapshot pinned at resolve time', () => {
    const workflow = readText(WORKFLOW_PATH);

    const upload = resolveStep(workflow, 'Pin the SHA256SUMS snapshot for the archive lanes');
    expect(upload).toMatch(/^ {8}uses: actions\/upload-artifact@/m);
    expect(upload).toMatch(/^ {10}name: pinned-checksums$/m);
    expect(upload).toContain('path: pinned-checksums/SHA256SUMS');

    const archiveLane = extractJobBlock(workflow, 'release-archive');
    const download = extractStepBlock(archiveLane, 'Download the pinned SHA256SUMS snapshot');
    expect(download).toMatch(/^ {8}uses: actions\/download-artifact@/m);
    expect(download).toMatch(/^ {10}name: pinned-checksums$/m);
    expect(
      extractStepBlock(archiveLane, 'Verify the archive against the pinned checksums')
    ).toContain('pinned-checksums/SHA256SUMS');
  });

  test('uses no build or dependency caches — published bytes only', () => {
    const workflow = readText(WORKFLOW_PATH);

    expect(workflow).not.toContain('actions/cache');
    expect(workflow).not.toContain('setup-mango');
    expect(workflow).not.toContain('bun install');
  });

  test('uploads failure diagnostics only, with bounded retention', () => {
    const workflow = readText(WORKFLOW_PATH);

    const diagnostics = extractStepBlock(
      extractJobBlock(workflow, 'npm-install'),
      'Upload npm failure diagnostics'
    );
    expect(diagnostics).toMatch(/^ {8}if: failure\(\)$/m);
    expect(diagnostics).toMatch(/^ {10}retention-days: 14$/m);
    // The pinned-checksums handoff artifact is functional, not diagnostic;
    // keep it at the 1-day minimum.
    expect(resolveStep(workflow, 'Pin the SHA256SUMS snapshot for the archive lanes')).toMatch(
      /^ {10}retention-days: 1$/m
    );
    // Any other upload is diagnostic and must be failure-only.
    const uploads = extractJobBlocks(workflow).flatMap(({ job, block }) =>
      extractStepBlocks(block)
        .filter((step) => step.includes('actions/upload-artifact@'))
        .map((step) => ({ job, step }))
    );
    expect(uploads.length, 'upload-artifact steps found').toBeGreaterThanOrEqual(2);
    for (const { job, step } of uploads) {
      if (job !== 'resolve') expect(step, `${job} upload`).toMatch(/^ {8}if: failure\(\)$/m);
    }
  });

  test('the summary job always reports every lane result', () => {
    const summary = extractJobBlock(readText(WORKFLOW_PATH), 'health-summary');

    expect(parseNeedsList(summary)).toEqual([
      'resolve',
      'npm-install',
      'release-archive',
      'install-script',
    ]);
    expect(summary).toMatch(/^ {4}if: \$\{\{ always\(\) \}\}$/m);
  });

  describe('install-script lane', () => {
    test('keeps the Windows PowerShell run block safe to decode without a UTF-8 BOM', () => {
      const workflow = readText(WORKFLOW_PATH);
      const body = windowsRunBlock(workflow);

      expect(body).toContain('install-script\\install.ps1');
      // Actions writes this temporary .ps1 without a BOM. Windows PowerShell
      // 5.1 reads it as ANSI: an UTF-8 em dash becomes a smart closing quote
      // under Windows-1252 and terminates the warning string prematurely.
      expect([...Buffer.from(body)].every((byte) => byte < 128)).toBe(true);
    });

    test('checks $LASTEXITCODE only after the native version probe', () => {
      const body = windowsRunBlock(readText(WORKFLOW_PATH));
      const probe = body.indexOf('mangostudio.cmd" --version');
      const comparison = body.indexOf('if ($actual -ne $env:ARCHIVE_VERSION)');
      const guards = [...body.matchAll(/if \(\$LASTEXITCODE -ne 0\) \{ exit \$LASTEXITCODE \}/g)];

      // install.ps1 fails via `throw`; $LASTEXITCODE after it is whatever native
      // command ran last inside the script, not the script's own status.
      expect(body).not.toContain('$LASTEXITCODE = 0');
      expect(guards).toHaveLength(1);
      expect(guards[0]?.index).toBeGreaterThan(probe);
      expect(guards[0]?.index).toBeLessThan(comparison);
    });

    test('runs one lane per OS against the pinned identity, with no toolchain setup', () => {
      // The npm and archive lanes repeat the same three runners, so only this
      // job's own matrix counts.
      const lane = extractJobBlock(readText(WORKFLOW_PATH), 'install-script');

      expect(lane).toMatch(/^ {4}needs: resolve$/m);
      expect(lane).toContain('runner: ubuntu-latest');
      expect(lane).toContain('runner: macos-latest');
      expect(lane).toContain('runner: windows-latest');
      expect(lane).toContain('script: install.sh');
      expect(lane).toContain('script: install.ps1');
    });

    test('a missing script asset is a notice, not a failure', () => {
      const download = installScriptStep(readText(WORKFLOW_PATH), 'Download the install script');

      // The not-found branch (matched against gh's captured stderr) keeps
      // the step green and records a notice; it never exits non-zero.
      expect(download).toMatch(
        /if gh release download "\$RELEASE_TAG" --pattern "\$SCRIPT_NAME"[\s\S]*?else[\s\S]*?if grep -qiE "release not found\|no assets match\|HTTP 404" download-error\.log; then\n\s+echo "No[\s\S]*?GITHUB_STEP_SUMMARY[\s\S]*?SCRIPT_AVAILABLE=false[\s\S]*?fi\n\s+fi/
      );
    });

    test('a gh failure that is not a missing-asset 404 fails the step instead of skipping it', () => {
      const download = installScriptStep(readText(WORKFLOW_PATH), 'Download the install script');

      // Reproduces the gap: any gh release download failure used to fall
      // straight into the "asset absent" branch — an auth error or rate
      // limit would silently skip the rest of the lane instead of failing
      // it. The else branch's fallback path must exit non-zero.
      expect(download).toContain('2>download-error.log');
      expect(download).toMatch(
        /else\n\s+echo "gh release download failed for a reason other than a missing asset[\s\S]*?exit 1/
      );
    });

    test('verifies the script against the resolved identity on both shells', () => {
      const workflow = readText(WORKFLOW_PATH);
      const unix = installScriptStep(workflow, LINUX_STEP);
      const windows = installScriptStep(workflow, WINDOWS_STEP);

      expect(unix).toContain("if: env.SCRIPT_AVAILABLE == 'true' && runner.os != 'Windows'");
      expect(unix).toContain('bash install-script/install.sh');
      expect(windows).toContain("if: env.SCRIPT_AVAILABLE == 'true' && runner.os == 'Windows'");
      expect(windows).toContain('shell: powershell');
      expect(windows).toContain('install-script\\install.ps1');
      // Canary races the identity resolve pinned; both shells warn instead of
      // failing when --canary/-Canary resolves a newer tag mid-run.
      expect(unix).toContain('::warning::install.sh resolved canary');
      expect(windows).toContain('::warning::install.ps1 resolved canary');
    });
  });
});
