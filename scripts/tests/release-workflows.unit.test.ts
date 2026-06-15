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
  test('pre-merge binary smoke covers native host platforms and Docker variants', () => {
    const workflow = readText('.github/workflows/smoke-binary.yml');
    const platformExpression = '$' + '{{ matrix.platform }}';
    const variantExpression = '$' + '{{ matrix.variant }}';
    const dockerArchExpression = '$' + '{{ matrix.docker_arch }}';

    expect(workflow).toContain('  binary:');
    expect(workflow).toContain(`name: Binary ${platformExpression}`);
    expect(workflow).toContain('- platform: linux-x64');
    expect(workflow).toContain('- platform: linux-arm64');
    expect(workflow).toContain('- platform: darwin-arm64');
    expect(workflow).toContain('- platform: darwin-x64');
    expect(workflow).toContain('- platform: windows-x64');
    expect(workflow).toContain('- platform: windows-arm64');
    expect(workflow).toContain('runner: ubuntu-24.04-arm');
    expect(workflow).toContain('runner: macos-15-intel');
    expect(workflow).toContain('runner: windows-11-arm');
    expect(workflow).toContain(`PLATFORM: ${platformExpression}`);

    expect(workflow).toContain('  docker:');
    expect(workflow).toContain(`name: Docker ${variantExpression} ${dockerArchExpression}`);
    expect(workflow).toContain('binary_platform: linux-x64');
    expect(workflow).toContain('binary_platform: linux-arm64');
    expect(workflow).toContain('binary_platform: linux-x64-musl');
    expect(workflow).toContain('binary_platform: linux-arm64-musl');
    expect(workflow).toContain(`--platform linux/${dockerArchExpression}`);
    expect(workflow).not.toContain('docker/setup-qemu-action');
  });

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

  test('release tag trigger excludes canary pre-release tags', () => {
    const workflow = readText('.github/workflows/release.yml');

    // Stable + real prereleases fire the release; canary-like
    // v<version>-canary.<sha> tags must not.
    expect(workflow).toContain('- "v*.*.*"');
    expect(workflow).toContain('- "!v*-canary*"');
  });

  test('release build artifacts retain long enough to re-run a single failed job', () => {
    const workflow = readText('.github/workflows/release.yml');
    const buildBlock = extractJobBlock(workflow, 'build');

    // 30 days widens the window for re-running just the docker/npm publish job
    // off the original artifacts.
    expect(buildBlock).not.toContain('retention-days: 7');
    expect(buildBlock).toContain('retention-days: 30');
  });

  test('docker job re-runs durably: GHCR-asset fallback plus retried scripted buildx', () => {
    const workflow = readText('.github/workflows/release.yml');
    const dockerBlock = extractJobBlock(workflow, 'docker');
    const versionVar = '$' + '{VERSION}';
    const imageVar = '$' + '{IMAGE}';

    // The artifact download is tolerant; a fallback fetches the published release
    // so a late, isolated re-run still has the binaries to stage from.
    expect(dockerBlock).toContain('continue-on-error: true');
    expect(dockerBlock).toContain("if: steps.assets.outcome != 'success'");
    expect(dockerBlock).toContain(`retry_command 3 30 gh release download "v${versionVar}"`);

    // Scripted buildx (not build-push-action) so each multi-arch push is retried;
    // the full tag set is preserved.
    expect(dockerBlock).not.toContain('docker/build-push-action');
    expect(dockerBlock).toContain('source scripts/release/retry.sh');
    expect(dockerBlock).toContain('retry_command 3 30 docker buildx build');
    expect(dockerBlock).toContain('--platform linux/amd64,linux/arm64');
    expect(dockerBlock).toContain(`--tag "${imageVar}:${versionVar}"`);
    expect(dockerBlock).toContain(`--tag "${imageVar}:latest"`);
    expect(dockerBlock).toContain(`--tag "${imageVar}:${versionVar}-alpine"`);
    expect(dockerBlock).toContain('--file Dockerfile.alpine');
  });

  test('release ends with an always-run per-channel summary naming jobs to re-run', () => {
    const workflow = readText('.github/workflows/release.yml');
    const summaryBlock = extractJobBlock(workflow, 'release-summary');
    const alwaysExpression = '$' + '{{ always() }}';
    const buildResult = '$' + '{{ needs.build.result }}';
    const dockerResult = '$' + '{{ needs.docker.result }}';
    const npmResult = '$' + '{{ needs.npm-publish.result }}';
    const cargoResult = '$' + '{{ needs.cargo-publish.result }}';
    expect(summaryBlock, 'release-summary job not found').not.toBe('');

    expect(summaryBlock).toContain(`if: ${alwaysExpression}`);
    expect(summaryBlock).toContain('bash scripts/release/publish-summary.sh');
    // The shared build gate is reported too: when it fails every channel goes
    // "skipped", so without this row the summary would hide the real failure.
    expect(summaryBlock).toContain(`build=${buildResult}`);
    expect(summaryBlock).toContain(`docker=${dockerResult}`);
    expect(summaryBlock).toContain(`npm-publish=${npmResult}`);
    expect(summaryBlock).toContain(`cargo-publish=${cargoResult}`);
  });

  test('ci gates the canary publish on every job passing and a push to main', () => {
    const workflow = readText('.github/workflows/ci.yml');
    const canaryBlock = extractJobBlock(workflow, 'canary');
    const mainPushIf = '$' + "{{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}";
    expect(canaryBlock, 'canary job not found in ci.yml').not.toBe('');

    expectJobNeeds(workflow, 'canary', String.raw`\[check, test, build, browser-smoke, smoke\]`);
    expect(canaryBlock).toContain(`if: ${mainPushIf}`);
    expect(canaryBlock).toContain('uses: ./.github/workflows/canary.yml');
    expect(canaryBlock).toContain('secrets: inherit');

    // The calling job's permissions are the ceiling for the reusable workflow,
    // since ci.yml's top-level grant is read-only.
    expect(canaryBlock).toContain('packages: write');
    expect(canaryBlock).toContain('id-token: write');
    expect(canaryBlock).toContain('contents: write');
  });

  test('canary publishes Docker, npm, and fixed-version crates as isolated jobs', () => {
    const workflow = readText('.github/workflows/canary.yml');
    const imageVar = '$' + '{IMAGE}';
    const sha7Var = '$' + '{SHA7}';
    const cargoVersionOutput = '$' + '{{ steps.identity.outputs.cargo_version }}';
    const cargoVersionNeeds = '$' + '{{ needs.build.outputs.cargo_version }}';
    const cargoVersionVar = '$' + '{CARGO_VERSION}';
    const versionVar = '$' + '{VERSION}';

    // Reusable workflow; only the newest green commit owns the rolling tags.
    expect(workflow).toContain('on:\n  workflow_call:');
    expect(workflow).toContain('group: canary-publish');
    expect(workflow).toContain('cancel-in-progress: true');

    expectJobNeeds(workflow, 'npm-canary', 'build');
    expectJobNeeds(workflow, 'docker-canary', 'build');
    expectJobNeeds(workflow, 'crates-canary', 'build');
    expect(workflow).toContain(`cargo_version: ${cargoVersionOutput}`);
    expect(workflow).toContain('name: canary-cargo-assets');

    // Docker: bookworm multi-arch, rolling + immutable canary tags, no Alpine.
    const dockerBlock = extractJobBlock(workflow, 'docker-canary');
    expect(dockerBlock).toContain('retry_command 3 30 docker buildx build');
    expect(dockerBlock).toContain('--platform linux/amd64,linux/arm64');
    expect(dockerBlock).toContain(`--tag "${imageVar}:canary"`);
    expect(dockerBlock).toContain(`--tag "${imageVar}:canary-${sha7Var}"`);
    expect(dockerBlock).not.toContain('Dockerfile.alpine');

    // npm: canary dist-tag so `latest` never moves.
    const npmBlock = extractJobBlock(workflow, 'npm-canary');
    expect(npmBlock).toContain('bun ./scripts/release/publish-npm.ts dist-npm --tag canary');

    // crates: fixed <root>-canary crate, backed by rolling v<root>-canary assets.
    // The per-SHA app version is only used to build/rename assets, never as the
    // crate version or GitHub pre-release tag.
    const cratesBlock = extractJobBlock(workflow, 'crates-canary');
    expect(cratesBlock).toContain(`CARGO_VERSION: ${cargoVersionNeeds}`);
    expect(cratesBlock).toContain(`tag="v${cargoVersionVar}"`);
    expect(cratesBlock).toContain('gh release create "$tag" cargo-canary-assets/*');
    expect(cratesBlock).toContain('gh release upload "$tag" cargo-canary-assets/* --clobber');
    expect(cratesBlock).toContain('bun ./scripts/release/stamp-cargo-version.ts "$CARGO_VERSION"');
    expect(cratesBlock).toContain('cargo publish --locked --allow-dirty');
    expect(cratesBlock).not.toContain(`tag="v${versionVar}"`);
    expect(workflow).not.toContain('prune-canary-releases.sh');
  });

  test('canary ends with an always-run per-channel summary', () => {
    const workflow = readText('.github/workflows/canary.yml');
    const summaryBlock = extractJobBlock(workflow, 'canary-summary');
    const alwaysExpression = '$' + '{{ always() }}';
    const buildResult = '$' + '{{ needs.build.result }}';
    const npmResult = '$' + '{{ needs.npm-canary.result }}';
    const dockerResult = '$' + '{{ needs.docker-canary.result }}';
    const cratesResult = '$' + '{{ needs.crates-canary.result }}';
    expect(summaryBlock, 'canary-summary job not found').not.toBe('');

    expect(summaryBlock).toContain(`if: ${alwaysExpression}`);
    expect(summaryBlock).toContain('bash scripts/release/publish-summary.sh');
    // Surface the shared build gate so its failure is not masked by the
    // channels all showing "skipped".
    expect(summaryBlock).toContain(`build=${buildResult}`);
    expect(summaryBlock).toContain(`npm-canary=${npmResult}`);
    expect(summaryBlock).toContain(`docker-canary=${dockerResult}`);
    expect(summaryBlock).toContain(`crates-canary=${cratesResult}`);
  });

  test('binary smoke helper checks version, delegates the health poll, and surfaces failure logs', () => {
    const helper = readText('scripts/release/smoke-binary.sh');
    const portVar = '$' + '{port}';
    const bashSource = '$' + '{BASH_SOURCE[0]}';

    expect(helper).toContain('"$binary_path" --version');
    expect(helper).toContain('API_HOST=127.0.0.1');
    expect(helper).toContain(`"$binary_path" serve "127.0.0.1:${portVar}"`);
    expect(helper).toContain(
      `source "$(cd "$(dirname "${bashSource}")" && pwd)/wait-for-health.sh"`
    );
    expect(helper).toContain('wait_for_health "$port" "kill -0 $server_pid"');
    expect(helper).toContain('exited before becoming healthy');
    expect(helper).toContain('cat "$server_log"');
  });
});
