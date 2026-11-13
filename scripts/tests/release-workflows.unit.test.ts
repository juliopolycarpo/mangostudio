import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { LAUNCHER_PATTERN, RELEASE_PATTERN } from '../lib/ci-lanes';
import { ROOT_DIR } from '../lib/config';
import { ALL_BINARY_TARGETS } from '../lib/release-targets';
import {
  bundleFileName,
  checksumsBundleMembers,
  SCOPED_BUNDLE_COMPRESSION,
  TARGET_BUNDLE_COMPRESSION,
  targetBundleMembers,
} from '../release/bundle-distribution';
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

// An archive payload whose compression was already decided when it was built.
// `.tar` is in the set deliberately: a stored distribution bundle holds an
// already-gzipped platform archive, so letting the artifact zip Deflate it
// would relocate the gzip that storing it removed, not avoid it.
const ARCHIVE_PAYLOAD = /\.(?:tar(?:\.(?:gz|xz|zst))?|tgz|zip)\b/;

// Jobs that publish a public channel. The tag-restricted `release` environment
// (deployment rule, reviewers, secrets) is GitHub state and is not asserted
// here — only that these jobs declare it. Canary uses its own environment.
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

function parseNeeds(block: string): string[] {
  return (/\n {4}needs: \[([^\]]*)\]/.exec(block)?.[1] ?? '')
    .split(',')
    .map((need) => need.trim())
    .filter(Boolean);
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

  test('only the creating manifest invocation requires RUNTIME_PROFILE, including bash-array validation', () => {
    const script = 'scripts/release/distribution-manifest.ts';

    expect(requiredEnvForReleaseScriptInvocation(script, `bun ./${script}`)).toContain(
      'RUNTIME_PROFILE'
    );
    for (const command of [
      `bun ./${script} --validate distribution-manifest.json --expect built`,
      `args=(--validate distribution-manifest.json --scope "$SCOPE")\nbun ./${script}`,
    ]) {
      expect(requiredEnvForReleaseScriptInvocation(script, command), command).not.toContain(
        'RUNTIME_PROFILE'
      );
    }
  });

  test('release and canary share the publisher with explicit channel and auth policy', () => {
    const release = extractJobBlock(readText('.github/workflows/release.yml'), 'npm-publish');
    const canary = extractJobBlock(readText('.github/workflows/canary.yml'), 'npm-canary');
    const action = readText('.github/actions/publish-npm-distribution/action.yml');
    const inputPrefix = '$' + '{{ inputs.';

    for (const block of [release, canary]) {
      expect(block).toContain('uses: $/.github/actions/publish-npm-distribution');
      expect(block).toContain('node-version: "22.23.4"');
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
    // A stable release must publish as `latest` — the tag every installer reads
    // — so the release job's dist-tag is allowed exactly one value besides the
    // empty default, and only for a pre-release. Asserted as the whole
    // expression rather than as "no dist-tag at all": the empty branch is what
    // keeps `latest` on the stable version, and a condition that silently
    // inverted would divert every stable release to `next`.
    const prereleaseOutput = '$' + '{{ needs.prepare.outputs.prerelease';
    expect(release).toContain(`dist-tag: ${prereleaseOutput} == 'true' && 'next' || '' }}`);
    // The count is what the replaced `not.toMatch(/^ {10}dist-tag:/m)` used to
    // carry: asserting only that the conditional expression is present would let
    // a second, unconditional `dist-tag:` be added elsewhere in the workflow.
    expect(release.match(/^ +dist-tag:/gm) ?? []).toHaveLength(1);
    expect(canary).toContain('dist-tag: canary');
    expect(canary).toContain('allow-legacy-token: "false"');
    expect(canary).not.toContain('node-auth-token:');
    expect(canary).not.toContain('uses: $/.github/actions/require-secret');
    expect(canary).not.toContain('NPM_TOKEN');
    expect(canary).toContain('id-token: write');

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
    ] as const) {
      const block = extractJobBlock(workflow, job);
      expect(block, job).toContain('uses: $/.github/actions/require-secret');
      expect(block, job).toContain(`name: ${secret}`);
      expect(block, job).toContain(`value: "${secretPrefix}${secret} }}"`);
      expect(block.indexOf('uses: actions/checkout@'), job).toBeLessThan(
        block.indexOf('uses: $/.github/actions/require-secret')
      );
    }
    expect(
      `${release}\n${canary}`.match(/uses: \$\/\.github\/actions\/require-secret/g)
    ).toHaveLength(2);
    expect(`${release}\n${canary}`).not.toMatch(
      /if \[ -z "\$(?:NPM_TOKEN|DIST_REPOS_TOKEN)" \]; then/
    );

    expect(cargoBlock).not.toContain('Missing required release secret: CARGO_REGISTRY_TOKEN');
    expect(cargoBlock).toContain('allow_legacy_cargo_token');

    const npmPublishBlock = extractJobBlock(release, 'npm-publish');
    expect(npmPublishBlock).not.toContain('uses: $/.github/actions/require-secret');
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

  test('npm canary declares the trusted publisher environment on its publishing job', () => {
    const workflow = Bun.YAML.parse(readText('.github/workflows/canary.yml')) as {
      jobs: Record<string, { environment?: string }>;
    };
    expect(workflow.jobs['npm-canary'].environment).toBe('canary');
  });

  test('canary publishes outside the tag-restricted release environment', () => {
    // Canary runs on every green main push; the v*.*.* tag rule would block it.
    expect(readText('.github/workflows/canary.yml')).not.toContain('environment: release');
  });

  test.each(['Dockerfile', 'Dockerfile.alpine'])(
    '%s keeps explicit host configuration above its default',
    (file) => {
      const dockerfile = readText(file);
      expect(dockerfile).toContain('ENV MANGOSTUDIO_DEFAULT_API_HOST=0.0.0.0');
      expect(dockerfile).not.toMatch(/^ENV API_HOST=/m);
    }
  );

  test('pre-merge binary smoke covers native host platforms and Docker variants', () => {
    const workflow = readText('.github/workflows/smoke-binary.yml');
    const platformExpression = '$' + '{{ matrix.platform }}';
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

    expect(workflow).not.toContain('  docker:');
    expect(workflow).toContain('name: Run Bookworm Docker smoke test');
    expect(workflow).toContain('name: Run Alpine Docker smoke test');
    expect(workflow).toContain('musl_platform: linux-x64-musl');
    expect(workflow).toContain('musl_platform: linux-arm64-musl');
    const dockerArchVar = '$' + '{DOCKER_ARCH}';
    expect(workflow).toContain(`DOCKER_ARCH: ${dockerArchExpression}`);
    expect(workflow).toContain(`--platform "linux/${dockerArchVar}"`);
    expect(workflow).not.toContain('docker/setup-qemu-action');
  });

  test('native hub producers reuse one frontend and compile every target on its matching host', () => {
    const workflow = readText('.github/workflows/distribution-build.yml');
    const prepare = extractJobBlock(workflow, 'prepare');
    const hub = extractJobBlock(workflow, 'hub');
    const build = extractJobBlock(workflow, 'build');
    const runtimeVersion = extractJobBlock(workflow, 'runtime-version');
    expect(prepare).toContain('bun run build --frontend');
    expect(prepare).toContain('bun ./scripts/release/bundle-binary-smoke.ts');
    expect(prepare).toContain('include-hidden-files: true');
    const runners = {
      'linux-x64': 'ubuntu-latest',
      'linux-arm64': 'ubuntu-24.04-arm',
      'darwin-x64': 'macos-15-intel',
      'darwin-arm64': 'macos-latest',
      'windows-x64': 'windows-latest',
      'windows-arm64': 'windows-11-arm',
      'linux-x64-musl': 'ubuntu-latest',
      'linux-arm64-musl': 'ubuntu-24.04-arm',
    };
    expect(hub.match(/- platform:/g)).toHaveLength(ALL_BINARY_TARGETS.length);
    for (const target of ALL_BINARY_TARGETS) {
      expect(hub).toContain(
        `platform: ${target.arch}\n            runner: ${runners[target.arch]}`
      );
    }
    expect(workflow.match(/bun run build --frontend/g)).toHaveLength(1);
    for (const job of [prepare, hub, build, runtimeVersion]) {
      expect(job).toContain('ref: $' + '{{ inputs.source_sha }}');
    }
    expect(hub).toContain('needs: [prepare]');
    expect(hub).toContain('include-hidden-files: true');
    expect(hub).not.toContain('.mango/runtime-prebuilt');
    expect(hub).toContain('.mango/hub-compiles/$' + '{{ matrix.platform }}.json');
    const install = extractStepBlocks(hub).find((step) => step.includes('actions/setup-mango'));
    expect(install).toContain('if: $' + '{{ !matrix.musl }}');
    expect(hub).toContain('runs-on: $' + '{{ matrix.runner }}');
    expect(hub.match(/--hub-only/g)).toHaveLength(2);
    expect(hub).toContain('--reuse-frontend');
    expect(hub).toContain('oven/bun:$' + '{BUN_CHANNEL}-alpine');
    expect(hub).toContain('bun install --frozen-lockfile');
    expect(build).toContain('needs: [hub, runtime, runtime-version]');
    expect(build).toContain('path: .mango/runtime-prebuilt');
    expect(build).toContain('path: .mango/runtime-versions');
    expect(extractJobBlock(workflow, 'runtime')).toContain('record_receipts: true');
    expect(runtimeVersion).toContain('needs: [runtime]');
    expect(runtimeVersion).toContain('bun --no-install ./scripts/release/verify-native-runtime.ts');
    const crossTargets = [
      'linux-arm64',
      'linux-arm64-musl',
      'darwin-x64',
      'windows-arm64',
    ] as const;
    expect(runtimeVersion.match(/- platform:/g)).toHaveLength(crossTargets.length);
    for (const platform of crossTargets) {
      expect(runtimeVersion).toContain(
        `platform: ${platform}\n            runner: ${runners[platform]}`
      );
    }
    const preparedInputs = extractStepBlocks(build).find((step) =>
      step.includes('name: Download prepared frontend')
    );
    expect(
      preparedInputs,
      'aggregate build must download prepared frontend at repository root'
    ).toBeDefined();
    expect(preparedInputs).toContain('actions/download-artifact@');
    expect(preparedInputs).toContain('name: hub-inputs-$' + '{{ inputs.source_sha }}');
    expect(preparedInputs).toMatch(/\n {10}path: \.\n/);
    expect(build.indexOf('name: Download prepared frontend')).toBeLessThan(
      build.indexOf('name: Archive release assets')
    );
    expect(build).toContain('bun ./scripts/release/assemble-native-hubs.ts');
    expect(build).not.toContain('bun run build --binary');
  });

  test('one reusable builder creates manifest-backed target and packaged artifacts', () => {
    const workflow = readText('.github/workflows/distribution-build.yml');

    expect(workflow.match(/bun run build --binary/g)).toHaveLength(2);
    expect(workflow.match(/bun \.\/scripts\/release\/pack-npm\.ts/g)).toHaveLength(1);
    expect(workflow.match(/bun \.\/scripts\/release\/archive-assets\.ts/g)).toHaveLength(1);
    expect(workflow).toContain(
      'bun ./scripts/release/distribution-manifest.ts --validate distribution-manifest.json --expect built'
    );
    expect(workflow).toContain('bun ./scripts/release/bundle-distribution.ts');
    // The manifest and runtime builder must use the same selected profile,
    // including light bundles produced for pull requests.
    const manifestStep = workflow.slice(
      workflow.indexOf('name: Create and verify distribution manifest'),
      workflow.indexOf('id: bundle')
    );
    expect(manifestStep).toContain('RUNTIME_PROFILE: $' + '{{ inputs.runtime_profile }}');
    expect(workflow.match(/overwrite: false/g)).toHaveLength(13);
    expect(workflow).toContain('actions/attest-build-provenance@');
    expect(workflow).toMatch(
      /subject-path: \|\n\s+\.distribution-bundles\/\*\.tar\n\s+\.distribution-bundles\/\*\.tar\.gz/
    );
  });

  test('a matching-host runtime probe can replace its receipt on a job retry', () => {
    const workflow = readText('.github/workflows/distribution-build.yml');
    const probe = extractJobBlock(workflow, 'runtime-version');
    const upload = extractStepBlocks(probe).find((step) =>
      step.includes('name: Upload the native runtime version receipt')
    );
    expect(upload, 'expected the runtime version receipt upload').toBeDefined();
    expect(upload).toContain('uses: actions/upload-artifact@');
    expect(upload).toContain(
      'name: runtime-version-$' + '{{ inputs.source_sha }}-$' + '{{ matrix.platform }}'
    );
    expect(upload, 'expected the source-and-platform receipt to be replaceable on retry').toContain(
      'overwrite: true'
    );
  });

  test('the runtime producer records one receipt per target for distribution pairing', () => {
    const workflow = readText('.github/workflows/distribution-build.yml');
    const runtime = readText('.github/workflows/runtime-build.yml');

    expect(extractJobBlock(workflow, 'runtime')).toContain(
      'uses: $/.github/workflows/runtime-build.yml'
    );

    // Every release target is in the default matrix, each leg builds exactly
    // one, and zig is fetched only against a pinned checksum.
    for (const target of ALL_BINARY_TARGETS) expect(runtime).toContain(`"${target.arch}"`);
    expect(runtime).toContain('args=(--platform "$PLATFORM" --zig --rustup');
    expect(runtime).toContain('args+=(--artifact-profile "$ARTIFACT_PROFILE")');
    expect(runtime).toContain(
      "inputs.mode == 'artifact' && inputs.record_receipts && inputs.profile"
    );
    expect(runtime).toContain('bun --no-install ./scripts/build-runtime.ts "$' + '{args[@]}"');
    expect(runtime).toContain('uses: ./.github/actions/setup-zigbuild');
    const zigbuild = readText('.github/actions/setup-zigbuild/action.yml');
    expect(zigbuild).toMatch(/ZIG_SHA256: [0-9a-f]{64}\n/);
    expect(zigbuild).toContain('sha256sum --check --strict');
    expect(zigbuild).toContain('tool: cargo-zigbuild@0.24.1');
  });

  test('published builds never restore the runtime cargo cache, and only main saves it', () => {
    const runtime = readText('.github/workflows/runtime-build.yml');
    const cacheStep = extractStepBlocks(runtime).find((step) => step.includes('id: rust-cache'));

    expect(cacheStep, 'runtime-build.yml rust-cache step').toContain('uses: Swatinem/rust-cache@');
    expect(cacheStep).toContain('if: inputs.cache');
    expect(cacheStep).toContain('save-if: $' + "{{ github.ref == 'refs/heads/main' }}");
    // Canary publishes main's CI distribution, so main only looks the entry up
    // and saves a clean build when it is stale; it never restores one.
    expect(cacheStep, 'runtime-build.yml rust-cache restores on main').toContain(
      'lookup-only: $' + "{{ github.ref == 'refs/heads/main' }}"
    );
    expect(runtime).toMatch(/\n {6}cache:\n(?: {8}.*\n)*? {8}default: false\n/);

    // Release bytes never start from restored build state: the release path,
    // and the distribution build it shares, never opt in.
    const distribution = readText('.github/workflows/distribution-build.yml');
    expect(extractJobBlock(distribution, 'runtime')).toContain('cache: $' + '{{ inputs.cache }}');
    expect(distribution).toMatch(/\n {6}cache:\n(?: {8}.*\n)*? {8}default: false\n/);
    expect(readText('.github/workflows/release.yml'), 'release.yml cargo cache').not.toMatch(
      /\n\s+cache:/
    );
    // PRs reuse distribution bytes; scheduled/manual producers stay clean.
    expect(
      extractJobBlock(readText('.github/workflows/release-dry-run.yml'), 'runtime'),
      'release-dry-run.yml runtime job cargo cache'
    ).toContain('cache: false');
    expect(extractJobBlock(readText('.github/workflows/ci.yml'), 'distribution')).toContain(
      'cache: true'
    );
    expect(extractJobBlock(readText('.github/workflows/smoke-binary.yml'), 'runtime')).toContain(
      'cache: true'
    );
  });

  test('runtime builds retry Bun setup once before starting Cargo', () => {
    const runtime = extractJobBlock(readText('.github/workflows/runtime-build.yml'), 'runtime');
    const steps = extractStepBlocks(runtime);
    const setup = steps.filter((step) => step.includes('uses: oven-sh/setup-bun@'));
    expect(setup, `expected 2 Bun setup attempts | received: ${setup.length}`).toHaveLength(2);
    const [first, retry] = setup;
    const failedSetup = "if: steps.setup-bun.outcome == 'failure'";
    expect(first).toContain('id: setup-bun');
    expect(first).toContain('continue-on-error: true');
    expect(first).toContain("if: steps.seed-cache.outputs.cache-hit != 'true'");
    expect(retry).toContain(failedSetup);
    expect(retry).not.toContain('continue-on-error:');
    for (const attempt of setup) expect(attempt).toContain('bun-version-file: .bun-version');
    const uses = /uses: oven-sh\/setup-bun@[a-f0-9]{40}/;
    expect(first.match(uses)?.[0]).toBe(retry.match(uses)?.[0]);
    const wait = steps[steps.indexOf(first) + 1];
    expect(wait).toContain(failedSetup);
    expect(wait).toContain('run: sleep 10');
    expect(steps[steps.indexOf(first) + 2]).toBe(retry);
    const build = steps.findIndex((step) => step.includes('name: Build runtime'));
    expect(build, 'expected a runtime build after Bun setup').toBeGreaterThan(steps.indexOf(retry));
  });

  test('archive upload payloads skip artifact re-compression', () => {
    const uploads = workflowFiles().flatMap((path) =>
      uploadArtifactSteps(readText(path)).map((step) => ({
        path,
        step,
        archive: uploadPaths(step).some((payload) => ARCHIVE_PAYLOAD.test(payload)),
        preparedBinaryInputs:
          path === '.github/workflows/distribution-build.yml' &&
          uploadPaths(step).some(
            (payload) => payload.startsWith('.mango/out/') || payload === 'apps/frontend/dist'
          ),
      }))
    );

    // Eleven distribution bundles, the dry-run's windows-x64 zip and the
    // frozen canary approval archive; a fourteenth must make the same decision deliberately, instead of quietly
    // re-Deflating a payload whose compression `bundle-distribution.ts` (or,
    // for the dry run, archive-assets.ts) already chose — or already chose to
    // skip.
    expect(uploads.filter((upload) => upload.archive)).toHaveLength(13);
    for (const { path, step, archive, preparedBinaryInputs } of uploads) {
      // Anchored so a commented-out key can neither satisfy nor trip the policy.
      if (archive || preparedBinaryInputs) expect(step, path).toMatch(/^\s*compression-level: 0$/m);
      else expect(step, path).not.toMatch(/^\s*compression-level:/m);
    }
  });

  test('bundle names state whether the payload is compressed', () => {
    const workflow = readText('.github/workflows/distribution-build.yml');

    // The name is the contract the download action globs on and the only
    // signal a human untarring one by hand gets.
    expect(bundleFileName('assets', SCOPED_BUNDLE_COMPRESSION)).toBe('assets.tar.gz');
    expect(bundleFileName('linux-x64', TARGET_BUNDLE_COMPRESSION)).toBe('linux-x64.tar');

    for (const scope of ['checksums', 'assets', 'npm']) {
      expect(workflow, scope).toContain(
        `path: .distribution-bundles/${bundleFileName(scope, SCOPED_BUNDLE_COMPRESSION)}`
      );
    }
    for (const target of ALL_BINARY_TARGETS) {
      expect(workflow, target.arch).toContain(
        `path: .distribution-bundles/${bundleFileName(target.arch, TARGET_BUNDLE_COMPRESSION)}`
      );
    }

    // The consumer resolves exactly one bundle, so its glob has to cover both
    // shapes; attestation coverage is asserted with the rest of that workflow.
    expect(readText('.github/actions/download-distribution/action.yml')).toContain(
      'bundles=("$DOWNLOAD_DIR"/*.tar "$DOWNLOAD_DIR"/*.tar.gz)'
    );
  });

  test('binary and Docker smoke consume target artifacts without rebuilding by default', () => {
    const workflow = readText('.github/workflows/smoke-binary.yml');
    const skipBuildExpression = '$' + "{{ inputs.rebuild && '0' || '1' }}";

    expect(workflow.match(/uses: \.\/\.github\/actions\/download-distribution/g)).toHaveLength(2);
    for (const job of ['binary']) {
      const jobBlock = extractJobBlock(workflow, job);
      const setupBunIndex = jobBlock.indexOf('uses: oven-sh/setup-bun@');
      // A missing step yields -1, which would satisfy the ordering check alone.
      expect(setupBunIndex, job).toBeGreaterThanOrEqual(0);
      expect(setupBunIndex).toBeLessThan(
        jobBlock.indexOf('uses: ./.github/actions/download-distribution')
      );
    }
    expect(workflow).toContain(`SKIP_BUILD: ${skipBuildExpression}`);
    const dockerAssertions = extractStepBlocks(extractJobBlock(workflow, 'binary')).filter((step) =>
      step.includes('scripts/release/smoke-docker-image.sh')
    );
    expect(dockerAssertions).toHaveLength(2);
    for (const step of dockerAssertions) {
      expect(step).toContain('REBUILD: $' + '{{ inputs.rebuild }}');
      expect(step).toContain('if [ "$REBUILD" = "true" ]; then');
      if (step.includes('name: Run Alpine Docker smoke test')) {
        expect(step).toContain('tar --exclude=node_modules');
        expect(step).toContain('oven/bun:$' + '{BUN_CHANNEL}-alpine');
        expect(step).toContain('bun install --frozen-lockfile');
        expect(step).toContain('-e RUNTIME_DIR=.mango/runtime-prebuilt');
        expect(step).toContain('-e SKIP_BUILD=0');
        expect(step).toContain('bun --no-install .mango/smoke/test-build.mjs');
      } else {
        expect(step).toContain('bun run build:binary --platform "$BINARY_PLATFORM"');
      }
    }
  });

  test('the manual rebuild stages release-built cargo runtimes into every leg, never skipping one', () => {
    const workflow = readText('.github/workflows/smoke-binary.yml');
    const runtime = extractJobBlock(workflow, 'runtime');
    const gate =
      'if: $' +
      "{{ !cancelled() && (needs.runtime.result == 'success' || (needs.runtime.result == 'skipped' && !inputs.rebuild)) }}";

    expect(runtime).toContain('uses: $/.github/workflows/runtime-build.yml');
    expect(runtime).toContain('if: $' + '{{ inputs.rebuild }}');
    for (const job of ['binary']) {
      const block = extractJobBlock(workflow, job);
      expect(parseNeeds(block), job).toEqual(['runtime']);
      // A failed runtime build fails the legs' dependency instead of letting
      // them run without a runtime; a skipped one is only fine off the rebuild path.
      expect(block, job).toContain(gate);
      expect(block, job).toContain('name: smoke-rebuild-runtime-$' + '{{ matrix.');
    }
    expect(extractJobBlock(workflow, 'binary')).toContain('RUNTIME_DIR: .mango/runtime-prebuilt');
    expect(extractJobBlock(workflow, 'binary')).toContain(
      'bun run build:binary --platform "$BINARY_PLATFORM" --runtime-dir .mango/runtime-prebuilt'
    );
    const runtimeDownloads = extractStepBlocks(extractJobBlock(workflow, 'binary')).filter((step) =>
      step.includes('name: smoke-rebuild-runtime-')
    );
    expect(runtimeDownloads).toHaveLength(2);
    expect(runtimeDownloads[0]).toContain(
      'name: smoke-rebuild-runtime-$' + '{{ matrix.platform }}'
    );
    expect(runtimeDownloads[1]).toContain(
      'name: smoke-rebuild-runtime-$' + '{{ matrix.musl_platform }}'
    );
    expect(runtimeDownloads[1]).toContain(
      'if: $' +
        "{{ !cancelled() && steps.ready.outcome == 'success' && matrix.docker_arch && inputs.rebuild }}"
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

    // Every channel but cargo-publish also needs `prepare`, which is where the
    // pre-release classification each of them reads is resolved.
    expectJobNeeds(workflow, 'github-release', String.raw`\[prepare, build, verify-build\]`);
    expectJobNeeds(workflow, 'docker', String.raw`\[prepare, build, verify-build\]`);
    expectJobNeeds(workflow, 'npm-publish', String.raw`\[prepare, build, verify-build\]`);
    expectJobNeeds(
      workflow,
      'homebrew',
      String.raw`\[prepare, build, verify-build, github-release\]`
    );
    expectJobNeeds(workflow, 'scoop', String.raw`\[prepare, build, verify-build, github-release\]`);
    expectJobNeeds(workflow, 'cargo-publish', String.raw`\[build, verify-build, github-release\]`);
  });

  test('one pre-release decision reaches every channel that has a stable pointer', () => {
    // The consequence of two channels disagreeing is not cosmetic: the GitHub
    // "Latest" marker is what scripts/install/install.sh resolves, and npm
    // `latest` is what `npm install -g mangostudio` reads. A release candidate
    // that is a pre-release on one and the current version on the other is
    // worse than one that is neither. So the rule is derived once, in `prepare`,
    // and every channel reads that output.
    const workflow = readText('.github/workflows/release.yml');
    const outputPrefix = '$' + '{{ steps.resolve.outputs.';
    const needsPrerelease = '$' + '{{ needs.prepare.outputs.prerelease }}';

    expect(extractJobBlock(workflow, 'prepare')).toContain(`prerelease: ${outputPrefix}prerelease`);

    // Channels that publish a moving pointer branch on it; cargo-publish does
    // not, because crates.io excludes pre-release versions from `cargo install`
    // resolution on its own.
    for (const job of ['github-release', 'docker']) {
      expect(extractJobBlock(workflow, job), job).toContain(`PRERELEASE: ${needsPrerelease}`);
    }
    for (const job of ['homebrew', 'scoop']) {
      expect(extractJobBlock(workflow, job), job).toContain(
        "if: needs.prepare.outputs.prerelease == 'false'"
      );
    }
    expect(extractJobBlock(workflow, 'cargo-publish')).not.toContain('PRERELEASE');

    // A second derivation is the failure mode this shape exists to prevent: a
    // channel that re-answered "is this a pre-release" from $VERSION could drift
    // from the rest of the train without anything failing. Scoped to `prepare`
    // and then to "no other job assigns it": a whole-file scan for the literal
    // glob `*-*` is neither necessary — a second derivation spells itself
    // `*"-"*` or `*-rc.*` just as easily — nor sufficient, since an unrelated
    // comment or a `--platform` list carrying `*-*` would red-fail the suite.
    const derivations = extractJobBlock(workflow, 'prepare')
      .split('\n')
      .filter((line) => line.includes('*-*'));
    expect(derivations).toHaveLength(1);
    expect(derivations[0]).toContain('prerelease=true');
    for (const { job, block } of extractJobBlocks(workflow)) {
      if (job === 'prepare') continue;
      expect(block, job).not.toContain('prerelease=');
    }
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
    // a workflow, and Bun lint reads `${...}` in a plain string as a template
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

  test('launcher release lanes use the workspace MSRV for rustup and the installed compiler', () => {
    const workspace = Bun.TOML.parse(readText('Cargo.toml')) as {
      workspace: { package: { 'rust-version': string } };
    };
    const floor = workspace.workspace.package['rust-version'];

    for (const [file, job] of [
      ['release.yml', 'cargo-publish'],
      ['release.yml', 'verify-cargo'],
      ['release-dry-run.yml', 'dry-run-cargo'],
    ]) {
      const block = extractJobBlock(readText(`.github/workflows/${file}`), job);
      expect(block, `${file}: ${job}`).toContain(`RUSTUP_TOOLCHAIN: ${floor}`);
      const compilers = extractStepBlocks(block).filter((step) =>
        step.includes('uses: dtolnay/rust-toolchain@')
      );
      expect(compilers, `${file}: ${job} compiler setup`).toHaveLength(1);
      expect(compilers[0], `${file}: ${job} compiler version`).toContain(`toolchain: ${floor}`);
    }
  });

  test('launcher publication and dry run verify a packaged outside-workspace install', () => {
    const cargoPublish = extractJobBlock(
      readText('.github/workflows/release.yml'),
      'cargo-publish'
    );
    const dryRun = extractJobBlock(
      readText('.github/workflows/release-dry-run.yml'),
      'dry-run-cargo'
    );
    const verifier = 'bash scripts/release/verify-launcher-package.sh';

    expect(cargoPublish).toContain(verifier);
    expect(dryRun).toContain(verifier);
    expect(dryRun).not.toContain('working-directory: crates/mangostudio-launcher');
    expect(dryRun).toContain(
      'cargo publish --dry-run --locked --manifest-path crates/mangostudio-launcher/Cargo.toml'
    );
    expect(dryRun.indexOf(verifier)).toBeLessThan(dryRun.indexOf('cargo publish --dry-run'));
    expect(cargoPublish.indexOf(verifier)).toBeLessThan(
      cargoPublish.indexOf('cargo publish --locked')
    );
  });

  test('launcher dry run selects compiler pins and packaged verifier changes', () => {
    const workflow = readText('.github/workflows/release-dry-run.yml');
    expect(workflow).toContain('bun ./scripts/ci/changed-paths.ts release');
    const pattern = LAUNCHER_PATTERN;

    for (const path of [
      'crates/mangostudio-launcher/src/main.rs',
      'Cargo.toml',
      'Cargo.lock',
      'rust-toolchain.toml',
      '.github/workflows/release.yml',
      '.github/workflows/release-dry-run.yml',
      'scripts/release/verify-launcher-package.sh',
    ]) {
      expect(path).toMatch(pattern);
    }
    expect('apps/api/src/app.ts').not.toMatch(pattern);
    expect('scripts/release/pack-npm.ts').not.toMatch(pattern);
  });

  test('release dry run relevance pattern mirrors the release import graph', () => {
    const workflow = readText('.github/workflows/release-dry-run.yml');
    expect(workflow).toContain('bun ./scripts/ci/changed-paths.ts collect');
    expect(workflow).toContain('bun ./scripts/ci/changed-paths.ts release');

    const pattern = RELEASE_PATTERN;

    // Everything the release actually imports marks the dry run relevant…
    expect('.github/workflows/release.yml').toMatch(pattern);
    expect('.github/workflows/release-dry-run.yml').toMatch(pattern);
    expect('.github/workflows/canary.yml').toMatch(pattern);
    expect('scripts/release/pack-npm.ts').toMatch(pattern);
    expect('scripts/install/install.sh').toMatch(pattern);
    expect('scripts/build.ts').toMatch(pattern);
    expect('scripts/lib/release-assets.ts').toMatch(pattern);
    expect('packages/cli/package.json').toMatch(pattern);
    expect('crates/mangostudio-launcher/src/main.rs').toMatch(pattern);
    expect('Cargo.toml').toMatch(pattern);
    expect('Cargo.lock').toMatch(pattern);
    expect('Dockerfile').toMatch(pattern);
    // The runtime that ships beside the hub is the cargo crate, built by its own workflow.
    expect('crates/mangostudio-runtime/src/main.rs').toMatch(pattern);
    expect('.github/workflows/runtime-build.yml').toMatch(pattern);
    expect('scripts/build-runtime.ts').toMatch(pattern);
    expect('rust-toolchain.toml').toMatch(pattern);
    expect('.cargo/config.toml').toMatch(pattern);
    expect('.github/actions/setup-zigbuild/action.yml').toMatch(pattern);

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

  test('release dry run verifies the install layout and lifecycle', () => {
    const workflow = readText('.github/workflows/release-dry-run.yml');
    const installDirVar = '$' + '{MANGOSTUDIO_INSTALL_DIR}';

    expect(workflow).toContain('name: Verify install layout');
    expect(workflow).toContain(`readlink "${installDirVar}/current"`);
    expect(workflow).toContain(`${installDirVar}/current/mangostudio`);
    expect(workflow).toContain('name: Verify install lifecycle (--use, --prune, --uninstall)');
    expect(workflow).toContain('bash scripts/install/install.sh --use "$DRY_RUN_VERSION"');
    expect(workflow).toContain('bash scripts/install/install.sh --prune');
    expect(workflow).toContain('bash scripts/install/install.sh --uninstall');
  });

  test('release dry run guards the embedded installers against drift from the committed scripts', () => {
    const workflow = readText('.github/workflows/release-dry-run.yml');

    // The `__installer <sh|ps1>` command prints the embedded script verbatim;
    // this only proves out once that command lands, but the guard belongs on
    // the branch either way.
    expect(workflow).toContain('name: Verify the embedded installers match the committed scripts');
    expect(workflow).toContain('__installer sh | diff - scripts/install/install.sh');
    expect(workflow).toContain('__installer ps1 | diff - scripts/install/install.ps1');
  });

  test('both dry-run jobs make the installed binary detect its own moved install root', () => {
    // The dry run installs under RUNNER_TEMP, not the default root, so this is
    // the one CI path that runs origin detection on a MANGOSTUDIO_INSTALL_DIR
    // layout — the case a hand-run of the built binary first caught.
    const workflow = readText('.github/workflows/release-dry-run.yml');
    const linux = extractJobBlock(workflow, 'dry-run-linux');
    const windows = extractJobBlock(workflow, 'dry-run-windows');
    for (const block of [linux, windows]) {
      expect(block).toContain('upgrade --check --json');
      expect(block).toContain('self-managed');
    }
    expect(linux).toContain("jq -r '.installedVia.manager'");
    expect(windows).toContain('$report.installedVia.manager');
  });

  test('reuse dry runs preserve verified hubs and packaging inputs without rebuilding', () => {
    const workflow = readText('.github/workflows/release-dry-run.yml');
    for (const [job, platform] of [
      ['dry-run-linux', 'linux-x64'],
      ['dry-run-windows', 'windows-x64'],
    ]) {
      const steps = extractStepBlocks(extractJobBlock(workflow, job));
      const build = steps.find((step) => step.includes(`build --binary --platform ${platform}`));
      expect(build, `${platform} builds only on the independent clean route`).toContain(
        'if: $' + '{{ !inputs.reuse_distribution }}'
      );
      const frontend = steps.find((step) =>
        step.includes('name: Download prepared packaging inputs')
      );
      expect(frontend).toContain('if: inputs.reuse_distribution');
      expect(frontend).toContain('name: hub-inputs-$' + '{{ inputs.source_sha }}');
      const stage = steps.find((step) => step.includes('name: Stage verified standalone README'));
      expect(stage).toContain(`cp .mango/out/${platform}/README.md .mango/out/README.md`);
      const archive = steps.find((step) =>
        step.includes(`archive-assets.ts --platform ${platform}`)
      );
      expect(archive).not.toMatch(/^ {8}if:/m);
    }
    const windows = extractJobBlock(workflow, 'dry-run-windows');
    expect(windows).toContain('name: Download immutable Windows distribution');
    expect(windows).toContain(
      'runtime-profile: $' + "{{ github.event_name == 'pull_request' && 'light' || 'shipping' }}"
    );
  });

  test('release dry run builds and archives windows-x64 on its native Windows runner', () => {
    const workflow = readText('.github/workflows/release-dry-run.yml');
    const linux = extractJobBlock(workflow, 'dry-run-linux');
    const windows = extractJobBlock(workflow, 'dry-run-windows');
    expect(linux).not.toContain('bun run build --binary --platform windows-x64');
    expect(linux).not.toContain('bun ./scripts/release/archive-assets.ts --platform windows-x64');
    // The Linux lane no longer relays the Windows runtime: a relay would make
    // the Windows lane wait for Linux packaging it does not consume.
    expect(linux).not.toContain('windows-x64');
    expect(windows).toContain('runs-on: windows-latest');
    expect(windows).toContain('uses: ./.github/actions/setup-mango');
    expect(windows).toContain('name: dry-run-runtime-windows-x64');
    expect(windows).toContain('path: .mango/runtime-prebuilt\n');
    expect(windows).toContain(
      'bun run build --binary --platform windows-x64 --runtime-dir .mango/runtime-prebuilt'
    );
    expect(windows).not.toContain('--compile-mode bytecode');
    expect(windows).toContain('bun ./scripts/release/archive-assets.ts --platform windows-x64');
    expect(windows).toContain('name: Upload Windows release archive');
    expect(windows).toContain(
      'bun ./scripts/release/verify-checksum.ts release-assets/SHA256SUMS "$archive"'
    );
    const order = [
      'name: Download Windows cargo runtime',
      'name: Build Windows x64 binary',
      'name: Archive Windows release assets',
      'name: Verify archive checksum',
      'name: Install local archive',
    ].map((step) => windows.indexOf(step));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  test('release dry run exercises install.ps1 on a real Windows runner', () => {
    const workflow = readText('.github/workflows/release-dry-run.yml');
    const windowsBlock = extractJobBlock(workflow, 'dry-run-windows');

    expect(windowsBlock).toContain('runs-on: windows-latest');
    // The mandatory Windows compat target is 5.1, not the runner's newer pwsh
    // default.
    expect(windowsBlock).toContain('shell: powershell');
    expect(windowsBlock).toContain('actions/download-artifact@');
    expect(windowsBlock).toContain('name: windows-x64-dry-run');
    expect(windowsBlock).toContain('install.ps1 -Local');
    expect(windowsBlock).toContain('install.ps1 -Use');
    expect(windowsBlock).toContain('install.ps1 -Prune');
    expect(windowsBlock).toContain('install.ps1 -Uninstall');
  });

  test('release dry run runs the install.ps1 failed-probe and npm tarball cases on Windows and is relevant to them', () => {
    const workflow = readText('.github/workflows/release-dry-run.yml');
    const windowsBlock = extractJobBlock(workflow, 'dry-run-windows');

    // Linux skips install-ps1-layout.unit.test.ts for want of a Windows
    // PowerShell, so this job is the only place the fake-binary cases and the
    // GNU-tar-first tarball case run.
    expect(windowsBlock).toContain("-t 'failed version probe|npm tarball extraction'");
    expect(windowsBlock).toContain('scripts/tests/install-ps1-layout.unit.test.ts');
    expect(windowsBlock).toContain('MANGOSTUDIO_TEST_NATIVE_FAKES: "1"');

    // `bun test -t` exits 0 while any one alternative matches, so a renamed
    // describe would drop its cases from this job without failing it.
    const filter = /-t '([^']+)'/.exec(windowsBlock)?.[1] ?? '';
    const layoutCases = readText('scripts/tests/install-ps1-layout.unit.test.ts');
    const describes = [...layoutCases.matchAll(/^describe\('([^']+)'/gm)].map((match) => match[1]);
    for (const name of filter.split('|')) {
      expect(
        describes.filter((title) => title?.includes(name)),
        `expected one describe in install-ps1-layout.unit.test.ts to match "${name}" | received: ${describes.join(', ')}`
      ).toHaveLength(1);
    }

    const relevant = RELEASE_PATTERN;
    expect('scripts/tests/install-ps1-layout.unit.test.ts').toMatch(relevant);

    // The layout cases also run whatever test helpers they import (the user
    // PATH restore among them), so a change to one of those is a change to
    // what the Windows job runs.
    const helpers = [...layoutCases.matchAll(/from '\.\/(support\/[^']+)'/g)].map(
      (match) => `scripts/tests/${match[1]}.ts`
    );
    expect(
      helpers,
      'expected install-ps1-layout.unit.test.ts to import a support helper'
    ).not.toHaveLength(0);
    for (const helper of helpers) {
      expect(
        relevant.test(helper),
        `expected release_pattern to match ${helper} | received: no match in ${RELEASE_PATTERN.source}`
      ).toBe(true);
    }
  });

  test('release dry run relevance pattern does not over-promise Alpine Docker coverage', () => {
    const workflow = readText('.github/workflows/release-dry-run.yml');
    expect(workflow).toContain('bun ./scripts/ci/changed-paths.ts release');

    // The dry-run only builds the Bookworm image, so its relevance pattern
    // must not claim to exercise Dockerfile.alpine; ci.yml's smoke job covers
    // that on every PR.
    expect('Dockerfile.alpine').not.toMatch(RELEASE_PATTERN);
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

    // Release publication lives in the shared helper so canary and stable
    // share the state probe; the workflow only sources and calls it.
    expect(githubReleaseBlock).toContain('source scripts/release/publish-release.sh');
    expect(githubReleaseBlock).toContain('publish_release "$tag" release-assets/* --');
    expect(githubReleaseBlock).toContain('--notes-file RELEASE_NOTES.md');
    expect(githubReleaseBlock).not.toContain('retry_command 3 30 gh release create');
    expect(githubReleaseBlock).not.toContain('if gh release create "$tag"');

    const helper = readText('scripts/release/publish-release.sh');
    expect(helper).toContain('if gh release create "$tag"');
    // Immutable releases: assets go up with create, and nothing edits or
    // uploads onto a release that is already published.
    expect(helper).not.toContain('gh release edit');
    expect(helper).not.toContain('gh release upload');
    expect(helper).toContain('gh release delete "$tag" --yes --cleanup-tag=false');

    expect(cargoPublishBlock).toContain(
      'Stateful retry: scripts/release/retry.sh only repeats one command'
    );
    expect(cargoPublishBlock).toContain(
      '(cd crates/mangostudio-launcher && cargo publish --locked)'
    );
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
    expect(buildBlock).toContain('uses: $/.github/workflows/distribution-build.yml');
  });

  test('docker job consumes only the verified distribution and retries scripted buildx', () => {
    const workflow = readText('.github/workflows/release.yml');
    const dockerBlock = extractJobBlock(workflow, 'docker');
    const versionVar = '$' + '{VERSION}';
    const imageVar = '$' + '{IMAGE}';

    // Publication never silently substitutes bytes from a previous release if
    // the run-scoped immutable artifact is missing or fails verification.
    expect(dockerBlock).toContain('uses: $/.github/actions/download-distribution');
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

  test('canary runs daily independently of CI and promotes the frozen shipping source', () => {
    const ci = readText('.github/workflows/ci.yml');
    const workflow = readText('.github/workflows/canary.yml');
    expect(extractJobBlock(ci, 'canary')).toBe('');
    expect(ci).not.toContain('uses: $/.github/workflows/canary.yml');
    expect(workflow).toContain('cron: "17 6 * * *"');
    expect(workflow).not.toContain('workflow_call:');
    expect(workflow).not.toContain('workflow_run:');
    const source = extractJobBlock(workflow, 'source');
    expect(source).toContain("if: github.ref == 'refs/heads/main'");
    expect(source).toContain('actions: read');
    expect(source).toContain('bun ./scripts/ci/freeze-canary-source.ts resolve');
    expect(source).toContain('bun ./scripts/ci/freeze-canary-source.ts write');
    for (const field of [
      'run_id',
      'run_attempt',
      'run_number',
      'run_url',
      'workflow_id',
      'repository',
      'workflow_path',
    ]) {
      expect(source).toContain(`${field}: ${'$'}{{ steps.source.outputs.${field} }}`);
    }
    expect(source).toContain(`ref: ${'$'}{{ steps.source.outputs.sha }}`);
    expect(source).toContain('EVENT_NAME: push');
    expect(extractJobBlock(workflow, 'build')).toBe('');
    expectJobNeeds(workflow, 'approve', String.raw`\[source\]`);
    for (const job of ['npm-canary', 'github-release-canary']) {
      expectJobNeeds(workflow, job, String.raw`\[source, approve\]`);
      const block = extractJobBlock(workflow, job);
      expect(block).toContain(`source-sha: ${'$'}{{ needs.source.outputs.source_sha }}`);
      expect(block).toContain(`version: ${'$'}{{ needs.source.outputs.version }}`);
      for (const field of [
        'artifact-id',
        'artifact-digest',
        'run-id',
        'run-attempt',
        'producer-attempt',
      ]) {
        expect(block, `${job} ${field}`).toContain(`${field}: ${'$'}{{ steps.approved.outputs.`);
      }
      expect(block).toContain('runtime-profile: shipping');
    }
  });

  test('canary preserves independent channels and recovers only approved bytes', () => {
    const workflow = readText('.github/workflows/canary.yml');
    expect(workflow).toContain('group: canary-publish');
    expect(workflow).toContain('cancel-in-progress: false');
    for (const absent of ['docker-canary', 'crates-canary', 'build']) {
      expect(extractJobBlock(workflow, absent)).toBe('');
    }
    expect(workflow).not.toContain('uses: $/.github/workflows/distribution-build.yml');
    expect(workflow).not.toContain('packages: write');
    expect(workflow).not.toContain('CARGO_REGISTRY_TOKEN');
    const npmBlock = extractJobBlock(workflow, 'npm-canary');
    expect(npmBlock).toContain('scope: npm');
    expect(npmBlock).toContain('environment: canary');
    expect(npmBlock).toContain('actions/setup-node@');
    expect(npmBlock).toContain('uses: $/.github/actions/publish-npm-distribution');
    expect(npmBlock).toContain('dist-tag: canary');
    expect(npmBlock).toContain('promote-canary-tags.ts');
    const releaseBlock = extractJobBlock(workflow, 'github-release-canary');
    expect(releaseBlock).toContain('scope: assets');
    expect(releaseBlock).toContain('stage-approved-canary.ts');
    expect(releaseBlock).toContain('publish-canary.ts');
    expect(releaseBlock).not.toContain('publish-release.sh');
    expect(releaseBlock).not.toContain('gh release delete');
    expect(releaseBlock).not.toContain('github-canary-assets/*');
    expect(releaseBlock).toContain('prune-canary-releases.ts');
    expect(releaseBlock).toContain('continue-on-error: true');
  });

  test('canary always summarizes source, approval and independent channel outcomes', () => {
    const workflow = readText('.github/workflows/canary.yml');
    const summaryBlock = extractJobBlock(workflow, 'canary-summary');
    expectJobNeeds(
      workflow,
      'canary-summary',
      String.raw`\[source, approve, npm-canary, github-release-canary\]`
    );
    expect(summaryBlock).toContain(`if: ${'$'}{{ always() }}`);
    expect(summaryBlock).toContain('summarize-canary-promotion.ts');
    expect(summaryBlock).toContain(`CANARY_NEEDS_JSON: ${'$'}{{ toJSON(needs) }}`);
    expect(summaryBlock).toContain(`WORKFLOW_REVISION: ${'$'}{{ github.sha }}`);
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

  test('only publication scopes receive the main shipping recovery retention', () => {
    const workflow = readText('.github/workflows/distribution-build.yml');
    const ci = extractJobBlock(readText('.github/workflows/ci.yml'), 'distribution');
    expect(ci).toContain('retention_days: 7');
    expect(ci).toContain(
      `publication_retention_days: ${'$'}{{ github.event_name == 'push' && 30 || 7 }}`
    );
    const steps = extractStepBlocks(workflow);
    for (const name of ['checksums', 'assets', 'npm']) {
      const step = steps.find((value) => value.includes(`name: Upload ${name} distribution`));
      expect(step).toContain(
        `retention-days: ${'$'}{{ inputs.publication_retention_days || inputs.retention_days }}`
      );
    }
    const target = steps.find((value) => value.includes('name: Upload linux-x64 target'));
    expect(target).toContain(`retention-days: ${'$'}{{ inputs.retention_days }}`);
    expect(target).not.toContain('inputs.publication_retention_days');
  });

  test('PR validation uploads target bundles while publication consumers retain aggregates', () => {
    const workflow = readText('.github/workflows/distribution-build.yml');
    const build = extractJobBlock(workflow, 'build');
    const steps = extractStepBlocks(build);
    const input = '$' + '{{ inputs.publication_bundles }}';
    const definition = Bun.YAML.parse(workflow) as {
      on: { workflow_call: { inputs: Record<string, { type: string; default: boolean }> } };
    };
    expect(
      definition.on.workflow_call.inputs.publication_bundles,
      'expected a boolean publication_bundles input; received no publication scope'
    ).toBeDefined();
    expect(definition.on.workflow_call.inputs.publication_bundles).toMatchObject({
      type: 'boolean',
      default: true,
    });
    const ci = extractJobBlock(readText('.github/workflows/ci.yml'), 'distribution');
    expect(ci).toContain(`publication_bundles: ${'$'}{{ github.event_name != 'pull_request' }}`);
    for (const scope of ['checksums', 'assets', 'npm']) {
      const upload = steps.find((step) => step.includes(`name: Upload ${scope} distribution`));
      expect(upload, `${scope} upload must have an explicit publication scope`).toContain(
        `if: ${input}`
      );
      expect(build).toContain(
        `${scope}_artifact: ${'$'}{{ inputs.publication_bundles && steps.bundle.outputs.${scope}_artifact || '' }}`
      );
    }
    for (const { arch } of ALL_BINARY_TARGETS) {
      const upload = steps.find((step) => step.includes(`name: Upload ${arch} target`));
      expect(upload, `${arch} smoke bundle must remain available on PRs`).toBeDefined();
      expect(upload).not.toMatch(/^ {8}if:/m);
    }
    // Scope only the uploads: packaging, archives and manifests still validate
    // the complete distribution on PRs before any target can be consumed.
    for (const name of [
      'Assemble npm distribution',
      'Archive release assets',
      'Create and verify distribution manifest',
      'Create content-addressed bundles',
    ]) {
      const step = steps.find((entry) => entry.includes(`name: ${name}`));
      expect(step, name).toBeDefined();
      expect(step, name).not.toMatch(/^ {8}if:/m);
    }
    for (const job of ['smoke', 'smoke-container', 'release-dry-run']) {
      const consumer = extractJobBlock(readText('.github/workflows/ci.yml'), job);
      expect(consumer).toContain('needs.distribution.outputs.target_artifacts');
      expect(consumer).not.toMatch(/needs\.distribution\.outputs\.(checksums|assets|npm)_artifact/);
    }
    const release = extractJobBlock(readText('.github/workflows/release.yml'), 'build');
    expect(release).not.toContain('publication_bundles: false');
  });

  test('the checksums scope stays small enough to be worth splitting out', () => {
    expect(checksumsBundleMembers(true)).toEqual([
      'distribution-manifest.json',
      'release-assets/SHA256SUMS',
      'ci-push-context.json',
    ]);
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
    const bashSource = '$' + '{BASH_SOURCE[0]}';

    expect(helper).toContain('"$binary_path" --version');
    expect(helper).toContain('unset API_HOST MANGOSTUDIO_DEFAULT_API_HOST');
    expect(helper).toContain('expected default bind: localhost');
    // The server boots from a staged copy of the binary with a doctored stale
    // public/ sidecar beside it, proving the embedded frontend wins.
    expect(helper).toContain('"$staged_binary" serve "$port"');
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
