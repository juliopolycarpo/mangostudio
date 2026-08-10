import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT_DIR } from '../lib/config';
import { targetBundleMembers } from '../release/bundle-distribution';
import {
  RELEASE_SCRIPT_ENV_CONTRACTS,
  type ReleaseScriptPath,
  requiredEnvForReleaseScriptInvocation,
} from '../release/env-contract';
import { readText } from './support/read-text';
import {
  extractJobBlock,
  extractJobBlocks,
  extractStepBlocks,
  extractStepBlocksAtIndent,
} from './support/workflow-blocks';
import {
  compositeActionFiles,
  uploadArtifactSteps,
  uploadPaths,
  workflowFiles,
} from './support/workflow-files';

const COMPRESSED_PAYLOAD = /\.(?:tar\.gz|tgz|zip|tar\.xz|tar\.zst)\b/;

// Jobs that publish a public channel. The tag-restricted `release` environment
// (deployment rule, reviewers, secrets) is GitHub state and is not asserted
// here — only that these jobs declare it, and that canary does not.
const RELEASE_PUBLISHING_JOBS = [
  'github-release',
  'docker',
  'npm-publish',
  'homebrew',
  'scoop',
  'cargo-publish',
] as const;

interface WorkflowRunStep {
  readonly workflowPath: string;
  readonly job: string;
  readonly name: string;
  readonly block: string;
  readonly env: ReadonlySet<string>;
}

function expectJobNeeds(workflow: string, job: string, needs: string): void {
  const block = extractJobBlock(workflow, job);
  expect(block, `job "${job}" not found in workflow`).not.toBe('');
  expect(block).toMatch(new RegExp(`\\n    needs: ${needs}(?:\\n|$)`));
}

function extractWorkflowRunSteps(workflowPath: string): WorkflowRunStep[] {
  const workflow = readText(workflowPath);
  const workflowEnv = collectEnvKeys(workflow, 0);
  const steps: WorkflowRunStep[] = [];

  for (const { job, block: jobBlock } of extractJobBlocks(workflow)) {
    const jobEnv = collectEnvKeys(jobBlock, 4);
    for (const stepBlock of extractStepBlocks(jobBlock)) {
      if (!/^ {8}run:/m.test(stepBlock)) continue;
      steps.push({
        workflowPath,
        job,
        name: extractStepName(stepBlock, 6),
        block: stepBlock,
        env: new Set([...workflowEnv, ...jobEnv, ...collectEnvKeys(stepBlock, 8)]),
      });
    }
  }

  return steps;
}

/**
 * The same walk for a composite action manifest, whose steps sit one level
 * shallower than a job's. Release scripts moved into `.github/actions/*` would
 * otherwise leave the env-contract assertion below matching nothing and passing
 * vacuously.
 */
function extractCompositeRunSteps(actionPath: string): WorkflowRunStep[] {
  return extractStepBlocksAtIndent(readText(actionPath), 4)
    .filter((stepBlock) => /^ {6}run:/m.test(stepBlock))
    .map((stepBlock) => ({
      workflowPath: actionPath,
      job: 'composite',
      name: extractStepName(stepBlock, 4),
      block: stepBlock,
      env: new Set(collectEnvKeys(stepBlock, 6)),
    }));
}

function extractStepName(stepBlock: string, indent: number): string {
  const marker = ' '.repeat(indent);
  return (
    new RegExp(`^${marker}- name: (.+)$`, 'm').exec(stepBlock)?.[1] ??
    new RegExp(`^${marker}- id: (.+)$`, 'm').exec(stepBlock)?.[1] ??
    'unnamed step'
  );
}

function collectEnvKeys(block: string, envIndent: number): string[] {
  const lines = block.split('\n');
  const keys = new Set<string>();
  const envPrefix = `${' '.repeat(envIndent)}env:`;
  const keyPattern = new RegExp(`^${' '.repeat(envIndent + 2)}([A-Z0-9_]+):`);

  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] !== envPrefix) continue;
    for (let envIndex = index + 1; envIndex < lines.length; envIndex += 1) {
      const line = lines[envIndex];
      if (line.trim() === '') continue;
      if (!line.startsWith(' '.repeat(envIndent + 2))) break;
      const key = keyPattern.exec(line)?.[1];
      if (key) keys.add(key);
    }
  }

  return [...keys];
}

function releaseScriptsInStep(stepBlock: string): ReleaseScriptPath[] {
  const scripts = new Set<ReleaseScriptPath>();
  const pattern = /\.\/(scripts\/release\/[\w-]+\.ts)\b/g;
  for (const match of stepBlock.matchAll(pattern)) {
    const scriptPath = match[1];
    if (scriptPath in RELEASE_SCRIPT_ENV_CONTRACTS) {
      scripts.add(scriptPath as ReleaseScriptPath);
    }
  }
  return [...scripts];
}

describe('release workflow binary gate', () => {
  test('release env contract declares every release TypeScript entrypoint', () => {
    const scripts = readdirSync(join(ROOT_DIR, 'scripts', 'release'))
      .filter((file) => file.endsWith('.ts'))
      .map((file) => `scripts/release/${file}`)
      .filter((path) => readText(path).startsWith('#!/usr/bin/env bun'))
      .sort();

    expect(Object.keys(RELEASE_SCRIPT_ENV_CONTRACTS).sort()).toEqual(scripts);
  });

  test('release script invocations provide their required env explicitly', () => {
    const invocations = [
      ...extractWorkflowRunSteps('.github/workflows/release.yml'),
      ...extractWorkflowRunSteps('.github/workflows/canary.yml'),
      ...compositeActionFiles().flatMap(extractCompositeRunSteps),
    ].flatMap((step) =>
      releaseScriptsInStep(step.block).map((scriptPath) => ({ step, scriptPath }))
    );

    // Guard the guard: the publish is the deepest invocation the walk has to
    // reach (it lives in a composite action, not a workflow). A walk that stops
    // reaching it would satisfy every assertion below while enforcing nothing.
    expect(
      invocations.map(({ scriptPath }) => scriptPath),
      'the env-contract walk no longer reaches the npm publish'
    ).toContain('scripts/release/publish-npm.ts');

    for (const { step, scriptPath } of invocations) {
      const missing = requiredEnvForReleaseScriptInvocation(scriptPath, step.block).filter(
        (envName) => !step.env.has(envName)
      );
      expect(
        missing,
        `${step.workflowPath} job "${step.job}" step "${step.name}" invokes ${scriptPath} without env: ${missing.join(', ')}`
      ).toEqual([]);
    }
  });

  test('release and canary publish through one composite, differing only by dist-tag', () => {
    const release = extractJobBlock(readText('.github/workflows/release.yml'), 'npm-publish');
    const canary = extractJobBlock(readText('.github/workflows/canary.yml'), 'npm-canary');
    const action = readText('.github/actions/publish-npm-distribution/action.yml');
    const secretPrefix = '$' + '{{ secrets.';
    const inputPrefix = '$' + '{{ inputs.';

    for (const block of [release, canary]) {
      expect(block).toContain('uses: ./.github/actions/publish-npm-distribution');
      expect(block).toContain('node-version: "22.14.0"');
      // setup-node's registry-url writes an npmrc templating
      // `_authToken=${NODE_AUTH_TOKEN}`, and the publish step overrides
      // NPM_CONFIG_USERCONFIG away from it — so it is inert at best, and a
      // liability if that override is ever narrowed to the legacy path.
      expect(block).not.toContain('registry-url:');
      expect(block).not.toContain('scripts/release/publish-npm.ts');
    }
    expect(release).toContain('allow-legacy-token:');
    expect(release).toContain('allow_legacy_npm_token');
    expect(release).not.toMatch(/^ {10}node-auth-token: \$\{\{ secrets\.NPM_TOKEN \}\}/m);
    // A stable release must publish as `latest`: any dist-tag wired into the
    // release job would divert it away from the tag every installer reads.
    expect(release).not.toMatch(/^ {10}dist-tag:/m);
    expect(canary).toContain('dist-tag: canary');
    expect(canary).toContain('allow-legacy-token: "true"');
    expect(canary).toContain(`node-auth-token: ${secretPrefix}NPM_TOKEN }}`);

    const publishStep = extractStepBlocksAtIndent(action, 4).find((step) =>
      step.includes('scripts/release/publish-npm.ts')
    );
    expect(publishStep).toBeDefined();
    expect(publishStep).toContain(`LEGACY_NODE_AUTH_TOKEN: ${inputPrefix}node-auth-token }}`);
    expect(publishStep).toContain('unset NODE_AUTH_TOKEN');
    expect(publishStep).toContain('_authToken');
    expect(publishStep).toContain('--provenance-policy required');
    expect(publishStep).toContain(`trap 'rm -f "$NPM_CONFIG_USERCONFIG"' EXIT`);
    // The dist-tag wiring is the highest-consequence branch in the action: a
    // canary that loses its `--tag` republishes `latest` to every installer.
    expect(publishStep).toContain(`DIST_TAG: ${inputPrefix}dist-tag }}`);
    expect(publishStep).toContain('if [ -n "$DIST_TAG" ]; then');
    expect(publishStep).toContain('args+=(--tag "$DIST_TAG")');
  });

  test('the publish composite re-exports auth and provenance to both summaries', () => {
    const action = readText('.github/actions/publish-npm-distribution/action.yml');
    const publishOutputPrefix = '$' + '{{ steps.publish.outputs.';
    expect(action).toContain('auth:');
    expect(action).toContain(`value: ${publishOutputPrefix}auth }}`);
    expect(action).toContain('provenance:');
    expect(action).toContain(`value: ${publishOutputPrefix}provenance }}`);

    for (const [file, job] of [
      ['release.yml', 'npm-publish'],
      ['canary.yml', 'npm-canary'],
    ] as const) {
      const block = extractJobBlock(readText(`.github/workflows/${file}`), job);
      expect(block).toContain(`auth: ${publishOutputPrefix}auth }}`);
      expect(block).toContain(`provenance: ${publishOutputPrefix}provenance }}`);
    }
  });

  test('every channel secret preflight uses the shared composite', () => {
    const release = readText('.github/workflows/release.yml');
    const canary = readText('.github/workflows/canary.yml');
    const prepareBlock = extractJobBlock(release, 'prepare');
    const cargoBlock = extractJobBlock(release, 'cargo-publish');
    const secretPrefix = '$' + '{{ secrets.';

    expect(prepareBlock).not.toContain('name: Preflight release secrets');
    expect(prepareBlock).not.toContain(
      `CARGO_REGISTRY_TOKEN: ${secretPrefix}CARGO_REGISTRY_TOKEN }}`
    );

    for (const [workflow, job, secret] of [
      [release, 'homebrew', 'DIST_REPOS_TOKEN'],
      [release, 'scoop', 'DIST_REPOS_TOKEN'],
      [canary, 'npm-canary', 'NPM_TOKEN'],
    ] as const) {
      const block = extractJobBlock(workflow, job);
      expect(block, job).toContain('uses: ./.github/actions/require-secret');
      expect(block, job).toContain(`name: ${secret}`);
      expect(block, job).toContain(`value: "${secretPrefix}${secret} }}"`);
      expect(block.indexOf('uses: actions/checkout@'), job).toBeLessThan(
        block.indexOf('uses: ./.github/actions/require-secret')
      );
    }
    expect(
      `${release}\n${canary}`.match(/uses: \.\/\.github\/actions\/require-secret/g)
    ).toHaveLength(3);
    expect(`${release}\n${canary}`).not.toMatch(
      /if \[ -z "\$(?:NPM_TOKEN|DIST_REPOS_TOKEN)" \]; then/
    );

    expect(cargoBlock).not.toContain('Missing required release secret: CARGO_REGISTRY_TOKEN');
    expect(cargoBlock).toContain('allow_legacy_cargo_token');

    const npmPublishBlock = extractJobBlock(release, 'npm-publish');
    expect(npmPublishBlock).not.toContain('uses: ./.github/actions/require-secret');
    expect(npmPublishBlock).toContain('allow-legacy-token:');
    expect(npmPublishBlock).toContain('allow_legacy_npm_token');

    const action = readText('.github/actions/require-secret/action.yml');
    const inputPrefix = '$' + '{{ inputs.';
    expect(action).toContain(`SECRET_NAME: ${inputPrefix}name }}`);
    expect(action).toContain(`SECRET_VALUE: ${inputPrefix}value }}`);
    expect(action).toContain('Missing required secret: $SECRET_NAME');
    expect(action).not.toMatch(/echo[^\n]*SECRET_VALUE/);
  });

  test('every publishing job runs in the tag-restricted release environment', () => {
    const workflow = readText('.github/workflows/release.yml');
    const publishing = new Set<string>(RELEASE_PUBLISHING_JOBS);
    const secretPrefix = '$' + '{{ secrets.';

    for (const job of RELEASE_PUBLISHING_JOBS) {
      expect(extractJobBlock(workflow, job), job).toMatch(/^ {4}environment: release$/m);
    }

    for (const { job, block } of extractJobBlocks(workflow)) {
      if (publishing.has(job)) continue;
      expect(block, job).not.toMatch(/^ {4}environment: release$/m);
    }

    // Only the publishing channels may reference a channel secret. Requiring
    // `environment: release` on any secret-using job instead would contradict
    // the loop above (and is impossible for a `uses:` job, where GitHub
    // forbids `environment`). Note the environment does not itself hide
    // repository secrets — it shadows same-named ones — so the guarantee has
    // to come from keeping the credential surface inside this job set.
    // `secrets.GITHUB_TOKEN` is built in and always available, so it is not a
    // channel credential; the workflow uses `github.token` for it anyway.
    const githubTokenRef = `${secretPrefix}GITHUB_TOKEN`;
    for (const { job, block } of extractJobBlocks(workflow)) {
      const usesChannelSecret = block
        .split('\n')
        .some((line) => line.includes(secretPrefix) && !line.includes(githubTokenRef));
      if (!usesChannelSecret) continue;
      expect(publishing.has(job), job).toBe(true);
    }
  });

  test('canary publishes outside the tag-restricted release environment', () => {
    // Canary runs on every green main push; the v*.*.* tag rule would block it.
    expect(readText('.github/workflows/canary.yml')).not.toContain('environment: release');
  });

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
    const dockerArchVar = '$' + '{DOCKER_ARCH}';
    expect(workflow).toContain(`DOCKER_ARCH: ${dockerArchExpression}`);
    expect(workflow).toContain(`--platform "linux/${dockerArchVar}"`);
    expect(workflow).not.toContain('docker/setup-qemu-action');
  });

  test('one reusable builder creates manifest-backed target and packaged artifacts', () => {
    const workflow = readText('.github/workflows/distribution-build.yml');

    expect(workflow.match(/bun run build --binary/g)).toHaveLength(1);
    expect(workflow.match(/bun \.\/scripts\/release\/pack-npm\.ts/g)).toHaveLength(1);
    expect(workflow.match(/bun \.\/scripts\/release\/archive-assets\.ts/g)).toHaveLength(1);
    expect(workflow).toContain(
      'bun ./scripts/release/distribution-manifest.ts --validate distribution-manifest.json --expect built'
    );
    expect(workflow).toContain('bun ./scripts/release/bundle-distribution.ts');
    expect(workflow.match(/overwrite: false/g)).toHaveLength(11);
    expect(workflow).toContain('actions/attest-build-provenance@');
    expect(workflow).toContain('subject-path: .distribution-bundles/*.tar.gz');
  });

  test('already-compressed upload payloads skip artifact re-compression', () => {
    const uploads = workflowFiles().flatMap((path) =>
      uploadArtifactSteps(readText(path)).map((step) => ({
        path,
        step,
        compressed: uploadPaths(step).some((payload) => COMPRESSED_PAYLOAD.test(payload)),
      }))
    );

    // Eleven distribution bundles today; a twelfth must make the same decision
    // deliberately instead of quietly re-Deflating gzip.
    expect(uploads.filter((upload) => upload.compressed)).toHaveLength(11);
    for (const { path, step, compressed } of uploads) {
      // Anchored so a commented-out key can neither satisfy nor trip the policy.
      if (compressed) expect(step, path).toMatch(/^\s*compression-level: 0$/m);
      else expect(step, path).not.toMatch(/^\s*compression-level:/m);
    }
  });

  test('binary and Docker smoke consume target artifacts without rebuilding by default', () => {
    const workflow = readText('.github/workflows/smoke-binary.yml');
    const skipBuildExpression = '$' + "{{ inputs.rebuild && '0' || '1' }}";

    expect(workflow.match(/uses: \.\/\.github\/actions\/download-distribution/g)).toHaveLength(2);
    for (const job of ['binary', 'docker']) {
      const jobBlock = extractJobBlock(workflow, job);
      const setupBunIndex = jobBlock.indexOf('uses: oven-sh/setup-bun@');
      // A missing step yields -1, which would satisfy the ordering check alone.
      expect(setupBunIndex, job).toBeGreaterThanOrEqual(0);
      expect(setupBunIndex).toBeLessThan(
        jobBlock.indexOf('uses: ./.github/actions/download-distribution')
      );
    }
    expect(workflow).toContain(`SKIP_BUILD: ${skipBuildExpression}`);
    expect(workflow).toContain('name: Build Docker binary (manual fallback)');
    expect(workflow).toMatch(
      /name: Build Docker binary \(manual fallback\)\n\s+if: \$\{\{ inputs\.rebuild \}\}/
    );
  });

  test('runs the built linux-x64 archive before any publish channel starts', () => {
    const workflow = readText('.github/workflows/release.yml');
    const versionVar = '$' + '{VERSION}';

    expect(workflow).toContain('  verify-build:');
    // Scope to the job: six release jobs carry the same attestation lines, so a
    // whole-file assertion would still pass if verify-build lost them.
    const verifyBuild = extractJobBlock(workflow, 'verify-build');
    expect(verifyBuild).toContain('name: Verify built Linux binary');
    expect(verifyBuild).toContain(
      'attestations: read # fetch build provenance for gh attestation verify'
    );
    expect(verifyBuild).toContain('contents: read');
    expect(verifyBuild).toContain('verify-attestation: "true"');
    expect(verifyBuild).toContain('scope: assets');
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
    expect(workflow).toContain('os: windows-11-arm');
    expect(workflow).toContain('platform: windows-arm64');

    // Each npm install must prove the wrapper picked this runner's platform
    // package at the released version, not merely that a binary answered.
    const verifyReleaseBlock = extractJobBlock(workflow, 'verify-release');
    expect(verifyReleaseBlock).toContain('name: Verify npm wrapper platform resolution');
    expect(verifyReleaseBlock).toContain('MANGOSTUDIO_WRAPPER_INFO=1 mangostudio');
    // Split the same way `platformVar` below is: these are shell expansions in
    // a workflow, and biome reads `${...}` in a plain string as a template
    // literal someone forgot to tag.
    const runtimeArtifact = 'mangostudio-runtime-$' + '{VERSION}-$' + '{PLATFORM}';
    expect(verifyReleaseBlock).toContain(`raw_runtime="${runtimeArtifact}`);
    expect(verifyReleaseBlock).toContain('Expected raw runtime version');
    const platformVar = '$' + '{PLATFORM/windows/win32}';
    expect(verifyReleaseBlock).toContain(`expected_package="@mangostudio/cli-${platformVar}"`);

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

  test('release dry run relevance pattern mirrors the release import graph', () => {
    const workflow = readText('.github/workflows/release-dry-run.yml');
    const source = /release_pattern='([^']+)'/.exec(workflow)?.[1];
    expect(source, 'release_pattern not found in the changes job').toBeDefined();
    const pattern = new RegExp(source as string);

    // Everything the release actually imports marks the dry run relevant…
    expect('.github/workflows/release.yml').toMatch(pattern);
    expect('.github/workflows/release-dry-run.yml').toMatch(pattern);
    expect('.github/workflows/canary.yml').toMatch(pattern);
    expect('scripts/release/pack-npm.ts').toMatch(pattern);
    expect('scripts/install/install.sh').toMatch(pattern);
    expect('scripts/build.ts').toMatch(pattern);
    expect('scripts/lib/release-assets.ts').toMatch(pattern);
    expect('packages/cli/package.json').toMatch(pattern);
    expect('packages/cargo-shim/src/main.rs').toMatch(pattern);
    expect('Dockerfile').toMatch(pattern);

    // …while unrelated app code does not.
    expect('apps/api/src/app.ts').not.toMatch(pattern);
    expect('scripts/check.ts').not.toMatch(pattern);
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

  test('release dry run relevance pattern does not over-promise Alpine Docker coverage', () => {
    const workflow = readText('.github/workflows/release-dry-run.yml');
    const source = /release_pattern='([^']+)'/.exec(workflow)?.[1];
    expect(source, 'release_pattern not found in the changes job').toBeDefined();

    // The dry-run only builds the Bookworm image, so its relevance pattern
    // must not claim to exercise Dockerfile.alpine; ci.yml's smoke job covers
    // that on every PR.
    expect('Dockerfile.alpine').not.toMatch(new RegExp(source as string));
  });

  test('changelog lands pre-tag: no write-back job, gated by the prepare lockstep check', () => {
    const workflow = readText('.github/workflows/release.yml');

    // The changelog is generated in the release-prep commit before the tag is
    // pushed; no job regenerates or lands CHANGELOG.md after the fact, so the
    // extra PAT and its PR flow are gone entirely.
    expect(extractJobBlock(workflow, 'update-changelog')).toBe('');
    expect(workflow).not.toContain('push-changelog');
    expect(workflow).not.toContain('CHANGELOG_PR_TOKEN');
    expect(workflow).not.toContain('bun run changelog --release');

    // The preparation job's fail-fast verify step gates the changelog section (via
    // check:versions --expect) before any artifact is produced.
    const prepareBlock = extractJobBlock(workflow, 'prepare');
    expect(prepareBlock).toContain('bun run check:versions --expect "$EXPECTED_VERSION"');
    expect(prepareBlock).toContain('CHANGELOG.md lacks this release');
    expect(prepareBlock).toContain('bun run release:prepare');

    // github-release notes generation is unaffected by the gate.
    const releaseBlock = extractJobBlock(workflow, 'github-release');
    expect(releaseBlock).toContain('--latest --strip all');
  });

  test('stateful release retry loops document why they do not use retry_command', () => {
    const workflow = readText('.github/workflows/release.yml');
    const attemptVar = '$' + '{attempt}';
    const githubReleaseBlock = extractJobBlock(workflow, 'github-release');
    const cargoPublishBlock = extractJobBlock(workflow, 'cargo-publish');

    // Release creation/update lives in the shared helper so canary and stable
    // share the post-failure view probe; the workflow only sources and calls it.
    expect(githubReleaseBlock).toContain('source scripts/release/create-or-update-release.sh');
    expect(githubReleaseBlock).toContain('create_or_update_release "$tag" release-assets/* --');
    expect(githubReleaseBlock).toContain('--notes-file RELEASE_NOTES.md');
    expect(githubReleaseBlock).not.toContain('retry_command 3 30 gh release create');
    expect(githubReleaseBlock).not.toContain('if gh release create "$tag"');

    const helper = readText('scripts/release/create-or-update-release.sh');
    expect(helper).toContain('Stateful retry: scripts/release/retry.sh cannot model');
    expect(helper).toContain('if gh release create "$tag"');
    expect(helper).toContain('if gh release view "$tag" >/dev/null 2>&1; then');
    expect(helper).toContain('retry_command 3 30 gh release edit');
    expect(helper).toContain('retry_command 3 30 upload_release_assets');

    expect(cargoPublishBlock).toContain(
      'Stateful retry: scripts/release/retry.sh only repeats one command'
    );
    expect(cargoPublishBlock).toContain('(cd packages/cargo-shim && cargo publish --locked)');
    expect(cargoPublishBlock).toContain(
      'CRATES_IO_INDEX_URL: https://index.crates.io/ma/ng/mangostudio'
    );
    expect(cargoPublishBlock).toContain(
      'CRATES_IO_USER_AGENT: "mangostudio-release (https://github.com/juliopolycarpo/mangostudio)"'
    );
    expect(cargoPublishBlock).not.toContain('https://crates.io/api/v1/crates/mangostudio');
    expect(cargoPublishBlock).toContain('source scripts/release/crates-published.sh');
    // Already-published check runs before OIDC mint; post-failure visibility
    // poll stays subshell-wrapped so a transient index error is contained.
    expect(cargoPublishBlock).toContain(
      'name: Check whether the crate version is already on crates.io'
    );
    expect(cargoPublishBlock).toContain('name: Mint crates.io Trusted Publishing token');
    expect(cargoPublishBlock).toContain('continue-on-error: true');
    expect(cargoPublishBlock).toContain('auth=oidc');
    expect(cargoPublishBlock).toContain('auth=legacy-explicit');
    expect(cargoPublishBlock).toContain('auth=failed');
    expect(cargoPublishBlock).toContain('if published "$VERSION"; then');
    expect(cargoPublishBlock).toContain('if (published "$VERSION"); then');
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
    expect(buildBlock).not.toContain('retention_days: 7');
    expect(buildBlock).toContain('retention_days: 30');
    expect(buildBlock).toContain('uses: ./.github/workflows/distribution-build.yml');
  });

  test('docker job consumes only the verified distribution and retries scripted buildx', () => {
    const workflow = readText('.github/workflows/release.yml');
    const dockerBlock = extractJobBlock(workflow, 'docker');
    const versionVar = '$' + '{VERSION}';
    const imageVar = '$' + '{IMAGE}';

    // Publication never silently substitutes bytes from a previous release if
    // the run-scoped immutable artifact is missing or fails verification.
    expect(dockerBlock).toContain('uses: ./.github/actions/download-distribution');
    expect(dockerBlock).not.toContain('continue-on-error: true');
    expect(dockerBlock).not.toContain('gh release download');

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
    // Job results reach the shell through env indirection (zizmor
    // template-injection). The shared build gate is reported too: when it
    // fails every channel goes "skipped", so without this row the summary
    // would hide the real failure.
    expect(summaryBlock).toContain(`BUILD_RESULT: ${buildResult}`);
    expect(summaryBlock).toContain(`DOCKER_RESULT: ${dockerResult}`);
    expect(summaryBlock).toContain(`NPM_PUBLISH_RESULT: ${npmResult}`);
    expect(summaryBlock).toContain(`CARGO_PUBLISH_RESULT: ${cargoResult}`);
    const buildResultVar = '$' + '{BUILD_RESULT}';
    const dockerResultVar = '$' + '{DOCKER_RESULT}';
    const npmResultVar = '$' + '{NPM_PUBLISH_RESULT}';
    const cargoResultVar = '$' + '{CARGO_PUBLISH_RESULT}';
    expect(summaryBlock).toContain(`"build=${buildResultVar}"`);
    expect(summaryBlock).toContain(`"docker=${dockerResultVar}"`);
    expect(summaryBlock).toContain(`"npm-publish=${npmResultVar}"`);
    expect(summaryBlock).toContain(`"cargo-publish=${cargoResultVar}"`);
    expect(summaryBlock).toContain('NPM_PUBLISH_AUTH:');
    expect(summaryBlock).toContain('NPM_PUBLISH_PROVENANCE:');
    expect(summaryBlock).toContain('CARGO_PUBLISH_AUTH:');
  });

  test('release dispatch exposes an explicit legacy cargo token escape hatch', () => {
    const workflow = readText('.github/workflows/release.yml');
    expect(workflow).toContain('allow_legacy_cargo_token:');
    expect(workflow).toContain('type: boolean');
    expect(workflow).toContain('default: false');
  });

  test('npm publishing prefers OIDC with a dispatch-only legacy fallback', () => {
    const workflow = readText('.github/workflows/release.yml');
    expect(workflow).toContain('allow_legacy_npm_token:');
    const npmBlock = extractJobBlock(workflow, 'npm-publish');
    expect(npmBlock).toContain(
      "github.event_name == 'workflow_dispatch' && inputs.allow_legacy_npm_token"
    );
  });

  test('release verifies tag provenance and cannot be bypassed by a tag push', () => {
    const workflow = readText('.github/workflows/release.yml');
    const prepare = extractJobBlock(workflow, 'prepare');
    expect(prepare).toContain('git merge-base --is-ancestor');
    // Resolved through ci.yml's own run, never by the bare check-run name:
    // cargo-shim.yml and release-dry-run.yml also expose a job named "Gate".
    expect(prepare).toContain('actions/workflows/ci.yml/runs?head_sha=');
    expect(prepare).toContain('select(.name == "Gate")');
    expect(prepare).toContain('"completed:success"');
    expect(prepare).not.toContain('/check-runs');
    expect(prepare).toContain(
      "github.event_name == 'workflow_dispatch' && inputs.allow_unverified_source"
    );
    expect(workflow).toContain('allow_unverified_source:');
    expect(workflow).toContain('actions: read');
  });

  test('ci gates the canary publish on the aggregate gate and a push to main', () => {
    const workflow = readText('.github/workflows/ci.yml');
    const canaryBlock = extractJobBlock(workflow, 'canary');
    const mainPushIf = '$' + "{{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}";
    expect(canaryBlock, 'canary job not found in ci.yml').not.toBe('');

    // The gate is the definition of a green commit; the other dependencies
    // expose the exact artifact identity to the reusable publisher.
    expectJobNeeds(workflow, 'canary', String.raw`\[gate, distribution-identity, distribution\]`);
    expect(canaryBlock).toContain(`if: ${mainPushIf}`);
    expect(canaryBlock).toContain('uses: ./.github/workflows/canary.yml');
    expect(canaryBlock).toContain('assets_artifact:');
    expect(canaryBlock).toContain('npm_artifact:');
    // Explicit secret pass-through: the called workflow sees only what it
    // declares, never the caller's full secret set (zizmor secrets-inherit).
    expect(canaryBlock).not.toContain('secrets: inherit');
    expect(canaryBlock).toContain(`NPM_TOKEN: ${'$'}{{ secrets.NPM_TOKEN }}`);

    // The calling job's permissions are the ceiling for the reusable workflow,
    // since ci.yml's top-level grant is read-only.
    expect(canaryBlock).not.toContain('packages: write');
    expect(canaryBlock).toContain('id-token: write');
    expect(canaryBlock).toContain('contents: write');
  });

  test('canary publishes npm and GitHub release assets as isolated jobs', () => {
    const workflow = readText('.github/workflows/canary.yml');
    const cargoVersionInput = '$' + '{{ inputs.cargo_version }}';
    const cargoVersionVar = '$' + '{CARGO_VERSION}';
    const versionVar = '$' + '{VERSION}';

    // Reusable workflow; only the newest green commit owns the rolling tags.
    expect(workflow).toContain('on:\n  workflow_call:');
    expect(workflow).toContain('group: canary-publish');
    expect(workflow).toContain('cancel-in-progress: true');

    expect(extractJobBlock(workflow, 'verify')).toBe('');
    expect(extractJobBlock(workflow, 'docker-canary')).toBe('');
    expect(extractJobBlock(workflow, 'crates-canary')).toBe('');
    expect(workflow).toContain('uses: ./.github/actions/download-distribution');
    expect(workflow).not.toContain('bun run build --binary');
    expect(workflow).not.toContain('actions/upload-artifact@');
    expect(workflow).not.toContain('name: canary-cargo-assets');
    expect(workflow).not.toContain('packages: write');
    expect(workflow).not.toContain('CARGO_REGISTRY_TOKEN');
    expect(workflow).not.toContain('docker/setup-qemu-action');
    expect(workflow).not.toContain('docker/setup-buildx-action');
    expect(workflow).not.toContain('cargo publish --locked --allow-dirty');

    // npm: canary dist-tag so `latest` never moves; provenance is required.
    const npmBlock = extractJobBlock(workflow, 'npm-canary');
    expect(npmBlock).toContain('scope: npm');
    expect(npmBlock).toContain('id-token: write');
    expect(npmBlock).toContain('actions/setup-node@');
    expect(npmBlock).toContain('uses: ./.github/actions/publish-npm-distribution');
    expect(npmBlock).toContain('dist-tag: canary');

    // GitHub Releases: fixed <root>-canary asset names, with the full per-SHA
    // canary version retained in notes for traceability.
    const releaseBlock = extractJobBlock(workflow, 'github-release-canary');
    expect(releaseBlock).toContain('scope: assets');
    expect(releaseBlock).toContain(`VERSION: ${'$'}{{ inputs.version }}`);
    expect(releaseBlock).toContain(`CARGO_VERSION: ${cargoVersionInput}`);
    // Staging is a named selection in TypeScript, not a shell glob: a glob over
    // the release plan silently absorbed every raw hub binary the moment raw
    // assets shipped, while never matching a raw runtime binary.
    expect(releaseBlock).toContain('run: bun ./scripts/release/stage-canary-assets.ts');
    expect(releaseBlock).toContain(`SOURCE_SHA: ${'$'}{{ inputs.source_sha }}`);
    expect(releaseBlock).not.toContain('cp "$asset"');
    expect(releaseBlock).not.toContain('sha256sum mangostudio-');
    expect(releaseBlock).toContain(`tag="v${cargoVersionVar}"`);
    expect(releaseBlock).toContain(`Canary version: ${versionVar}`);
    expect(releaseBlock).toContain('source scripts/release/create-or-update-release.sh');
    expect(releaseBlock).toContain('create_or_update_release "$tag" github-canary-assets/* --');
    expect(releaseBlock).toContain('--prerelease');
    expect(releaseBlock).toContain('--notes "$notes"');
    // Canary must not fall back to a bare create retry that wedges on
    // 422 already_exists after a partial create.
    expect(releaseBlock).not.toContain('retry_command 3 30 gh release create');
    expect(releaseBlock).not.toContain(`tag="v${versionVar}"`);
    expect(workflow).not.toContain('prune-canary-releases.sh');
  });

  test('canary ends with an always-run per-channel summary', () => {
    const workflow = readText('.github/workflows/canary.yml');
    const summaryBlock = extractJobBlock(workflow, 'canary-summary');
    const alwaysExpression = '$' + '{{ always() }}';
    const npmResult = '$' + '{{ needs.npm-canary.result }}';
    const githubReleaseResult = '$' + '{{ needs.github-release-canary.result }}';
    expect(summaryBlock, 'canary-summary job not found').not.toBe('');

    expectJobNeeds(workflow, 'canary-summary', String.raw`\[npm-canary, github-release-canary\]`);
    expect(summaryBlock).toContain(`if: ${alwaysExpression}`);
    expect(summaryBlock).toContain('bash scripts/release/publish-summary.sh');
    expect(summaryBlock).toContain(`NPM_RESULT: ${npmResult}`);
    expect(summaryBlock).toContain(`RELEASE_RESULT: ${githubReleaseResult}`);
    const npmResultVar = '$' + '{NPM_RESULT}';
    const releaseResultVar = '$' + '{RELEASE_RESULT}';
    expect(summaryBlock).toContain(`"npm-canary=${npmResultVar}"`);
    expect(summaryBlock).toContain(`"github-release-canary=${releaseResultVar}"`);
    expect(summaryBlock).not.toContain('build=');
    expect(summaryBlock).not.toContain('docker-canary=');
    expect(summaryBlock).not.toContain('crates-canary=');
  });

  test('each distribution consumer downloads only the scope it uses', () => {
    const expected = {
      'release.yml': {
        'github-release': 'assets',
        docker: 'assets',
        'npm-publish': 'npm',
        homebrew: 'checksums',
        scoop: 'checksums',
        'verify-build': 'assets',
      },
      'canary.yml': { 'npm-canary': 'npm', 'github-release-canary': 'assets' },
    };
    for (const [file, jobs] of Object.entries(expected)) {
      const workflow = readText(`.github/workflows/${file}`);
      for (const [job, scope] of Object.entries(jobs)) {
        expect(extractJobBlock(workflow, job), `${file} → ${job}`).toContain(`scope: ${scope}`);
      }
    }
  });

  test('the checksums scope stays small enough to be worth splitting out', () => {
    const source = readText('scripts/release/bundle-distribution.ts');
    const checksums = /checksums:\s*\[([^\]]*)\]/.exec(source)?.[1] ?? '';
    expect(checksums).toContain('SHA256SUMS');
    expect(checksums).not.toContain("'dist-npm'");
    expect(checksums).not.toMatch(/'release-assets'(?!\/)/);
  });

  test('target bundles carry archives once and materialize them after verification', () => {
    const action = readText('.github/actions/download-distribution/action.yml');
    const smoke = readText('scripts/test-build.ts');

    expect(targetBundleMembers({ archive: 'release-assets/target.tar.gz' })).toEqual([
      'distribution-manifest.json',
      'release-assets/target.tar.gz',
      'release-assets/SHA256SUMS',
    ]);
    // SKIP_BUILD smoke must not require raw binaries in the slim target bundle.
    expect(smoke).toContain('existsSync(RAW_HUB_ASSET_PATH) ? RAW_HUB_ASSET_PATH : BINARY_PATH');
    expect(action).toContain('--expect downloaded');
    expect(action.indexOf('Verify distribution identity and checksums')).toBeLessThan(
      action.indexOf('Materialize target directory')
    );
    expect(action).toContain(
      'bun --no-install ./scripts/release/extract-target.ts --target "$TARGET"'
    );
  });

  test('binary smoke helper checks version, delegates the health poll, and surfaces failure logs', () => {
    const helper = readText('scripts/release/smoke-binary.sh');
    const portVar = '$' + '{port}';
    const bashSource = '$' + '{BASH_SOURCE[0]}';

    expect(helper).toContain('"$binary_path" --version');
    expect(helper).toContain('API_HOST=127.0.0.1');
    // The server boots from a staged copy of the binary with a doctored stale
    // public/ sidecar beside it, proving the embedded frontend wins.
    expect(helper).toContain(`"$staged_binary" serve "127.0.0.1:${portVar}"`);
    expect(helper).toContain('stale_sentinel=');
    expect(helper).toContain('grep -q "$stale_sentinel" "$served_index"');
    expect(helper).toContain('grep -q "$stale_sentinel" "$served_asset"');
    expect(helper).toContain(
      `source "$(cd "$(dirname "${bashSource}")" && pwd)/wait-for-health.sh"`
    );
    expect(helper).toContain('wait_for_health "$port" "kill -0 $server_pid"');
    expect(helper).toContain('exited before becoming healthy');
    expect(helper).toContain('cat "$server_log"');
  });
});
