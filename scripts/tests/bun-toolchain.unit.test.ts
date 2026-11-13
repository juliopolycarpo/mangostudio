// Guards Turborepo's version-shaped marker, the CI channel and the resolver
// used to download cross-compile runtimes.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BUN_RUNTIME_ASSETS,
  bunCompiledRuntimes,
  bunCrossCompileChannel,
  hostReleasePlatform,
} from '../lib/bun-cross-runtime';
import { ROOT_DIR } from '../lib/config';
import { ALL_BINARY_TARGETS } from '../lib/release-targets';
import { readText } from './support/read-text';

/**
 * Turborepo 2.x parses `packageManager` with this, and refuses to resolve the
 * workspace at all when it does not match — not a warning, a hard stop. Copied
 * from the error it prints so the failure here reads like the real one.
 */
const TURBO_PACKAGE_MANAGER =
  /^(?:aube|bun|npm|nub|pnpm|yarn)@(?:\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?|https?:\/\/\S+)$/;

async function withVersionFile<T>(
  contents: string | null,
  run: (path: string) => Promise<T>
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'bun-version-'));
  try {
    const path = join(dir, '.bun-version');
    if (contents !== null) writeFileSync(path, contents);
    return await run(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('Bun toolchain pins', () => {
  test('packageManager stays parseable by Turborepo', () => {
    const { packageManager } = JSON.parse(readText('package.json')) as {
      packageManager?: string;
    };

    expect(packageManager).toBeDefined();
    // `bun@canary` matches neither branch, which is why a channel can only ever
    // live in `.bun-version`. Keep this field version-shaped.
    expect(packageManager).toMatch(TURBO_PACKAGE_MANAGER);
  });

  test('.bun-version names exactly one thing, on one line', () => {
    const raw = readText('.bun-version');

    expect(raw.trim()).not.toBe('');
    expect(raw.trim().split(/\s+/)).toHaveLength(1);
  });

  test('only the composite and the release trust bootstraps reference oven-sh/setup-bun', () => {
    // The composite owns the retry, so a call site that bypasses it loses the
    // retry silently. The release trust bootstraps cannot load an action from
    // the tag they are still authenticating, so they carry the retry inline.
    const allowed: Record<string, number> = {
      'actions/setup-bun/action.yml': 2,
      'workflows/protocol-release.yml': 2,
      'workflows/release.yml': 2,
    };
    const received: Record<string, number> = {};
    for (const file of githubYamlFiles()) {
      const count = [...readText(join('.github', file)).matchAll(/uses:\s*oven-sh\/setup-bun@/g)]
        .length;
      if (count > 0) received[file] = count;
    }
    expect(
      received,
      'direct oven-sh/setup-bun references per file; route new Bun setup through ./.github/actions/setup-bun'
    ).toEqual(allowed);
  });

  test('every direct oven-sh/setup-bun reference reads the expected version file and pin', () => {
    // package.json's `packageManager` is a Turborepo floor marker and does not
    // name an installable build; a call site left pointing at it would ask for a
    // release tag that has never existed.
    // Release authentication cannot take its executable pin from the tag it is
    // authenticating; those bootstraps read protected main's archived
    // .bun-version before any tagged code can execute.
    const trusted = '$' + '{{ runner.temp }}/release-trust/.bun-version';
    const expectedFile: Record<string, string> = {
      'actions/setup-bun/action.yml': '$' + '{{ inputs.bun-version-file }}',
      'workflows/protocol-release.yml': trusted,
      'workflows/release.yml': trusted,
    };
    const pins = new Set<string>();
    for (const [file, expected] of Object.entries(expectedFile)) {
      for (const step of yamlSteps(file)) {
        if (!step.uses?.startsWith('oven-sh/setup-bun@')) continue;
        expect(step.with?.['bun-version-file'], `${file} bun-version-file`).toBe(expected);
        pins.add(step.uses);
      }
    }
    expect([...pins], 'every direct setup-bun reference must share one pin').toHaveLength(1);
    expect([...pins][0]).toMatch(SETUP_BUN_USES);
  });

  test('every other Bun setup goes through the composite and reads .bun-version', () => {
    // Native qualification runs its producer against a separate source
    // checkout, including an untouched baseline with its own Bun pin.
    const expectedFile: Record<string, string> = {
      'workflows/native-bun-qualification.yml#1': 'source/.bun-version',
    };
    let seen = 0;
    for (const file of githubYamlFiles()) {
      let index = 0;
      for (const step of yamlSteps(file)) {
        if (!COMPOSITE_SETUP_BUN.test(step.uses ?? '')) continue;
        const expected = expectedFile[`${file}#${index}`] ?? '.bun-version';
        index++;
        seen++;
        // An absent input falls back to the composite's `.bun-version` default.
        expect(
          step.with?.['bun-version-file'] ?? '.bun-version',
          `${file} Bun setup #${index} bun-version-file`
        ).toBe(expected);
      }
    }
    expect(seen, 'composite Bun setup call sites').toBeGreaterThan(0);
  });

  test('the release trust bootstraps retry Bun setup once, tolerantly then strictly', () => {
    for (const file of ['workflows/release.yml', 'workflows/protocol-release.yml']) {
      const steps = yamlSteps(file);
      const first = steps.findIndex((step) => step.uses?.startsWith('oven-sh/setup-bun@'));
      const [attempt, wait, retry] = steps.slice(first, first + 3);
      const failed = `steps.${attempt?.id}.outcome == 'failure'`;
      expect(attempt?.id, `${file} first attempt id`).toBeTruthy();
      expect(attempt?.['continue-on-error'], `${file} first attempt tolerates failure`).toBe(true);
      expect(wait?.if, `${file} wait runs only after a failed first attempt`).toBe(failed);
      expect(wait?.run, `${file} wait duration`).toBe('sleep 45');
      expect(wait?.shell, `${file} wait shell`).toBe('bash');
      expect(retry?.uses, `${file} retry reference`).toBe(attempt?.uses);
      expect(retry?.if, `${file} retry runs only after a failed first attempt`).toBe(failed);
      expect(retry?.['continue-on-error'], `${file} retry failure fails the job`).toBeUndefined();
      expect(retry?.with, `${file} retry inputs`).toEqual(attempt?.with);
    }
  });

  test('the Bun build key is the revision, not the version', () => {
    // `--version` is unique per release and would work today. `--revision`
    // stays correct for a rebuilt tag or a channel too, which is the state this
    // repo spent three months in, and costs nothing to keep.
    const action = readText('.github/actions/setup-mango/action.yml');

    expect(action).toContain('bun --revision');
    expect(action).not.toMatch(/\$\(bun --version\)/);
  });
});

describe('Bun cross-compile runtime', () => {
  test('reads a channel from .bun-version and ignores a released version', async () => {
    // A released version has a download `--compile` can resolve on its own, so
    // the resolver must stay out of the way and leave that path untouched.
    for (const released of ['1.3.14', 'v1.3.14', '1.4.0-canary.1', '1.4.0+build.5']) {
      expect(await withVersionFile(released, bunCrossCompileChannel), released).toBeNull();
    }

    for (const channel of ['canary', 'canary\n', '  canary  ']) {
      expect(await withVersionFile(channel, bunCrossCompileChannel)).toBe('canary');
    }

    expect(await withVersionFile('', bunCrossCompileChannel)).toBeNull();
    expect(await withVersionFile(null, bunCrossCompileChannel)).toBeNull();
  });

  test('the repository uses the canary cross-compile channel', async () => {
    expect(await bunCrossCompileChannel()).toBe('canary');
  });

  test('every release target has a Bun asset to download', () => {
    // The map's `Record<ReleasePlatformId, string>` type already makes a missing
    // key a compile error, so what is left to check is the value: a wrong asset
    // name is a 404 on a runner, not a type error.
    for (const target of ALL_BINARY_TARGETS) {
      expect(BUN_RUNTIME_ASSETS[target.arch], target.arch).toMatch(/^bun-[a-z0-9-]+$/);
    }
    expect(Object.keys(BUN_RUNTIME_ASSETS).sort()).toEqual(
      ALL_BINARY_TARGETS.map((target) => target.arch).sort()
    );
  });

  test('arm64 targets map to Bun aarch64 assets', () => {
    // The one substitution that is easy to get wrong and produces a 404 rather
    // than a type error.
    expect(BUN_RUNTIME_ASSETS['linux-arm64']).toBe('bun-linux-aarch64');
    expect(BUN_RUNTIME_ASSETS['linux-arm64-musl']).toBe('bun-linux-aarch64-musl');
    expect(BUN_RUNTIME_ASSETS['darwin-arm64']).toBe('bun-darwin-aarch64');
    expect(BUN_RUNTIME_ASSETS['windows-arm64']).toBe('bun-windows-aarch64');
  });

  test('the host resolves to a release platform or to nothing', () => {
    const host = hostReleasePlatform();
    if (host === null) return;

    expect(ALL_BINARY_TARGETS.map((target) => target.arch)).toContain(host);
  });

  test('every target carries the host runtime on a released Bun', async () => {
    // `--compile` downloads the build matching `Bun.version`, so nothing is
    // fetched per target and there is nothing to drift against.
    const runtimes = await bunCompiledRuntimes(null);

    expect(Object.keys(runtimes).sort()).toEqual(ALL_BINARY_TARGETS.map((t) => t.arch).sort());
    for (const [id, runtime] of Object.entries(runtimes)) {
      expect(runtime, id).toEqual({
        source: 'host',
        revision: Bun.revision,
        sha256: null,
        tagAdvanced: false,
      });
    }
  });

  test('the host revision is the spelling the provenance records', async () => {
    // `bun --revision` prints `1.4.0+34cbb9a40` while the API returns the full
    // sha. Recording the flag's spelling made the old drift warning fire on
    // every build, against a runtime that had not drifted at all.
    expect(Bun.revision).toMatch(/^[0-9a-f]{40}$/);

    const runtimes = await bunCompiledRuntimes(await bunCrossCompileChannel());
    const host = hostReleasePlatform();
    if (host === null) return; // unidentifiable host; nothing claims to be it

    expect(runtimes[host]?.revision).toBe(Bun.revision);
  });

  test('targets with nothing fetched are absent rather than invented', async () => {
    // This runs at the end of a successful build and must never be the reason
    // one fails, so a cold cache answers with the host's target alone: every
    // foreign runtime is unknown, and saying so is the point.
    const runtimes = await bunCompiledRuntimes('canary', {
      cacheDir: join(tmpdir(), 'bun-cross-absent'),
      cacheKey: 'nothing-installed-here',
    });

    const host = hostReleasePlatform();
    expect(Object.keys(runtimes)).toEqual(host === null ? [] : [host]);
  });
});

interface ActionStep {
  id?: string;
  name?: string;
  if?: string;
  uses?: string;
  run?: string;
  shell?: string;
  'timeout-minutes'?: number;
  'continue-on-error'?: boolean;
  with?: Record<string, string>;
}

const SETUP_BUN_ACTION = '.github/actions/setup-bun/action.yml';
const SETUP_BUN_USES = /^oven-sh\/setup-bun@[a-f0-9]{40}$/;
// Same-repository ($/), source-checkout (./) and tooling-checkout (./tooling/) references.
const COMPOSITE_SETUP_BUN = /^(?:\$|\.|\.\/tooling)\/\.github\/actions\/setup-bun$/;

function githubYamlFiles(): string[] {
  return [...new Bun.Glob('**/*.{yml,yaml}').scanSync({ cwd: join(ROOT_DIR, '.github') })]
    .map((file) => file.replaceAll('\\', '/'))
    .sort();
}

/** Every step of a workflow's jobs or a composite action, in file order. */
function yamlSteps(file: string): ActionStep[] {
  const parsed = Bun.YAML.parse(readText(join('.github', file))) as {
    jobs?: Record<string, { steps?: ActionStep[] }>;
    runs?: { steps?: ActionStep[] };
  };
  return [
    ...Object.values(parsed.jobs ?? {}).flatMap((job) => job.steps ?? []),
    ...(parsed.runs?.steps ?? []),
  ];
}

function setupBunActionSteps(): ActionStep[] {
  const action = Bun.YAML.parse(readText(SETUP_BUN_ACTION)) as {
    runs?: { using?: string; steps?: ActionStep[] };
  };
  expect(action.runs?.using, `${SETUP_BUN_ACTION} runs.using`).toBe('composite');
  return action.runs?.steps ?? [];
}

describe('setup-bun composite action', () => {
  test('tries once tolerantly, waits, then retries strictly, in that order', () => {
    const steps = setupBunActionSteps();
    expect(
      steps.map((step) => (step.uses ? 'setup-bun' : 'run')),
      `${SETUP_BUN_ACTION} step order`
    ).toEqual(['setup-bun', 'run', 'setup-bun']);
    const [first, wait, retry] = steps;
    const failed = `steps.${first.id}.outcome == 'failure'`;

    expect(first.id, 'first attempt needs an id for the retry condition').toBeTruthy();
    expect(first['continue-on-error'], 'first attempt tolerates failure').toBe(true);
    expect(wait.if, 'wait runs only after the first attempt failed').toContain(failed);
    expect(wait.run, 'wait duration').toBe('sleep 45');
    expect(wait.shell, 'wait step shell must be explicit for Windows runners').toBe('bash');
    expect(retry.if, 'retry runs only after the first attempt failed').toContain(failed);
    expect(
      retry['continue-on-error'],
      'retry failure must fail the job with setup-bun own error'
    ).toBeUndefined();
  });

  test('both attempts run the same pinned setup-bun and read the version file input', () => {
    const [first, , retry] = setupBunActionSteps();
    for (const attempt of [first, retry]) {
      expect(attempt.uses, 'setup-bun reference').toMatch(SETUP_BUN_USES);
      expect(attempt.with, 'setup-bun inputs').toEqual({
        'bun-version-file': '$' + '{{ inputs.bun-version-file }}',
      });
    }
    expect(retry.uses, 'retry pin must equal the first attempt pin').toBe(first.uses);
  });

  test('defaults the version file to .bun-version', () => {
    const action = Bun.YAML.parse(readText(SETUP_BUN_ACTION)) as {
      inputs?: Record<string, { default?: string }>;
    };
    expect(Object.keys(action.inputs ?? {}), `${SETUP_BUN_ACTION} inputs`).toEqual([
      'bun-version-file',
    ]);
    expect(action.inputs?.['bun-version-file']?.default).toBe('.bun-version');
  });
});
