import { describe, expect, test } from 'bun:test';

import { readText } from './support/read-text';

function expectJobNeeds(workflow: string, job: string, needs: string): void {
  // Isolate the job's own block (up to the next top-level `  <job>:` header or
  // EOF) before asserting `needs`, so a regression in one job cannot be masked
  // by a later job that happens to share the same `needs:` value.
  const block = new RegExp(`\\n  ${job}:\\n([\\s\\S]*?)(?=\\n  \\S|$)`).exec(workflow);
  expect(block, `job "${job}" not found in workflow`).not.toBeNull();
  expect(block?.[1]).toMatch(new RegExp(`\\n    needs: ${needs}(?:\\n|$)`));
}

describe('release workflow binary gate', () => {
  test('runs the built linux-x64 archive before any publish channel starts', () => {
    const workflow = readText('.github/workflows/release.yml');
    const versionVar = '$' + '{VERSION}';

    expect(workflow).toContain('  verify-build:');
    expect(workflow).toContain('name: Verify built Linux binary');
    expect(workflow).toContain('permissions:\n      contents: read');
    expect(workflow).toContain(
      `archive="release-assets/mangostudio-${versionVar}-linux-x64.tar.gz"`
    );
    expect(workflow).toContain('scripts/release/smoke-binary.sh "$binary_path" "$VERSION" 13003');

    expectJobNeeds(workflow, 'github-release', String.raw`\[build, verify-build\]`);
    expectJobNeeds(workflow, 'docker', String.raw`\[build, verify-build\]`);
    expectJobNeeds(workflow, 'npm-publish', String.raw`\[build, verify-build\]`);
    expectJobNeeds(workflow, 'homebrew', String.raw`\[build, verify-build, github-release\]`);
    expectJobNeeds(workflow, 'scoop', String.raw`\[build, verify-build, github-release\]`);
    expectJobNeeds(workflow, 'cargo-publish', String.raw`\[build, verify-build, github-release\]`);
  });

  test('post-publish verification covers broader npm, crates.io, and Homebrew installs', () => {
    const workflow = readText('.github/workflows/release.yml');

    expect(workflow).toContain('  verify-release:');
    expect(workflow).toContain('os: ubuntu-24.04-arm');
    expect(workflow).toContain('platform: linux-arm64');
    expect(workflow).toContain('os: macos-15-intel');
    expect(workflow).toContain('platform: darwin-x64');
    expect(workflow).toContain('windows-arm64 remains uncovered');

    expectJobNeeds(workflow, 'verify-release', String.raw`\[build, npm-publish, github-release\]`);
    expectJobNeeds(workflow, 'verify-cargo', String.raw`\[build, cargo-publish, github-release\]`);
    expectJobNeeds(workflow, 'verify-homebrew', String.raw`\[build, homebrew\]`);

    expect(workflow).toContain('cargo install mangostudio --version "$VERSION" --locked');
    expect(workflow).toContain('MANGOSTUDIO_DIST_URL: https://github.com/');
    expect(workflow).toContain('brew install juliopolycarpo/tap/mangostudio');
  });

  test('release dry run exercises the same serve and health check path', () => {
    const workflow = readText('.github/workflows/release-dry-run.yml');
    const runnerTempVar = '$' + '{RUNNER_TEMP}';

    expect(workflow).toContain('name: Verify local archive serves health');
    expect(workflow).toContain(
      `scripts/release/smoke-binary.sh "${runnerTempVar}/mango-bin/mangostudio" "$DRY_RUN_VERSION" 13003`
    );
  });

  test('binary smoke helper checks version, exact health status, and failure logs', () => {
    const helper = readText('scripts/release/smoke-binary.sh');
    const portVar = '$' + '{port}';

    expect(helper).toContain('"$binary_path" --version');
    expect(helper).toContain('API_HOST=127.0.0.1');
    expect(helper).toContain(`"$binary_path" serve "127.0.0.1:${portVar}"`);
    expect(helper).toContain('/api/health');
    expect(helper).toContain('"status"[[:space:]]*:[[:space:]]*"ok"');
    expect(helper).toContain('cat "$server_log"');
  });
});
