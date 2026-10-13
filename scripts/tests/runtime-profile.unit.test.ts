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

function runGuard(event: string, profile: string) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('CARGO_PROFILE_RELEASE_'))
  );
  return Bun.spawnSync(['bash', '-euo', 'pipefail', '-c', profileGuard()], {
    env: {
      ...env,
      EVENT_NAME: event,
      BUILD_PROFILE: profile,
      ...jobProfileEnv(profile),
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
    const result = Bun.spawnSync(['bash', '-euo', 'pipefail', '-c', profileGuard()], {
      env: {
        ...process.env,
        EVENT_NAME: 'push',
        BUILD_PROFILE: 'light',
        GITHUB_REF: 'refs/tags/v0.2.0',
        CARGO_PROFILE_RELEASE_LTO: 'thin',
        CARGO_PROFILE_RELEASE_CODEGEN_UNITS: '16',
      },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('expected profile: shipping | received: light');
  });

  test.each(['', 'lite', 'Shipping', 'seed', 'unknown'])(
    'rejects the unrecognized profile %j',
    (profile) => {
      const result = runGuard('pull_request', profile);
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain('expected profile: shipping or light');
    }
  );

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

  test('the guard runs before checkout, Cargo setup, cache access and artifact upload', () => {
    const runtime = extractJobBlock(readText(RUNTIME_WORKFLOW), 'runtime');
    const steps = extractStepBlocks(runtime);
    expect(steps[0]).toContain('name: Validate runtime artifact profile');
    expect(steps[0]).toContain(`EVENT_NAME: ${EXPR} github.event_name }}`);
    expect(steps[0]).toContain(`BUILD_PROFILE: ${EXPR} inputs.profile }}`);
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
    // rust-cache v2.9.2 hashes CARGO* at job scope into both exact/fallback keys.
    expect(cache).not.toContain('env-vars:');
    expect(cache).not.toContain('restore-keys:');
  });

  test('the pinned cache environment hash keeps shipping stable and light fallback separate', () => {
    // Swatinem/rust-cache v2.9.2 src/config.ts lines 104-133: SHA1 of
    // rustVersions followed by sorted, nonempty variables matching these
    // prefixes. restoreKey is assigned before the lock hash is appended.
    // Source: https://github.com/Swatinem/rust-cache/blob/6323deb102c322ba6fcbdcafc7e3dddab59af2b6/src/config.ts#L104-L133
    const hashEnv = (overrides: Record<string, string>) => {
      const env: Record<string, string> = { CARGO_HOME: '/ci/cargo', ...overrides };
      const hash = createHash('sha1').update('1.99.0 x86_64-unknown-linux-gnu fixture');
      for (const key of Object.keys(env).sort((a, b) => a.localeCompare(b))) {
        const value = env[key];
        if (
          ['CARGO', 'CC', 'CFLAGS', 'CXX', 'CMAKE', 'RUST'].some((prefix) =>
            key.startsWith(prefix)
          ) &&
          value
        ) {
          hash.update(`${key}=${value}`);
        }
      }
      return hash.digest('hex').substring(0, 8);
    };
    expect(hashEnv(jobProfileEnv('shipping'))).toBe(hashEnv({}));
    expect(hashEnv(jobProfileEnv('light'))).not.toBe(hashEnv(jobProfileEnv('shipping')));
  });

  test('every PR artifact runtime caller explicitly selects the PR profile', () => {
    const callers = workflowFiles().flatMap((path) =>
      extractJobBlocks(readText(path))
        .filter(({ block }) => block.includes(`uses: ./${RUNTIME_WORKFLOW}`))
        .map(({ job }) => `${path}:${job}`)
    );
    expect(callers.sort(), 'update the profile policy for every new runtime-build caller').toEqual([
      `${DISTRIBUTION_WORKFLOW}:runtime`,
      '.github/workflows/release-dry-run.yml:runtime',
      '.github/workflows/smoke-binary.yml:runtime',
    ]);
    for (const caller of [
      '.github/workflows/release-dry-run.yml',
      '.github/workflows/smoke-binary.yml',
    ]) {
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

  test('the preparation keeps eight targets and introduces no seed or extra writer', () => {
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
