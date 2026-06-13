import { describe, expect, test } from 'bun:test';

import { readText } from './support/read-text';

// Isolate a single top-level job's block (up to the next `  <job>:` header or
// EOF) so an assertion about one job cannot be masked or satisfied by a later
// job that happens to share the same content. Returns '' when the job is absent.
function extractJobBlock(workflow: string, job: string): string {
  return new RegExp(`\\n  ${job}:\\n([\\s\\S]*?)(?=\\n  \\S|$)`).exec(workflow)?.[1] ?? '';
}

function expectJobNeeds(workflow: string, job: string, needs: string): void {
  const block = extractJobBlock(workflow, job);
  expect(block, `job "${job}" not found in workflow`).not.toBe('');
  expect(block).toMatch(new RegExp(`\\n    needs: ${needs}(?:\\n|$)`));
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

  test('release dry run derives placeholder checksums from release targets', () => {
    const workflow = readText('.github/workflows/release-dry-run.yml');

    expect(workflow).toContain('bun ./scripts/release/fill-dry-run-checksums.ts \\');
    expect(workflow).toContain('--version "$DRY_RUN_VERSION" \\');
    expect(workflow).toContain('--sums "$sums"');
    expect(workflow).not.toContain('append_if_missing');
    expect(workflow).not.toContain('darwin-arm64.tar.gz" "$(printf');
  });

  test('release dry run exercises the Docker release-asset staging path', () => {
    const workflow = readText('.github/workflows/release-dry-run.yml');

    // Stages from the published tarballs (the release `docker` job's path), not
    // from build output, so it covers what ci.yml's smoke job does not.
    expect(workflow).toContain(
      'bun ./scripts/release/stage-docker-ctx.ts --release-assets release-assets --arch amd64 --variant bookworm'
    );
    expect(workflow).toContain('-f Dockerfile \\');
    expect(workflow).toContain(
      'scripts/release/smoke-docker-image.sh mangostudio:dryrun-bookworm-amd64 linux/amd64 13002'
    );
  });

  test('release dry run path filter does not over-promise Alpine Docker coverage', () => {
    const workflow = readText('.github/workflows/release-dry-run.yml');

    // The dry-run only builds the Bookworm image, so its paths: filter must not
    // claim to exercise Dockerfile.alpine; ci.yml's smoke job covers that.
    expect(workflow).toContain('- "Dockerfile"');
    expect(workflow).not.toContain('- "Dockerfile.alpine"');
  });

  test('changelog update lands via a protection-tolerant script, not a raw direct push', () => {
    const workflow = readText('.github/workflows/release.yml');
    const job = extractJobBlock(workflow, 'update-changelog');
    expect(job, 'update-changelog job not found').not.toBe('');

    // Fallback needs pull-requests: write on top of contents: write.
    expect(job).toContain('contents: write');
    expect(job).toContain('pull-requests: write');

    // A dedicated, ref-independent concurrency group serializes CHANGELOG.md
    // writes when two tags release at once.
    expect(job).toContain('group: update-changelog');
    expect(job).toContain('cancel-in-progress: false');

    // Landing goes through the reusable script (direct push + bot-PR fallback),
    // with the version passed via env rather than interpolated into the shell.
    expect(job).toContain(
      'bun ./scripts/release/push-changelog.ts --version "$VERSION" --branch main'
    );
    expect(job).toContain(`GH_TOKEN: $${'{{ github.token }}'}`);
    expect(job).toContain('bun run changelog --release "$VERSION"');

    // The old direct-push loop and its "unimplemented fallback" comment are gone.
    expect(job).not.toContain('git push origin main');
    expect(workflow).not.toContain('If branch protection later blocks bot pushes');
  });

  test('stateful release retry loops document why they do not use retry_command', () => {
    const workflow = readText('.github/workflows/release.yml');
    const attemptVar = '$' + '{attempt}';
    const githubReleaseBlock = extractJobBlock(workflow, 'github-release');
    const cargoPublishBlock = extractJobBlock(workflow, 'cargo-publish');

    expect(githubReleaseBlock).toContain('source scripts/release/retry.sh');
    expect(githubReleaseBlock).toContain('retry_command 3 30 gh release edit');
    expect(githubReleaseBlock).toContain('retry_command 3 30 gh release upload');
    expect(githubReleaseBlock).toContain('Stateful retry: scripts/release/retry.sh cannot model');
    expect(githubReleaseBlock).toContain('if gh release create "$tag"');
    expect(githubReleaseBlock).toContain('if gh release view "$tag" >/dev/null 2>&1; then');

    expect(cargoPublishBlock).toContain(
      'Stateful retry: scripts/release/retry.sh only repeats one command'
    );
    expect(cargoPublishBlock).toContain(
      '(cd packages/cargo-shim && CARGO_REGISTRY_TOKEN="$publish_token" cargo publish --locked)'
    );
    expect(cargoPublishBlock).toContain('if published; then');
    expect(cargoPublishBlock).toContain(`Version became visible after attempt ${attemptVar}`);
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
