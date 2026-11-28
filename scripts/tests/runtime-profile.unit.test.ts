import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ROOT_DIR } from '../lib/config';
import { ALL_BINARY_TARGETS } from '../lib/release-targets';
import { unstampedArtifactName } from '../lib/runtime-input-digest';
import { runCompositeStep } from './support/cache-scoped-steps';
import { readText } from './support/read-text';
import {
  extractJobBlock,
  extractJobBlocks,
  extractStepBlocks,
  parseNeedsList,
} from './support/workflow-blocks';
import { workflowFiles } from './support/workflow-files';

const EXPR = '$' + '{{';
const PROFILE_SELECTION = `${EXPR} github.event_name == 'pull_request' && 'light' || 'shipping' }}`;
const RUNTIME_WORKFLOW = '.github/workflows/runtime-build.yml';
const DISTRIBUTION_WORKFLOW = '.github/workflows/distribution-build.yml';

// Swatinem/rust-cache v2.9.3 src/config.ts lines 104-133: SHA1 of rustVersions followed by
// sorted, nonempty variables matching these prefixes. restoreKey is assigned before the lock
// hash is appended.
// Source: https://github.com/Swatinem/rust-cache/blob/d1527c8f67ef9af357290475d4af4b0fab8f12e0/src/config.ts#L104-L133
const RUST_VERSIONS = '1.99.0 x86_64-unknown-linux-gnu fixture';

function hashEnv(overrides: Record<string, string>): string {
  const env: Record<string, string> = { CARGO_HOME: '/ci/cargo', ...overrides };
  const hash = createHash('sha1').update(RUST_VERSIONS);
  for (const key of Object.keys(env).sort((a, b) => a.localeCompare(b))) {
    const value = env[key];
    if (
      ['CARGO', 'CC', 'CFLAGS', 'CXX', 'CMAKE', 'RUST'].some((prefix) => key.startsWith(prefix)) &&
      value
    ) {
      hash.update(`${key}=${value}`);
    }
  }
  return hash.digest('hex').substring(0, 8);
}

const RUST_CACHE_ACTION = '.github/actions/rust-cache/action.yml';

// The digest the composite's `profile` step prints for the root manifest, from the script as
// shipped. The key's prefix is `v0-rust-profile-<digest>`, from the action's `prefix-key` input.
const ROOT_PROFILE_DIGEST = await (async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mango-runtime-profile-digest-'));
  try {
    copyFileSync(join(ROOT_DIR, 'Cargo.toml'), join(dir, 'Cargo.toml'));
    const run = await runCompositeStep(
      'profile',
      { PROFILE_MANIFEST: 'Cargo.toml' },
      dir,
      RUST_CACHE_ACTION
    );
    const digest = run.outputs.digest;
    if (!/^[a-f0-9]{64}$/.test(digest ?? '')) {
      throw new Error(
        `expected the profile step to print a 64-hex digest | received: ${digest} (exit ${run.exitCode}: ${run.stderr})`
      );
    }
    return digest;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();
const ROOT_PROFILE_PREFIX = `v0-rust-profile-${ROOT_PROFILE_DIGEST}`;

function cacheStep(): string {
  const runtime = extractJobBlock(readText(RUNTIME_WORKFLOW), 'runtime');
  const steps = extractStepBlocks(runtime).filter((step) => /^ {8}id: rust-cache$/m.test(step));
  if (steps.length !== 1) {
    throw new Error(
      `expected exactly one rust-cache step in ${RUNTIME_WORKFLOW} | received: ${steps.length}`
    );
  }
  return steps[0];
}

function cacheInput(step: string, name: string): string {
  const value = new RegExp(`^ {10}${name}: (.+)$`, 'm').exec(step)?.[1];
  if (!value) throw new Error(`expected a ${name} input on the rust-cache step | received: none`);
  return value;
}

/** An input the step sets, or undefined. */
function optionalCacheInput(step: string, name: string): string | undefined {
  return new RegExp(`^ {10}${name}: (.+)$`, 'm').exec(step)?.[1];
}

// Resolves only the expressions the cache key is built from. Anything else is an error, so a new
// input cannot enter the key without this test learning about it.
function resolveKeyExpression(raw: string, platform: string): string {
  return raw.replace(/\$\{\{ (.+?) \}\}/g, (_match, expression: string) => {
    if (expression === 'matrix.platform') return platform;
    throw new Error(`expected a cache key expression: matrix.platform | received: ${expression}`);
  });
}

interface CacheScenario {
  mode: string;
  profile: string;
  event: string;
  ref: string;
}

/** The key rust-cache computes for a run: prefix, shared key, runner, environment hash, lock hash. */
function rustCacheKey(scenario: CacheScenario, platform: string, lockHash: string): string {
  const step = cacheStep();
  // The prefix is the composite's: the step names no profile manifest of its own, so it digests
  // the root one, and passes no `prefix-key` to override it.
  expect(optionalCacheInput(step, 'prefix-key'), 'the step must not set its own prefix').toBe(
    undefined
  );
  expect(optionalCacheInput(step, 'profile-manifest'), 'the root manifest must be digested').toBe(
    undefined
  );
  const shared = resolveKeyExpression(cacheInput(step, 'shared-key'), platform);
  return `${ROOT_PROFILE_PREFIX}-${shared}-Linux-x64-${hashEnv(jobProfileEnv(scenario.profile))}-${lockHash}`;
}

/**
 * Evaluates the write gate for a scenario. The gate is the composite's
 * (`inputs.read-only != 'true' && github.ref == 'refs/heads/main'`), so the step must leave
 * `read-only` and `save-if` unset for it to apply.
 */
function cacheWrites(scenario: CacheScenario): boolean {
  const step = cacheStep();
  expect(optionalCacheInput(step, 'read-only'), 'the writer step must not be read-only').toBe(
    undefined
  );
  expect(optionalCacheInput(step, 'save-if'), 'the gate lives in the composite').toBe(undefined);
  expect(readText(RUST_CACHE_ACTION)).toContain(
    `save-if: ${EXPR} inputs.read-only != 'true' && github.ref == 'refs/heads/main' }}`
  );
  return scenario.ref === 'refs/heads/main';
}

const PR_LIGHT: CacheScenario = {
  mode: 'artifact',
  profile: 'light',
  event: 'pull_request',
  ref: 'refs/pull/7/merge',
};
const MAIN_SEED: CacheScenario = {
  mode: 'cache-seed',
  profile: 'light',
  event: 'push',
  ref: 'refs/heads/main',
};
const MAIN_SHIPPING: CacheScenario = {
  mode: 'artifact',
  profile: 'shipping',
  event: 'push',
  ref: 'refs/heads/main',
};
const PLATFORMS = ALL_BINARY_TARGETS.map((target) => target.arch);

function jobProfileEnv(profile: string): Record<string, string> {
  const runtime = extractJobBlock(readText(RUNTIME_WORKFLOW), 'runtime');
  const mapping =
    /env: \$\{\{ inputs\.profile == 'light' && fromJSON\('([^']+)'\) \|\| fromJSON\('([^']+)'\) \}\}/.exec(
      runtime
    );
  if (!mapping)
    throw new Error('runtime profile overrides must be a conditional job-level env map');
  return JSON.parse(profile === 'light' ? mapping[1] : mapping[2]);
}

function profileGuard(): string {
  const runtime = extractJobBlock(readText(RUNTIME_WORKFLOW), 'runtime');
  const step = extractStepBlocks(runtime).find((block) =>
    block.includes('name: Validate runtime artifact profile')
  );
  if (!step) throw new Error('runtime-build.yml must validate the artifact profile before cache');
  const script = /run: \|\n([\s\S]*)/.exec(step)?.[1];
  if (!script) throw new Error('profile guard must use the tested shell script');
  return script.replace(/^ {10}/gm, '');
}

// The guard's inputs besides the event and profile. Defaults describe an ordinary artifact
// request, so each test names only what it changes.
interface GuardContext {
  mode: string;
  ref: string;
  artifactPrefix: string;
  cache: string;
}

const ARTIFACT_CONTEXT: GuardContext = {
  mode: 'artifact',
  ref: 'refs/heads/main',
  artifactPrefix: 'runtime-fixture',
  cache: 'true',
};

const SEED_CONTEXT: GuardContext = { ...ARTIFACT_CONTEXT, mode: 'cache-seed', artifactPrefix: '' };

function runGuard(
  event: string,
  profile: string,
  overrides: Record<string, string> = {},
  context: Partial<GuardContext> = {}
) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('CARGO_PROFILE_RELEASE_'))
  );
  const resolved = { ...ARTIFACT_CONTEXT, ...context };
  return Bun.spawnSync(['bash', '-euo', 'pipefail', '-c', profileGuard()], {
    env: {
      ...env,
      EVENT_NAME: event,
      BUILD_PROFILE: profile,
      BUILD_MODE: resolved.mode,
      BUILD_REF: resolved.ref,
      ARTIFACT_PREFIX: resolved.artifactPrefix,
      CACHE_ENABLED: resolved.cache,
      ...jobProfileEnv(profile),
      ...overrides,
    },
  });
}

describe('artifact runtime profile guard', () => {
  test.each(['push', 'schedule', 'workflow_dispatch', 'workflow_run', 'release'])(
    '%s refuses light artifacts',
    (event) => {
      const result = runGuard(event, 'light');
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain('expected profile: shipping | received: light');
    }
  );

  test('a tag push refuses light artifacts', () => {
    // Tags use the push event too; a ref exception must never admit light.
    const result = runGuard('push', 'light', { GITHUB_REF: 'refs/tags/v0.2.0' });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('expected profile: shipping | received: light');
  });

  test.each([
    ['CARGO_PROFILE_RELEASE_LTO', 'off', 'lto=off, codegen-units=<unset>'],
    ['CARGO_PROFILE_RELEASE_CODEGEN_UNITS', '16', 'lto=<unset>, codegen-units=16'],
  ])('shipping refuses %s=%j', (key, value, received) => {
    const result = runGuard('push', 'shipping', { [key]: value });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      `expected shipping profile: no lto/codegen-units overrides | received: ${received}`
    );
  });

  test.each(['', 'lite', 'Shipping', 'seed', 'unknown'])(
    'rejects the unrecognized profile %j',
    (profile) => {
      const result = runGuard('pull_request', profile);
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain('expected profile: shipping or light');
    }
  );

  test.each([
    ['CARGO_PROFILE_RELEASE_LTO', 'fat', 'lto=fat, codegen-units=16'],
    ['CARGO_PROFILE_RELEASE_LTO', 'thin', 'lto=thin, codegen-units=16'],
    ['CARGO_PROFILE_RELEASE_CODEGEN_UNITS', '1', 'lto=off, codegen-units=1'],
    ['CARGO_PROFILE_RELEASE_LTO', '', 'lto=<unset>, codegen-units=16'],
    ['CARGO_PROFILE_RELEASE_CODEGEN_UNITS', '', 'lto=off, codegen-units=<unset>'],
  ])('light refuses %s=%j', (key, value, received) => {
    const result = runGuard('pull_request', 'light', { [key]: value });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      `expected light profile: lto=off, codegen-units=16 | received: ${received}`
    );
    expect(result.stdout.toString()).not.toContain('runtime profile: light');
  });

  test('PRs may use light and every event may use shipping', () => {
    const light = runGuard('pull_request', 'light');
    expect(light.exitCode).toBe(0);
    expect(light.stdout.toString()).toContain('runtime profile: light (lto=off, codegen-units=16)');
    for (const event of ['pull_request', 'push', 'schedule', 'workflow_dispatch', 'release']) {
      const shipping = runGuard(event, 'shipping');
      expect(shipping.exitCode).toBe(0);
      expect(shipping.stdout.toString()).toContain(
        'runtime profile: shipping (lto=fat, codegen-units=1)'
      );
    }
  });

  test('a main push in artifact mode still refuses light artifacts', () => {
    // The seed path must not loosen the artifact check: main plus light stays shipping-only.
    const result = runGuard('push', 'light', {}, { mode: 'artifact', ref: 'refs/heads/main' });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('expected profile: shipping | received: light');
  });

  test.each(['', 'seed', 'Cache-Seed', 'cache_seed'])(
    'rejects the unrecognized mode %j',
    (mode) => {
      const result = runGuard('push', 'shipping', {}, { mode });
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain(
        `expected mode: artifact or cache-seed | received: ${mode}`
      );
    }
  );

  test('an artifact request needs an artifact prefix to name its upload', () => {
    const result = runGuard('push', 'shipping', {}, { artifactPrefix: '' });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      'expected artifact mode artifact_prefix: non-empty | received: <empty>'
    );
  });
});

describe('cache-seed runtime mode', () => {
  test('a main push may seed the light cache without an artifact name', () => {
    const result = runGuard('push', 'light', {}, SEED_CONTEXT);
    expect(result.stderr.toString()).toBe('');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain(
      'runtime profile: light (lto=off, codegen-units=16)'
    );
    expect(result.stdout.toString()).toContain('runtime mode: cache-seed');
  });

  test.each([
    ['pull_request', 'refs/heads/main'],
    ['pull_request', 'refs/pull/7/merge'],
    ['push', 'refs/heads/feature'],
    ['push', 'refs/tags/v0.2.0'],
    ['workflow_dispatch', 'refs/heads/main'],
    ['schedule', 'refs/heads/main'],
    ['workflow_run', 'refs/heads/main'],
    ['release', 'refs/tags/v0.2.0'],
  ])('%s on %s cannot seed', (event, ref) => {
    const result = runGuard(event, 'light', {}, { ...SEED_CONTEXT, ref });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      `expected cache-seed context: event=push, ref=refs/heads/main | received: event=${event}, ref=${ref}`
    );
    expect(result.stdout.toString()).not.toContain('runtime profile:');
  });

  test.each(['shipping', 'lite', ''])('a seed of profile %j is refused', (profile) => {
    const result = runGuard('push', profile, {}, SEED_CONTEXT);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      `expected cache-seed profile: light | received: ${profile}`
    );
  });

  test('a seed with an artifact prefix is refused so it has no upload name', () => {
    const result = runGuard(
      'push',
      'light',
      {},
      { ...SEED_CONTEXT, artifactPrefix: 'runtime-abc' }
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      'expected cache-seed artifact_prefix: empty | received: runtime-abc'
    );
  });

  test.each(['false', ''])('a seed with the cargo cache set to %j is refused', (cache) => {
    const result = runGuard('push', 'light', {}, { ...SEED_CONTEXT, cache });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      `expected cache-seed cache: true | received: ${cache || '<empty>'}`
    );
  });

  test.each([
    ['CARGO_PROFILE_RELEASE_LTO', 'fat', 'lto=fat, codegen-units=16'],
    ['CARGO_PROFILE_RELEASE_LTO', 'thin', 'lto=thin, codegen-units=16'],
    ['CARGO_PROFILE_RELEASE_CODEGEN_UNITS', '1', 'lto=off, codegen-units=1'],
    ['CARGO_PROFILE_RELEASE_LTO', '', 'lto=<unset>, codegen-units=16'],
  ])('a seed refuses %s=%j so its key cannot drift from the PR key', (key, value, received) => {
    const result = runGuard('push', 'light', { [key]: value }, SEED_CONTEXT);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      `expected light profile: lto=off, codegen-units=16 | received: ${received}`
    );
  });
});

describe('artifact runtime profile guard ordering', () => {
  test('the guard runs before checkout, Cargo setup, cache access and artifact upload', () => {
    const runtime = extractJobBlock(readText(RUNTIME_WORKFLOW), 'runtime');
    const steps = extractStepBlocks(runtime);
    expect(steps[0]).toContain('name: Validate runtime artifact profile');
    expect(steps[0]).toContain(`EVENT_NAME: ${EXPR} github.event_name }}`);
    expect(steps[0]).toContain(`BUILD_PROFILE: ${EXPR} inputs.profile }}`);
    expect(steps[0]).toContain(`BUILD_MODE: ${EXPR} inputs.mode }}`);
    expect(steps[0]).toContain(`BUILD_REF: ${EXPR} github.ref }}`);
    expect(steps[0]).toContain(`ARTIFACT_PREFIX: ${EXPR} inputs.artifact_prefix }}`);
    expect(steps[0]).toContain(`CACHE_ENABLED: ${EXPR} inputs.cache }}`);
    expect(steps[0]).not.toContain('continue-on-error');
    expect(steps[0]).not.toMatch(/^ {8}if:/m);
  });
});

describe('runtime profile callers and cache isolation', () => {
  test('the artifact builder defaults to shipping and applies overrides to the entire job', () => {
    const workflow = readText(RUNTIME_WORKFLOW);
    expect(workflow).toMatch(/\n {6}profile:\n(?: {8}.*\n)*? {8}default: shipping\n/);
    const runtime = extractJobBlock(workflow, 'runtime');
    expect(jobProfileEnv('light')).toEqual({
      CARGO_PROFILE_RELEASE_LTO: 'off',
      CARGO_PROFILE_RELEASE_CODEGEN_UNITS: '16',
    });
    expect(jobProfileEnv('shipping')).toEqual({});
    const build = extractStepBlocks(runtime).find((step) => step.includes('name: Build runtime'));
    expect(build).not.toContain('CARGO_PROFILE_RELEASE_');
    const cache = cacheStep();
    expect(cache).toContain('shared-key: runtime-build-');
    expect(cache).toContain(`lookup-only: ${EXPR} github.ref == 'refs/heads/main' }}`);
    // Saving from main only is the composite's default; this step must not turn it off.
    expect(cacheWrites(MAIN_SEED)).toBe(true);
    // rust-cache v2.9.3 hashes CARGO* at job scope into both exact/fallback keys.
    expect(cache).not.toContain('env-vars:');
    expect(cache).not.toContain('restore-keys:');
  });

  test('the pinned cache environment hash keeps shipping stable and light fallback separate', () => {
    expect(hashEnv(jobProfileEnv('shipping'))).toBe(hashEnv({}));
    expect(hashEnv(jobProfileEnv('light'))).not.toBe(hashEnv(jobProfileEnv('shipping')));
  });

  test.each(PLATFORMS)('the %s seed saves the exact key a PR light build restores', (platform) => {
    const lockHash = 'c24d7d16';
    const seedKey = rustCacheKey(MAIN_SEED, platform, lockHash);
    const prKey = rustCacheKey(PR_LIGHT, platform, lockHash);
    expect(seedKey, 'seed save key != PR light restore key').toBe(prKey);
    expect(seedKey).toMatch(
      new RegExp(
        `^v0-rust-profile-[0-9a-f]{64}-runtime-build-${platform}-Linux-x64-[0-9a-f]{8}-${lockHash}$`
      )
    );
    // The prefix digests the root profile tables, so a profile edit rotates both keys together
    // and a dependency bump rotates neither.
    expect(seedKey).toContain(`${ROOT_PROFILE_PREFIX}-runtime-build-${platform}-`);
    // A different Cargo.lock misses for both: the seed never serves a stale lock.
    expect(rustCacheKey(PR_LIGHT, platform, 'deadbeef')).not.toBe(seedKey);
    // The seed never lands in the shipping entry, and shipping never lands in the light one.
    expect(rustCacheKey(MAIN_SHIPPING, platform, lockHash)).not.toBe(seedKey);
  });

  test('platforms never share a seed key', () => {
    const keys = PLATFORMS.map((platform) => rustCacheKey(MAIN_SEED, platform, 'c24d7d16'));
    expect(
      new Set(keys).size,
      `expected ${PLATFORMS.length} distinct keys | received: ${keys}`
    ).toBe(PLATFORMS.length);
  });

  test('nothing but the profile can reach the key, so the seed mode cannot fork it', () => {
    const runtime = extractJobBlock(readText(RUNTIME_WORKFLOW), 'runtime');
    const jobHead = runtime.slice(0, runtime.indexOf('    steps:'));
    // The env map, runner and matrix are what feed rust-cache's key besides the cache step.
    for (const line of jobHead.split('\n').filter((l) => /^ {4}(env|runs-on):/.test(l))) {
      expect(line, 'mode, event and ref must not select runner or env').not.toMatch(
        /inputs\.mode|github\.event_name|github\.ref/
      );
    }
    const step = cacheStep();
    expect(step).not.toMatch(/inputs\.mode|github\.event_name/);
    expect(step).not.toContain('env:');
    // On a miss, both modes install the same tools before the shared cache action.
    const steps = extractStepBlocks(runtime);
    const sharedSetup = steps
      .slice(1, steps.indexOf(step))
      .filter((before) => !/^ {8}id: seed-cache$/m.test(before));
    for (const before of sharedSetup) {
      expect(
        before,
        'a setup step differs per mode and could change the environment hash'
      ).not.toMatch(/inputs\.mode/);
    }
  });

  test('only main writes the light entry, and PRs only read it', () => {
    expect(cacheWrites(MAIN_SEED)).toBe(true);
    expect(cacheWrites(PR_LIGHT)).toBe(false);
    const step = cacheStep();
    expect(cacheInput(step, 'lookup-only')).toBe(`${EXPR} github.ref == 'refs/heads/main' }}`);
  });

  test('a warm light seed checks the exact cache before installing build tools', () => {
    const runtime = extractJobBlock(readText(RUNTIME_WORKFLOW), 'runtime');
    const steps = extractStepBlocks(runtime);
    const lookup = steps.find((step) => step.includes('id: seed-cache'));
    if (!lookup) throw new Error('runtime seed: expected a seed-cache step | received: undefined');

    const restore = cacheStep();
    expect(lookup).toContain("if: inputs.mode == 'cache-seed'");
    expect(lookup).toContain('lookup-only: true');
    expect(lookup).toContain('read-only: true');
    expect(lookup.match(/uses: \S+\/actions\/rust-cache/)?.[0]).toBe(
      restore.match(/uses: \S+\/actions\/rust-cache/)?.[0]
    );
    expect(lookup).not.toContain('env:');
    // The lookup and the writer prune the same toolchains and digest the same manifest, so the
    // only inputs that may reach the key are the shared key and the (equal) defaults.
    expect(cacheInput(lookup, 'shared-key'), 'shared-key').toBe(cacheInput(restore, 'shared-key'));
    for (const input of [
      'prefix-key',
      'profile-manifest',
      'keep-toolchains',
      'workspaces',
      'key',
    ]) {
      expect(optionalCacheInput(lookup, input), `lookup ${input}`).toBe(undefined);
      expect(optionalCacheInput(restore, input), `restore ${input}`).toBe(undefined);
    }
    const rust = steps.findIndex((step) => step.includes('rustup show active-toolchain'));
    const lookupIndex = steps.indexOf(lookup);
    expect(rust, 'the early cache key needs the selected Rust toolchain').toBeGreaterThanOrEqual(0);
    expect(lookupIndex).toBeGreaterThan(rust);

    const coldSeedOrArtifact = "steps.seed-cache.outputs.cache-hit != 'true'";
    const guardedSteps = [
      ['uses: ./.github/actions/setup-bun', coldSeedOrArtifact],
      ['name: Install zig and cargo-zigbuild', `runner.os == 'Linux' && ${coldSeedOrArtifact}`],
      ['id: rust-cache', `inputs.cache && ${coldSeedOrArtifact}`],
      [
        'name: Build runtime',
        `${coldSeedOrArtifact} && (inputs.mode == 'artifact' || steps.rust-cache.outputs.cache-hit != 'true')`,
      ],
    ] as const;
    for (const [needle, condition] of guardedSteps) {
      const index = steps.findIndex((step) => step.includes(needle));
      expect(index, needle).toBeGreaterThan(lookupIndex);
      expect(steps[index]?.split('\n'), needle).toContain(`        if: ${condition}`);
    }
  });

  test('the seed has no artifact route and skips its build on an exact cache hit', () => {
    const runtime = extractJobBlock(readText(RUNTIME_WORKFLOW), 'runtime');
    const steps = extractStepBlocks(runtime);
    // The reuse record, the runtime artifact, then the unstamped base; the first and last exist
    // only behind the digest step.
    const uploads = steps.filter((step) => step.includes('actions/upload-artifact@'));
    expect(uploads).toHaveLength(3);
    expect(uploads[0]).toContain("steps.reuse.outcome == 'success'");
    expect(uploads[1]).toContain("if: inputs.mode == 'artifact'");
    expect(uploads[2]).toContain("if: steps.unstamped.outcome == 'success'");
    expect(runtime).not.toMatch(/actions\/cache\/save|gh release|npm publish/);
    expect(readText(RUNTIME_WORKFLOW).match(/upload-artifact@/g)).toHaveLength(3);
    const cache = cacheStep();
    expect(cache).toMatch(/^ {8}id: rust-cache$/m);
    const build = steps.find((step) => step.includes('name: Build runtime'));
    expect(build).toContain(
      "(inputs.mode == 'artifact' || steps.rust-cache.outputs.cache-hit != 'true')"
    );
  });

  test('every PR artifact runtime caller explicitly selects the PR profile', () => {
    const callers = workflowFiles().flatMap((path) =>
      extractJobBlocks(readText(path))
        .filter(({ block }) => block.includes(`uses: $/${RUNTIME_WORKFLOW}`))
        .map(({ job }) => `${path}:${job}`)
    );
    expect(callers.sort(), 'update the profile policy for every new runtime-build caller').toEqual([
      '.github/workflows/ci.yml:runtime-cache-seed',
      `${DISTRIBUTION_WORKFLOW}:runtime`,
      `${DISTRIBUTION_WORKFLOW}:runtime-darwin-x64`,
      `${DISTRIBUTION_WORKFLOW}:runtime-hosts`,
      `${DISTRIBUTION_WORKFLOW}:runtime-linux-arm64`,
      `${DISTRIBUTION_WORKFLOW}:runtime-windows-arm64`,
      '.github/workflows/release-dry-run.yml:runtime',
      '.github/workflows/smoke-binary.yml:runtime',
    ]);
    const dryRun = readText('.github/workflows/release-dry-run.yml');
    const reusesDistribution = dryRun.includes('reuse_distribution:');
    const profileCallers = ['.github/workflows/smoke-binary.yml'];
    if (reusesDistribution) {
      const runtime = extractJobBlock(dryRun, 'runtime');
      expect(runtime).toContain(
        "needs.changes.outputs.release == 'true' && !inputs.reuse_distribution"
      );
      expect(runtime).toContain('cache: false');
      expect(runtime).toContain('profile: shipping');
      expect(extractJobBlock(dryRun, 'changes')).toContain(
        'PR dry runs require their same-run distribution identity'
      );
      expect(extractJobBlock(readText('.github/workflows/ci.yml'), 'release-dry-run')).toContain(
        'reuse_distribution: true'
      );
    } else {
      profileCallers.push('.github/workflows/release-dry-run.yml');
    }
    for (const caller of profileCallers) {
      const runtime = extractJobBlock(readText(caller), 'runtime');
      expect(runtime, `${caller} must select the profile for its runtime caller`).toContain(
        `profile: ${PROFILE_SELECTION}`
      );
    }
    const distribution = readText(DISTRIBUTION_WORKFLOW);
    expect(distribution).toMatch(/\n {6}runtime_profile:\n(?: {8}.*\n)*? {8}default: shipping\n/);
    for (const job of [
      'runtime',
      'runtime-hosts',
      'runtime-linux-arm64',
      'runtime-darwin-x64',
      'runtime-windows-arm64',
    ]) {
      expect(extractJobBlock(distribution, job), job).toContain(
        `profile: ${EXPR} inputs.runtime_profile }}`
      );
    }
    expect(extractJobBlock(readText('.github/workflows/ci.yml'), 'distribution')).toContain(
      `runtime_profile: ${PROFILE_SELECTION}`
    );
  });

  test('publication retains the shipping default and main still needs runtime plus smoke', () => {
    const release = extractJobBlock(readText('.github/workflows/release.yml'), 'build');
    expect(release).toContain(`uses: $/${DISTRIBUTION_WORKFLOW}`);
    expect(release).not.toContain('runtime_profile:');
    for (const path of [
      '.github/workflows/canary.yml',
      '.github/workflows/nightly-distribution-health.yml',
      '.github/workflows/protocol-release.yml',
    ]) {
      expect(readText(path)).not.toMatch(/profile:\s*light/);
    }
    const ci = readText('.github/workflows/ci.yml');
    const changes = extractJobBlock(ci, 'changes');
    expect(changes).toContain('if [ "$EVENT_NAME" != "pull_request" ]; then');
    expect(changes).toContain('echo "distribution=true" >> "$GITHUB_OUTPUT"');
    const gate = parseNeedsList(extractJobBlock(ci, 'gate-unique'));
    for (const lane of ['distribution', 'smoke', 'smoke-container']) expect(gate).toContain(lane);
    expect(extractJobBlock(ci, 'canary')).toBe('');
  });

  test('the seed job is cache-only, main-push-only, non-gating and serialized', () => {
    const ci = readText('.github/workflows/ci.yml');
    const seed = extractJobBlock(ci, 'runtime-cache-seed');
    expect(seed).toContain(
      `if: ${EXPR} !cancelled() && github.event_name == 'push' && github.ref == 'refs/heads/main' && needs['gate-unique'].result == 'success' && needs.changes.result == 'success' }}`
    );
    expect(seed).toContain(`uses: $/${RUNTIME_WORKFLOW}`);
    for (const input of ['profile: light', 'mode: cache-seed', 'cache: true']) {
      expect(seed, input).toMatch(new RegExp(`^ {6}${input}$`, 'm'));
    }
    expect(seed).not.toContain('artifact_prefix');
    expect(seed).not.toContain('platforms:');
    // Read-only token and no id-token or attestations, unlike the distribution caller. The
    // called job asks for `actions: read` (its reuse steps), which a caller must at least grant.
    expect(seed).toMatch(/permissions:\n {6}contents: read\n {6}actions: read #[^\n]*\n(?! {6})/);
    expect(seed).toMatch(
      /concurrency:\n {6}group: light-runtime-cache-seed\n {6}cancel-in-progress: false/
    );
    // The seed waits for the gate (so it only seeds a green commit and is exempt from the gate's
    // own needs); nothing mandatory or publishing waits for the seed.
    expect(parseNeedsList(seed)).toEqual(['gate-unique', 'changes']);
    for (const job of ['gate', 'gate-unique', 'smoke', 'smoke-container', 'qa-metrics']) {
      expect(
        parseNeedsList(extractJobBlock(ci, job)),
        `${job} must not need the seed`
      ).not.toContain('runtime-cache-seed');
    }
    expect(extractJobBlock(ci, 'gate-unique')).not.toContain('runtime-cache-seed');
    expect(
      workflowFiles().filter((path) => /^\s+mode: cache-seed$/m.test(readText(path))),
      'only the CI main-push seed may request cache-seed mode'
    ).toEqual(['.github/workflows/ci.yml']);
  });

  test('the preparation keeps eight targets and one cache writer step', () => {
    const workflow = readText(RUNTIME_WORKFLOW);
    for (const target of ALL_BINARY_TARGETS) expect(workflow).toContain(`"${target.arch}"`);
    expect(extractJobBlocks(workflow).map(({ job }) => job)).toEqual(['runtime']);
    const cacheSteps = extractStepBlocks(extractJobBlock(workflow, 'runtime')).filter((step) =>
      /uses: \S+\/actions\/rust-cache/.test(step)
    );
    expect(cacheSteps).toHaveLength(2);
    expect(
      cacheSteps.filter((step) => optionalCacheInput(step, 'read-only') !== 'true'),
      'only the cache step that can save may omit read-only'
    ).toEqual([cacheStep()]);
    expect(workflow).not.toContain('actions/cache/save');
    const cargo = readText('Cargo.toml');
    expect(cargo).toContain('lto = "fat"\ncodegen-units = 1');
    expect(cargo).toContain('panic = "unwind"');
  });
});

// Stage 2 of #2698: the unstamped binary is published under its input digest, and nothing
// reads it yet. These pin that it cannot fail the build, cannot appear on a pull request, and
// cannot be picked up by a packaging download.
describe('unstamped runtime base', () => {
  const runtimeSteps = () =>
    extractStepBlocks(extractJobBlock(readText(RUNTIME_WORKFLOW), 'runtime'));
  const stepNamed = (name: string) => {
    const step = runtimeSteps().find((block) => block.includes(`name: ${name}`));
    if (!step) throw new Error(`expected runtime-build.yml step ${name} | received: absent`);
    return step;
  };
  const BASE_STEPS = [
    'Compute runtime input digest',
    'Stage unstamped runtime',
    'Upload unstamped runtime',
  ];

  test('the digest runs only for a shipping artifact build on a main push', () => {
    expect(stepNamed('Compute runtime input digest')).toContain(
      "if: inputs.mode == 'artifact' && inputs.profile == 'shipping' && github.event_name == 'push' && github.ref == 'refs/heads/main'"
    );
  });

  test('every later step hangs off the digest, so no other context publishes', () => {
    // A reused base has no cargo output to stage; the run that built it published it.
    expect(stepNamed('Stage unstamped runtime')).toContain(
      "if: steps.digest.outcome == 'success' && steps.reuse.outcome != 'success'"
    );
    expect(stepNamed('Upload unstamped runtime')).toContain(
      "if: steps.unstamped.outcome == 'success'"
    );
  });

  test('no step of the base can fail the build, and a failure leaves an annotation', () => {
    for (const name of BASE_STEPS) {
      expect(stepNamed(name), name).toMatch(/^ {8}continue-on-error: true$/m);
    }
    const warning = stepNamed('Warn that the unstamped runtime was not published');
    for (const id of ['digest', 'unstamped', 'unstamped-upload']) {
      expect(warning).toContain(`steps.${id}.outcome == 'failure'`);
    }
    expect(warning).toContain('::warning');
  });

  test('the digest is computed before the build and the binary is staged after it', () => {
    const names = runtimeSteps().map((step) => /name: (.+)/.exec(step)?.[1]);
    const index = (name: string) => names.indexOf(name);
    expect(index('Compute runtime input digest')).toBeLessThan(index('Build runtime'));
    expect(index('Build runtime')).toBeLessThan(index('Stage unstamped runtime'));
    expect(index('Stage unstamped runtime')).toBeLessThan(index('Upload unstamped runtime'));
  });

  test('the upload keeps seven days, uses the runtime upload pin and names the digest', () => {
    const upload = stepNamed('Upload unstamped runtime');
    const pin = (step: string) => /uses: (actions\/upload-artifact@\S+)/.exec(step)?.[1];
    expect(pin(upload)).toBeDefined();
    expect(pin(upload)).toBe(pin(stepNamed('Upload runtime')));
    expect(upload).toContain('retention-days: 7');
    expect(upload).toContain('if-no-files-found: error');
    expect(upload).toContain(`name: ${EXPR} steps.unstamped.outputs.name }}`);
    expect(stepNamed('Stage unstamped runtime')).toContain(
      `DIGEST: ${EXPR} steps.digest.outputs.digest }}`
    );
  });

  test('it adds no job', () => {
    expect(extractJobBlocks(readText(RUNTIME_WORKFLOW)).map(({ job }) => job)).toEqual(['runtime']);
  });

  test('its artifact name matches no download pattern or name in any workflow or action', () => {
    const published = unstampedArtifactName('linux-x64', 'a'.repeat(64));
    const sha = 'b'.repeat(40);
    const texts = [
      ...workflowFiles(),
      ...readdirSync(join(ROOT_DIR, '.github', 'actions')).map(
        (dir) => `.github/actions/${dir}/action.yml`
      ),
    ]
      .filter((path) => existsSync(join(ROOT_DIR, path)))
      .map(readText);
    const requested: string[] = [];
    for (const text of texts) {
      for (const match of text.matchAll(/^\s+(?:pattern|name): (\S.*)$/gm)) {
        // Expressions stand for a commit, a platform or a prefix; any value must still miss.
        requested.push(
          (match[1] as string)
            .replace(/#.*$/, '')
            .trim()
            .replaceAll(/\$\{\{[^}]*source_sha[^}]*\}\}/g, sha)
            .replaceAll(/\$\{\{[^}]*\}\}/g, 'x')
        );
      }
    }
    expect(requested.length, 'expected to read download patterns | received: none').toBeGreaterThan(
      5
    );
    const hits = requested.filter((pattern) => new Bun.Glob(pattern).match(published));
    expect(
      hits,
      `expected no download pattern to match ${published} | received: ${hits.join(', ')}`
    ).toEqual([]);
  });
});
