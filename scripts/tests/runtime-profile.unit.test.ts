import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

import { ALL_BINARY_TARGETS } from '../lib/release-targets';
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

// GitHub's hashFiles() over one file: SHA-256 of that file's SHA-256 digest bytes.
function hashFilesOf(path: string): string {
  const fileDigest = createHash('sha256').update(readText(path)).digest();
  return createHash('sha256').update(fileDigest).digest('hex');
}

function cacheStep(): string {
  const runtime = extractJobBlock(readText(RUNTIME_WORKFLOW), 'runtime');
  const steps = extractStepBlocks(runtime).filter((step) => step.includes('Swatinem/rust-cache@'));
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

// Resolves only the expressions the cache key is built from. Anything else is an error, so a new
// input cannot enter the key without this test learning about it.
function resolveKeyExpression(raw: string, platform: string): string {
  return raw.replace(/\$\{\{ (.+?) \}\}/g, (_match, expression: string) => {
    if (expression === "hashFiles('Cargo.toml')") return hashFilesOf('Cargo.toml');
    if (expression === 'matrix.platform') return platform;
    throw new Error(
      `expected a cache key expression: hashFiles('Cargo.toml') | matrix.platform | received: ${expression}`
    );
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
  const prefix = resolveKeyExpression(cacheInput(step, 'prefix-key'), platform);
  const shared = resolveKeyExpression(cacheInput(step, 'shared-key'), platform);
  return `${prefix}-${shared}-Linux-x64-${hashEnv(jobProfileEnv(scenario.profile))}-${lockHash}`;
}

/** Evaluates the cache step's `github.ref == 'refs/heads/main'` write gate for a scenario. */
function cacheWrites(scenario: CacheScenario): boolean {
  const gate = `${EXPR} github.ref == 'refs/heads/main' }}`;
  const step = cacheStep();
  expect(cacheInput(step, 'save-if')).toBe(gate);
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
    ['CARGO_PROFILE_RELEASE_LTO', 'thin', 'lto=thin, codegen-units=<unset>'],
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
    ['CARGO_PROFILE_RELEASE_CODEGEN_UNITS', '1', 'lto=thin, codegen-units=1'],
    ['CARGO_PROFILE_RELEASE_LTO', '', 'lto=<unset>, codegen-units=16'],
    ['CARGO_PROFILE_RELEASE_CODEGEN_UNITS', '', 'lto=thin, codegen-units=<unset>'],
  ])('light refuses %s=%j', (key, value, received) => {
    const result = runGuard('pull_request', 'light', { [key]: value });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      `expected light profile: lto=thin, codegen-units=16 | received: ${received}`
    );
    expect(result.stdout.toString()).not.toContain('runtime profile: light');
  });

  test('PRs may use light and every event may use shipping', () => {
    const light = runGuard('pull_request', 'light');
    expect(light.exitCode).toBe(0);
    expect(light.stdout.toString()).toContain(
      'runtime profile: light (lto=thin, codegen-units=16)'
    );
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
      'runtime profile: light (lto=thin, codegen-units=16)'
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
    ['CARGO_PROFILE_RELEASE_CODEGEN_UNITS', '1', 'lto=thin, codegen-units=1'],
    ['CARGO_PROFILE_RELEASE_LTO', '', 'lto=<unset>, codegen-units=16'],
  ])('a seed refuses %s=%j so its key cannot drift from the PR key', (key, value, received) => {
    const result = runGuard('push', 'light', { [key]: value }, SEED_CONTEXT);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      `expected light profile: lto=thin, codegen-units=16 | received: ${received}`
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
      CARGO_PROFILE_RELEASE_LTO: 'thin',
      CARGO_PROFILE_RELEASE_CODEGEN_UNITS: '16',
    });
    expect(jobProfileEnv('shipping')).toEqual({});
    const build = extractStepBlocks(runtime).find((step) => step.includes('name: Build runtime'));
    expect(build).not.toContain('CARGO_PROFILE_RELEASE_');
    const cache = extractStepBlocks(runtime).find((step) => step.includes('Swatinem/rust-cache@'));
    expect(cache).toContain('shared-key: runtime-build-');
    expect(cache).toContain(`save-if: ${EXPR} github.ref == 'refs/heads/main' }}`);
    expect(cache).toContain(`lookup-only: ${EXPR} github.ref == 'refs/heads/main' }}`);
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
        `^v0-rust-[0-9a-f]{64}-runtime-build-${platform}-Linux-x64-[0-9a-f]{8}-${lockHash}$`
      )
    );
    // The prefix covers the root manifest, so a profile edit rotates both keys together.
    expect(seedKey).toContain(`v0-rust-${hashFilesOf('Cargo.toml')}-runtime-build-${platform}-`);
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
    // Every step before the cache step is shared by both modes, with no mode condition.
    const steps = extractStepBlocks(runtime);
    for (const before of steps.slice(0, steps.indexOf(step)).slice(1)) {
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

  test('the seed has no artifact route and skips its build on an exact cache hit', () => {
    const runtime = extractJobBlock(readText(RUNTIME_WORKFLOW), 'runtime');
    const steps = extractStepBlocks(runtime);
    const uploads = steps.filter((step) => step.includes('actions/upload-artifact@'));
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toContain("if: inputs.mode == 'artifact'");
    expect(runtime).not.toMatch(/actions\/cache\/save|gh release|npm publish/);
    expect(readText(RUNTIME_WORKFLOW).match(/upload-artifact@/g)).toHaveLength(1);
    const cache = cacheStep();
    expect(cache).toMatch(/^ {8}id: rust-cache$/m);
    const build = steps.find((step) => step.includes('name: Build runtime'));
    expect(build).toContain(
      "if: inputs.mode == 'artifact' || steps.rust-cache.outputs.cache-hit != 'true'"
    );
  });

  test('every PR artifact runtime caller explicitly selects the PR profile', () => {
    const callers = workflowFiles().flatMap((path) =>
      extractJobBlocks(readText(path))
        .filter(({ block }) => block.includes(`uses: ./${RUNTIME_WORKFLOW}`))
        .map(({ job }) => `${path}:${job}`)
    );
    expect(callers.sort(), 'update the profile policy for every new runtime-build caller').toEqual([
      '.github/workflows/ci.yml:runtime-cache-seed',
      `${DISTRIBUTION_WORKFLOW}:runtime`,
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
    expect(extractJobBlock(distribution, 'runtime')).toContain(
      `profile: ${EXPR} inputs.runtime_profile }}`
    );
    expect(extractJobBlock(readText('.github/workflows/ci.yml'), 'distribution')).toContain(
      `runtime_profile: ${PROFILE_SELECTION}`
    );
  });

  test('publication retains the shipping default and main still needs runtime plus smoke', () => {
    const release = extractJobBlock(readText('.github/workflows/release.yml'), 'build');
    expect(release).toContain(`uses: ./${DISTRIBUTION_WORKFLOW}`);
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
    const gate = parseNeedsList(extractJobBlock(ci, 'gate'));
    for (const lane of ['distribution', 'smoke', 'smoke-container']) expect(gate).toContain(lane);
    expect(parseNeedsList(extractJobBlock(ci, 'canary'))).toContain('gate');
  });

  test('the seed job is cache-only, main-push-only, non-gating and serialized', () => {
    const ci = readText('.github/workflows/ci.yml');
    const seed = extractJobBlock(ci, 'runtime-cache-seed');
    expect(seed).toContain(
      `if: ${EXPR} !cancelled() && github.event_name == 'push' && github.ref == 'refs/heads/main' && needs.gate.result == 'success' && needs['distribution-identity'].result == 'success' }}`
    );
    expect(seed).toContain(`uses: ./${RUNTIME_WORKFLOW}`);
    for (const input of ['profile: light', 'mode: cache-seed', 'cache: true']) {
      expect(seed, input).toMatch(new RegExp(`^ {6}${input}$`, 'm'));
    }
    expect(seed).not.toContain('artifact_prefix');
    expect(seed).not.toContain('platforms:');
    // Read-only token and no id-token or attestations, unlike the distribution caller.
    expect(seed).toMatch(/permissions:\n {6}contents: read\n(?! {6})/);
    expect(seed).toMatch(
      /concurrency:\n {6}group: light-runtime-cache-seed\n {6}cancel-in-progress: false/
    );
    // The seed waits for the gate (so it only seeds a green commit and is exempt from the gate's
    // own needs); nothing mandatory or publishing waits for the seed.
    expect(parseNeedsList(seed)).toEqual(['gate', 'distribution-identity']);
    for (const job of ['gate', 'gate-unique', 'canary', 'smoke', 'smoke-container', 'qa-metrics']) {
      expect(
        parseNeedsList(extractJobBlock(ci, job)),
        `${job} must not need the seed`
      ).not.toContain('runtime-cache-seed');
    }
    expect(extractJobBlock(ci, 'gate')).not.toContain('runtime-cache-seed');
    expect(
      workflowFiles().filter((path) => /^\s+mode: cache-seed$/m.test(readText(path))),
      'only the CI main-push seed may request cache-seed mode'
    ).toEqual(['.github/workflows/ci.yml']);
  });

  test('the preparation keeps eight targets and one cache writer step', () => {
    const workflow = readText(RUNTIME_WORKFLOW);
    for (const target of ALL_BINARY_TARGETS) expect(workflow).toContain(`"${target.arch}"`);
    expect(extractJobBlocks(workflow).map(({ job }) => job)).toEqual(['runtime']);
    expect(workflow.match(/uses: Swatinem\/rust-cache@/g)).toHaveLength(1);
    expect(workflow).not.toContain('actions/cache/save');
    const cargo = readText('Cargo.toml');
    expect(cargo).toContain('lto = "fat"\ncodegen-units = 1');
    expect(cargo).toContain('panic = "unwind"');
  });
});
