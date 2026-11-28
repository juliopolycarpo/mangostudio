import { describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SCOPED_CACHE_FAMILIES } from '../ci/cache-families';
import { RUST_CACHE_FAMILIES, RUST_CACHE_WRITERS } from '../ci/rust-cache/families';
import { RELEASE_PATTERN } from '../lib/ci-lanes';
import { ROOT_DIR } from '../lib/config';
import { PROTOCOL_TRIGGER_FILES } from '../lib/protocol';
import { RUST_WORKSPACE_PATHS } from '../lib/rust-lanes';
import { evaluateWriteScope, runCompositeStep } from './support/cache-scoped-steps';
import { readText } from './support/read-text';
import {
  extractJobBlock,
  extractJobBlocks,
  extractOnBlock,
  extractStepBlock,
  extractStepBlocks,
  extractStepBlocksAtIndent,
  extractTopLevelBlock,
  sectionKeys,
} from './support/workflow-blocks';
import {
  type CacheScopedCallSite,
  cacheScopedCallSites,
  compositeActionFiles,
  parseWithInputs,
  workflowFiles,
} from './support/workflow-files';

const CACHE_ACTION_SHA = '55cc8345863c7cc4c66a329aec7e433d2d1c52a9';
const EXPRESSION_START = '$' + '{{';
const CACHE_EPOCH_EXPRESSION = `cache-epoch: ${EXPRESSION_START} vars.CI_CACHE_EPOCH || 'v1' }}`;
// Existing Playwright cache entries remain recognizable until they expire.
// Registered for accounting only: no workflow or composite calls cache-scoped with
// these. `bun` stays until its last entries (written 2026-11-11) pass the 14-day retention.
const RETIRED_SCOPED_CACHE_FAMILIES = new Set(['playwright', 'bun']);
const EXPECTED_FAMILIES = SCOPED_CACHE_FAMILIES.filter(
  (family) => !RETIRED_SCOPED_CACHE_FAMILIES.has(family)
);
// Swatinem/rust-cache runs in one composite and nowhere else; every workflow reaches it through
// that composite, which owns the toolchain pruning, the generation prefix and the save gate.
const RUST_CACHE_ACTION = '.github/actions/rust-cache/action.yml';
const RUST_CACHE_ACTION_SHA = 'd1527c8f67ef9af357290475d4af4b0fab8f12e0';
const RUST_CACHE_PREFIX_KEY = `prefix-key: v0-rust-profile-${EXPRESSION_START} steps.profile.outputs.digest }}`;
const RUST_CACHE_SAVE_IF = `save-if: ${EXPRESSION_START} inputs.read-only != 'true' && github.ref == 'refs/heads/main' }}`;
// Inputs a call site may pass. `prefix-key` and `save-if` are not among them: the prefix is the
// action's to derive, and a caller can only switch saving off (`read-only: true`).
const RUST_CACHE_CALL_INPUTS = new Set([
  'shared-key',
  'key',
  'workspaces',
  'profile-manifest',
  'keep-toolchains',
  'lookup-only',
  'read-only',
]);
const RUST_CACHE_USES = /^\s*(?:-\s+)?uses: [.$]\/\.github\/actions\/rust-cache(?:\s|$)/m;
// Keep existing physical entries recognizable to lifecycle accounting until
// their post-merge disposition is verified; these families have no writer.
const RETIRED_RUST_CACHE_FAMILIES = new Set(['semver-checks', 'schema-equality']);

// Registered writers whose completion does not start a cleanup run. Both start on every main
// push beside CI, and CI usually finishes last, so CI's completion usually sees no active writer.
// When it does not, the sweep waits for the next CI completion or the daily nightly, and the
// bound in docs/reference/testing.md ("Cleanup triggers") covers that day. They stay in
// RUST_CACHE_WRITERS, so the audit still defers while one of them runs.
const RUST_CLEANUP_PUSH_COMPANIONS = ['Cargo Shim', 'Protocol CI'];
const RUST_CLEANUP_TRIGGER_WRITERS = RUST_CACHE_WRITERS.map((writer) => writer.name).filter(
  (name): boolean => !RUST_CLEANUP_PUSH_COMPANIONS.includes(name)
);

interface TurboLane {
  readonly file: string;
  readonly job: string;
  /** Substring of the one step whose `run:` drives Turbo and fills `.turbo/cache`. */
  readonly command: string;
}

// test.yml is deliberately absent: its shards restore and save no Turbo
// snapshot (pinned by 'test.yml carries no Turbo cache' below).
const TURBO_LANES: readonly TurboLane[] = [
  { file: '.github/workflows/build.yml', job: 'build', command: 'bun run build --frontend' },
  { file: '.github/workflows/lint.yml', job: 'check', command: 'bun run check' },
];

// Turbo's task hash already covers the lockfile closure and every config it
// extends, so none of these decide whether a task hits. They decide which
// snapshot a lane restores and when it counts as new, so a config change
// starts a fresh chain instead of exact-matching one that predates it.
const TURBO_KEY_GLOBS = [
  'turbo.jsonc',
  'bun.lock',
  'package.json',
  'apps/*/package.json',
  'apps/*/turbo.json',
  'packages/*/package.json',
  'packages/*/turbo.json',
] as const;

interface RustCacheStep {
  readonly file: string;
  readonly job?: string;
  readonly block: string;
}

// Parse the permission mapping independently of unrelated GitHub expression
// scalars and multiline flow lists Bun's YAML parser cannot read.
function permissions(source: string, indent: number): Record<string, string> | string | undefined {
  const block = new RegExp(
    `^ {${indent}}permissions:[^\\n]*(?:\\n {${indent + 2}}[^\\n]+)*`,
    'm'
  ).exec(source)?.[0];
  return block
    ? (Bun.YAML.parse(block) as { permissions: Record<string, string> | string }).permissions
    : undefined;
}

/**
 * Every call of the rust-cache composite across workflows (steps at indent 6)
 * and other composite actions (steps at indent 4).
 *
 * @example
 * for (const step of rustCacheSteps()) expect(step.block).toContain('shared-key:');
 */
function rustCacheSteps(): RustCacheStep[] {
  const isRustCache = (block: string) => RUST_CACHE_USES.test(block);
  const workflowSteps = workflowFiles().flatMap((file) =>
    extractJobBlocks(readText(file)).flatMap(({ job, block }) =>
      extractStepBlocksAtIndent(block, 6).map((step) => ({ file, job, block: step }))
    )
  );
  const actionSteps = compositeActionFiles().flatMap((file) =>
    extractStepBlocksAtIndent(readText(file), 4).map((step) => ({ file, block: step }))
  );
  return [...workflowSteps, ...actionSteps].filter((step) => isRustCache(step.block));
}

describe('CI cache policy', () => {
  test('grants cache deletion only to the dedicated cleanup jobs', () => {
    const holders: string[] = [];
    for (const file of workflowFiles()) {
      const text = readText(file);
      const top = permissions(text, 0);
      expect(top, file).not.toBe('write-all');
      expect(typeof top === 'object' ? top?.actions : undefined, file).not.toBe('write');
      for (const { job, block } of extractJobBlocks(text)) {
        const value = permissions(block, 4);
        expect(value, `${file}:${job}`).not.toBe('write-all');
        if (typeof value === 'object' && value?.actions === 'write') holders.push(`${file}:${job}`);
      }
    }
    // pr-cache-cleanup.yml holds the other two grants; its own policy test
    // (pr-cache-cleanup.unit.test.ts) pins what those jobs may check out and run.
    expect(holders.sort()).toEqual([
      '.github/workflows/pr-cache-cleanup.yml:closed-backlog',
      '.github/workflows/pr-cache-cleanup.yml:closed-pull-request',
      '.github/workflows/rust-cache-cleanup.yml:cleanup',
    ]);
    const workflow = readText('.github/workflows/rust-cache-cleanup.yml');
    const job = extractJobBlock(workflow, 'cleanup');
    // Workflow scope grants nothing; the cleanup job's own permissions carry the delete grant.
    expect(workflow).toMatch(/^permissions: \{\}$/m);
    const triggers = extractOnBlock(workflow);
    expect(triggers).toMatch(/^ {4}types: \[completed\]$/m);
    expect(triggers).toMatch(/^ {4}branches: \[main\]$/m);
    expect(workflow).not.toMatch(/^ {2}pull_request:/m);
    expect(job).toContain("github.ref == 'refs/heads/main'");
    expect(job).toContain("github.event.workflow_run.head_branch == 'main'");
    expect(job).toContain(
      'github.event.workflow_run.head_repository.full_name == github.repository'
    );
    expect(job).toContain('["push","schedule","workflow_dispatch"]');
    const steps = extractStepBlocks(job);
    const checkout = steps.find((step) => /^ {6}- uses: actions\/checkout@/m.test(step));
    expect(
      checkout,
      'cleanup job: expected an actions/checkout step | received none'
    ).toBeDefined();
    expect(checkout).toMatch(/^ {10}ref: main$/m);
    expect(checkout).toMatch(/^ {10}persist-credentials: false$/m);
    expect(job).not.toMatch(/ref:.*workflow_run/);
    expect(extractStepBlock(job, 'Delete superseded Rust cache IDs')).toContain(
      'run: bun ./scripts/ci/rust-cache-cleanup.ts --delete'
    );
    const concurrency = extractTopLevelBlock(workflow, 'concurrency');
    expect(concurrency).toMatch(/^ {2}group: rust-cache-cleanup-main$/m);
    expect(concurrency).toMatch(/^ {2}cancel-in-progress: false$/m);
  });

  test('registers every entrypoint that can save a known Rust family', () => {
    const reachesRustCache = (file: string, visited = new Set<string>()): boolean => {
      if (visited.has(file)) return false;
      visited.add(file);
      const text = readText(file);
      if (text.includes('uses: Swatinem/rust-cache@')) return true;
      const calls = [
        ...text.matchAll(/uses: ([.$]\/\.github\/(?:workflows\/[^\s]+\.yml|actions\/[^\s]+))/g),
      ];
      return calls.some(([, target]) =>
        reachesRustCache(
          target.endsWith('.yml') ? target.slice(2) : `${target.slice(2)}/action.yml`,
          visited
        )
      );
    };
    const entrypoints = workflowFiles().filter(
      (file) =>
        sectionKeys(extractOnBlock(readText(file))).some((event) =>
          ['push', 'schedule', 'workflow_dispatch'].includes(event)
        ) && reachesRustCache(file)
    );
    expect(entrypoints.sort()).toEqual(RUST_CACHE_WRITERS.map((writer) => writer.path).sort());
    const cleanup = Bun.YAML.parse(readText('.github/workflows/rust-cache-cleanup.yml')) as {
      on: { workflow_run: { workflows: string[] } };
    };
    // The writer audit (RUST_CACHE_WRITERS) sees every producer; the triggers are a subset.
    // Anything else is registered as a trigger only when it is a registered writer.
    const triggers = new Set(cleanup.on.workflow_run.workflows);
    const writerNames = new Set<string>(RUST_CACHE_WRITERS.map((writer) => writer.name));
    expect(
      [...triggers].filter((name) => !writerNames.has(name)),
      'cleanup triggers that are not registered cache writers'
    ).toEqual([]);
    expect([...triggers].sort(), 'rust-cache-cleanup.yml workflow_run.workflows').toEqual(
      [...RUST_CLEANUP_TRIGGER_WRITERS].sort()
    );
    for (const writer of RUST_CACHE_WRITERS) {
      expect(/^name: (.+)$/m.exec(readText(writer.path))?.[1]).toBe(writer.name);
    }
  });

  test('a cache writer left out of the cleanup triggers is covered by CI and a daily floor', () => {
    const writerOn = (name: string): string[] => {
      const writer = RUST_CACHE_WRITERS.find((candidate) => candidate.name === name);
      if (!writer) throw new Error(`expected a registered cache writer | received: ${name}`);
      return sectionKeys(extractOnBlock(readText(writer.path)));
    };
    // The companions run on every main push, which is what CI's completion covers.
    for (const name of RUST_CLEANUP_PUSH_COMPANIONS) {
      expect(writerOn(name), `${name} on: keys, expected to include push`).toContain('push');
    }
    const cleanup = Bun.YAML.parse(readText('.github/workflows/rust-cache-cleanup.yml')) as {
      on: { workflow_run: { workflows: string[] } };
    };
    const triggers = cleanup.on.workflow_run.workflows;
    expect(triggers, 'the CI completion must start a cleanup run').toContain('CI');
    // A sweep CI's completion deferred waits for the next trigger; a daily producer bounds that
    // wait to a day, because a cleanup run is global and prunes every family.
    const dailyTriggers = RUST_CACHE_WRITERS.filter((writer) => triggers.includes(writer.name))
      .filter((writer) => /^\s+- cron: "\d+ \d+ \* \* \*"$/m.test(readText(writer.path)))
      .map((writer) => writer.name);
    expect(dailyTriggers, 'daily scheduled writers that start a cleanup run').not.toEqual([]);
  });

  test('registers exact Rust family identities and keeps the pinned key grammar', () => {
    const families = new Set<string>(RUST_CACHE_FAMILIES);
    for (const family of RETIRED_RUST_CACHE_FAMILIES) {
      expect(
        families.has(family),
        `expected retired Rust cache family ${family} to remain recognizable`
      ).toBe(true);
    }
    const observed = new Set<string>();
    for (const step of rustCacheSteps()) {
      const shared = /^\s+shared-key: (.+)$/m.exec(step.block)?.[1];
      const inputKey = /^\s+key: (.+)$/m.exec(step.block)?.[1];
      const family = shared ?? [inputKey, step.job].filter(Boolean).join('-');
      if (shared?.includes('matrix.platform')) {
        const platforms = JSON.parse(
          (
            Bun.YAML.parse(readText(step.file)) as {
              on: { workflow_call: { inputs: { platforms: { default: string } } } };
            }
          ).on.workflow_call.inputs.platforms.default
        ) as string[];
        for (const platform of platforms) {
          const platformFamily = shared.replace(`${EXPRESSION_START} matrix.platform }}`, platform);
          observed.add(platformFamily);
          expect(families.has(platformFamily), `${step.file}:${platformFamily}`).toBe(true);
        }
        continue;
      }
      observed.add(family);
      expect(families.has(family), `${step.file}:${family}`).toBe(true);
    }
    expect(
      [...observed].sort(),
      'expected every registered family to have a cache producer'
    ).toEqual([...families].filter((family) => !RETIRED_RUST_CACHE_FAMILIES.has(family)).sort());
  });

  test('keeps every cache family behind one composite and one immutable pin', () => {
    for (const file of [...workflowFiles(), ...compositeActionFiles()]) {
      if (file.includes('/cache-scoped/')) continue;
      expect(readText(file), file).not.toContain('uses: actions/cache');
    }

    const manifest = readText('.github/actions/cache-scoped/action.yml');
    const cacheUses =
      manifest.match(/uses: actions\/cache(?:\/(?:restore|save))?@[a-f0-9]{40} # v[^\n]+/g) ?? [];
    expect(cacheUses).toHaveLength(4);
    for (const use of cacheUses) {
      expect(use).toContain(`@${CACHE_ACTION_SHA} # v6.1.0`);
    }
  });

  test('centralizes trusted main restore prefixes and standardized diagnostics', () => {
    const manifest = readText('.github/actions/cache-scoped/action.yml');
    // The key grammar lives in one step; the diagnostics in another. Each line is read from the
    // step that owns it, so a mention in the other step (or in an input description) is no match.
    const keys = extractStepBlock(manifest, 'Resolve scoped cache keys', 4);
    expect(keys).toMatch(/\$\{RUNNER_OS\}-\$\{RUNNER_ARCH\}/);
    expect(keys).toContain(`${EXPRESSION_START} inputs.cache-epoch }}`);
    expect(keys).toContain("github.event_name == 'pull_request'");
    expect(keys).toContain("github.ref == 'refs/heads/main'");
    expect(keys).toContain('-main-');
    expect(manifest).not.toContain('github.sha');
    const outputs = extractTopLevelBlock(manifest, 'outputs');
    for (const output of ['cache-hit', 'cache-restored', 'primary-key', 'restored-prefix']) {
      expect(outputs, `outputs: ${output}`).toMatch(new RegExp(`^ {2}${output}:$`, 'm'));
    }
    expect(extractStepBlock(manifest, 'Summarize scoped cache', 4)).toContain(
      '$GITHUB_STEP_SUMMARY'
    );
    expect(manifest).not.toMatch(/path:.*(?:credential|secret|token)/i);
    expect(keys).toContain('must not contain empty segments');
    expect(keys).toContain("exact-restore must be 'true' or 'false'");
  });

  test('passes the repository epoch fallback to every cache-scoped call and none to setup-mango', () => {
    const sites = cacheScopedCallSites();
    expect(sites.length).toBeGreaterThan(0);

    for (const site of sites) {
      const label = `${site.file}:${site.inputs.family}`;
      if (site.file.startsWith('.github/actions/')) {
        expect(site.block, label).toContain(
          `cache-epoch: ${EXPRESSION_START} inputs.cache-epoch }}`
        );
        continue;
      }
      expect(site.block, label).toContain(CACHE_EPOCH_EXPRESSION);
    }

    for (const workflowFile of workflowFiles()) {
      const lines = readText(workflowFile).split('\n');
      for (const [index, line] of lines.entries()) {
        if (!/uses: [.$]\/\.github\/actions\/setup-mango\b/.test(line)) continue;
        // setup-mango transfers no cache, so it declares no epoch input to pass.
        const followingLines = lines.slice(index + 1, index + 4).map((value) => value.trim());
        expect(
          followingLines.filter((value) => value.startsWith('cache-epoch:')),
          `${workflowFile}:${index + 1}: expected setup-mango cache-epoch input: none | received`
        ).toEqual([]);
      }
    }
  });

  test('covers every expected family with coherent restore-prefix inputs', () => {
    const sites = cacheScopedCallSites();
    const families = [...new Set(sites.map((site) => site.inputs.family))].sort();
    expect(families).toEqual([...EXPECTED_FAMILIES].sort());

    for (const site of sites) {
      const { family, validity, 'restore-prefix': restorePrefix = '' } = site.inputs;
      expect(validity, `${site.file}:${family}`).toBeTruthy();
      if (restorePrefix !== '') {
        expect(validity.startsWith(restorePrefix), `${site.file}:${family}`).toBe(true);
      }
    }
  });

  test('keys each family on its actual toolchain and content invalidators', () => {
    const sites = cacheScopedCallSites();
    const byFamily = (family: string) => sites.filter((site) => site.inputs.family === family);

    // Retired: setup-mango runs a frozen install with no package-cache transfer
    // (#2025, #2057). setup-mango.unit.test.ts pins that contract; this guards
    // every other call site against reviving the family.
    expect(
      byFamily('bun').map((site) => `${site.file}:${site.id}`),
      'expected no cache-scoped call with family: bun | received'
    ).toEqual([]);
    // The revision, not the version: every canary build reports the same
    // `1.4.0-canary.1` from `bun --version`, so a key built on that would share
    // one Bun build's artifacts with a different one. Turbo keys read it from
    // setup-mango's `bun-version` output.
    expect(
      extractStepBlock(
        readText('.github/actions/setup-mango/action.yml'),
        'Resolve Bun revision',
        4
      )
    ).toContain('bun --revision');

    // One restore and one save per producer lane. QA consumes Check's cache
    // read-only; the rotation describe below pins the producer wiring.
    const turbo = byFamily('turbo');
    expect(turbo.map((site) => `${site.file}:${site.inputs.mode}`).sort()).toEqual(
      [...TURBO_LANES.flatMap(({ file }) => [`${file}:restore`, `${file}:save`])].sort()
    );
    for (const site of turbo.filter((candidate) => candidate.inputs.mode === 'restore')) {
      expect(site.inputs['restore-prefix']).toMatch(/^(check|test|build)-$/);
    }
    expect(
      extractStepBlock(
        extractJobBlock(readText('.github/workflows/lint.yml'), 'check'),
        'Resolve check cache toolchains'
      )
    ).toContain('bun run turbo:version');

    // No `vite` family, deliberately: the frontend moved to `Bun.build()`, so
    // nothing populates `node_modules/.vite` and the old optimizer cache was
    // restoring an empty directory keyed partly on a file the bundler no
    // longer reads.
    expect(byFamily('vite')).toHaveLength(0);

    // No `tsbuildinfo` family, deliberately. TypeScript 7.0.2 reports
    // `TS2589: Type instantiation is excessively deep` when a project is
    // checked against a build info file produced from different sources, while
    // a cold check of the very same tree passes. Restoring one across commits
    // therefore made the typecheck disagree with itself: green locally, red on
    // CI, with no file or line to chase. `incremental` is off for the same
    // reason, so there is no build info to cache in the first place — and turbo
    // already skips unchanged workspaces on a content hash, which is the
    // trustworthy half of what this cache was doing.
    expect(byFamily('tsbuildinfo')).toHaveLength(0);
    expect(readText('.github/workflows/lint.yml')).not.toContain('tsc --version');

    const lintTools = byFamily('lint-tools');
    expect(lintTools).toHaveLength(1);
    expect(lintTools[0].inputs.validity).toContain(
      "hashFiles('scripts/lib/actions-lint/manifest.ts')"
    );
    expect(lintTools[0].inputs['exact-restore']).toBe('true');
    // The tools are identical for one manifest hash, so only the trusted main
    // scope stores them; every other run restores that entry and saves nothing.
    expect(lintTools[0].inputs.mode).toBe(
      '$' +
        "{{ github.event_name == 'push' && github.ref == 'refs/heads/main' && 'restore-save' || 'restore' }}"
    );
  });

  // Only `mode: restore` runs actions/cache/restore, the one path that can see
  // a trusted-main match; `restore-save` reports the primary-key hit alone.
  // Gating an install on anything else silently reinstalls on every PR run.
  test('only exact restore-mode call sites expose cache-restored to workflows', () => {
    const gatingIds = new Map<string, Set<string>>();
    for (const site of cacheScopedCallSites()) {
      if (site.id === null) continue;
      if (site.inputs['exact-restore'] !== 'true' || site.inputs.mode !== 'restore') continue;
      const ids = gatingIds.get(site.file) ?? new Set<string>();
      ids.add(site.id);
      gatingIds.set(site.file, ids);
    }

    for (const file of workflowFiles()) {
      const text = readText(file);
      for (const match of text.matchAll(/steps\.([\w-]+)\.outputs\.cache-restored/g)) {
        expect(gatingIds.get(file)?.has(match[1]) ?? false, `${file} references ${match[1]}`).toBe(
          true
        );
      }
    }
  });

  // The two policies below only see steps the job/step split recognises. A
  // rust-cache call it misses (a column-0 comment ending the `jobs:` block, a
  // differently indented step list) would escape both without failing them.
  test('finds every rust-cache call site the policies below check', () => {
    const files = [...workflowFiles(), ...compositeActionFiles()];
    const declared = files.reduce(
      (total, file) =>
        total + [...readText(file).matchAll(new RegExp(RUST_CACHE_USES.source, 'gm'))].length,
      0
    );
    expect(declared, 'expected rust-cache call sites in the workflows').toBeGreaterThan(0);
    expect(rustCacheSteps().length, `rust-cache steps found, of ${declared} declared`).toBe(
      declared
    );
  });

  // Toolchain pruning, the generation prefix and the save gate live in one
  // composite. A workflow that called Swatinem/rust-cache itself would key on
  // whatever toolchains its runner image happens to carry and bring back the
  // dependency-bump misses this composite removes.
  test('reaches Swatinem/rust-cache only through the composite, pinned once', () => {
    const direct = [...workflowFiles(), ...compositeActionFiles()].filter(
      (file) => file !== RUST_CACHE_ACTION && /uses: Swatinem\/rust-cache@/.test(readText(file))
    );
    expect(
      direct,
      `expected no direct Swatinem/rust-cache step outside ${RUST_CACHE_ACTION} | received: ${direct.join(', ')}`
    ).toEqual([]);

    const action = readText(RUST_CACHE_ACTION);
    expect(
      [...action.matchAll(/uses: Swatinem\/rust-cache@(\S+)/g)].map((match) => match[1]),
      `expected one rust-cache use pinned to ${RUST_CACHE_ACTION_SHA}`
    ).toEqual([RUST_CACHE_ACTION_SHA]);
    // Either flag drops the environment or job part of the key the composite relies on.
    expect(action).not.toMatch(/add-(?:job-id|rust-environment-hash)-key:/);
    // Anything written to the job environment could fork rust-cache's environment hash.
    expect(action).not.toContain('GITHUB_ENV');
    expect(action).not.toMatch(/restore-keys:|env-vars:/);
  });

  test('prunes toolchains and digests the profiles before rust-cache computes its key', () => {
    const manifest = Bun.YAML.parse(readText(RUST_CACHE_ACTION)) as {
      runs: { steps: { id?: string }[] };
    };
    expect(manifest.runs.steps.map((step) => step.id)).toEqual(['prune', 'profile', 'cache']);
  });

  // rust-cache keys on the lockfile, toolchain, and environment, not on
  // `[profile.*]`. A profile change then restores an exact-match entry full of
  // artifacts built under the old profile, cargo rebuilds every crate, and the
  // save step skips an exact hit ("Cache up-to-date"), so the stale entry is
  // never replaced. The prefix therefore carries a digest of the profile tables
  // and rust-version. It must not carry the whole manifest: every dependency
  // bump edits that, and rust-cache's restore key then never matches anything
  // (the restore key omits the lockfile hash, not the prefix).
  test('keys the generation on the profile digest and never on the whole root manifest', () => {
    const cache = extractStepBlocksAtIndent(readText(RUST_CACHE_ACTION), 4).find((block) =>
      block.includes('uses: Swatinem/rust-cache@')
    );
    expect(cache, `${RUST_CACHE_ACTION}: rust-cache step with the profile prefix-key`).toContain(
      RUST_CACHE_PREFIX_KEY
    );
    const hashedManifests = [...workflowFiles(), ...compositeActionFiles()].filter((file) =>
      /hashFiles\([^)]*Cargo\.toml/.test(readText(file))
    );
    expect(
      hashedManifests,
      `expected no hashFiles over a Cargo.toml in a cache key | received: ${hashedManifests.join(', ')}`
    ).toEqual([]);
  });

  test('call sites pass only inputs the composite owns the meaning of', () => {
    const steps = rustCacheSteps();
    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) {
      for (const input of Object.keys(parseWithInputs(step.block))) {
        expect(
          RUST_CACHE_CALL_INPUTS.has(input),
          `${step.file}: expected a rust-cache input in [${[...RUST_CACHE_CALL_INPUTS].join(', ')}] | received: ${input}`
        ).toBe(true);
      }
    }
  });

  // Pull requests restore main's rust caches but cannot replace them, so a
  // pull request adds nothing to the configured repository allowance that main's own
  // entries already fill most of.
  test('saves rust caches only from main', () => {
    const cache = extractStepBlocksAtIndent(readText(RUST_CACHE_ACTION), 4).find((block) =>
      block.includes('uses: Swatinem/rust-cache@')
    );
    const conditions = cache?.match(/^ +save-if: .+$/gm) ?? [];
    expect(
      conditions.map((line) => line.trim()),
      `${RUST_CACHE_ACTION}: save conditions`
    ).toEqual([RUST_CACHE_SAVE_IF]);
    // A caller can only switch saving off.
    for (const step of rustCacheSteps()) {
      const readOnly = parseWithInputs(step.block)['read-only'];
      expect(
        [undefined, 'true'],
        `${step.file}: expected read-only to be absent or true | received: ${readOnly}`
      ).toContain(readOnly);
    }
  });

  // The composite's scripts decide every Rust job's cache key. A change to it that selected no
  // lane would merge unexercised (the Gate accepts the skip), so each lane's relevance list names
  // it beside setup-zigbuild, the other composite every Rust lane runs.
  test('every Rust lane relevance list names the rust-cache composite', () => {
    const composite = '.github/actions/rust-cache';
    const filterPaths = (file: string) =>
      [...extractOnBlock(readText(file)).matchAll(/^ {6}- ['"]?([^'"\s]+)['"]?\s*$/gm)].map(
        (match) => match[1]
      );
    const lists: readonly { name: string; names: boolean }[] = [
      {
        name: 'RUST_WORKSPACE_PATHS (scripts/lib/rust-lanes.ts)',
        names: RUST_WORKSPACE_PATHS.includes(`${composite}/**`),
      },
      {
        name: 'cargo-shim.yml push paths',
        names: filterPaths('.github/workflows/cargo-shim.yml').includes(`${composite}/**`),
      },
      {
        name: 'RELEASE_PATTERN (scripts/lib/ci-lanes.ts)',
        names: RELEASE_PATTERN.test(`${composite}/action.yml`),
      },
      {
        name: 'windows-pr-tests.yml paths',
        names: filterPaths('.github/workflows/windows-pr-tests.yml').includes(`${composite}/**`),
      },
      {
        name: 'PROTOCOL_TRIGGER_FILES (scripts/lib/protocol.ts)',
        names: PROTOCOL_TRIGGER_FILES.includes(`${composite}/action.yml`),
      },
      {
        name: 'protocol-ci.yml push paths',
        names: filterPaths('.github/workflows/protocol-ci.yml').includes(`${composite}/action.yml`),
      },
    ];
    for (const { name, names } of lists) {
      expect(names, `expected ${name} to name ${composite} | received: not listed`).toBe(true);
    }
  });

  test('demotes only the measured Ubuntu candidates and retains other platform caches', () => {
    const protocol = readText('.github/workflows/protocol-ci.yml');
    for (const job of ['semver-checks', 'schema-equality']) {
      expect(extractJobBlock(protocol, job), job).not.toContain('actions/rust-cache');
    }
    const interopCache = rustCacheSteps().filter(
      (step) => step.file === '.github/workflows/protocol-ci.yml' && step.job === 'interop'
    );
    expect(interopCache).toHaveLength(1);
    expect(interopCache[0].block).toContain("if: matrix.os != 'ubuntu-latest'");
  });

  // Real-binary qualification builds exactly what the local-runtime action
  // builds, so the two share one cache entry. If either job's cargo builds
  // drift, sharing would restore the wrong artifacts and this must fail.
  test('shares the local runtime cache only while the builds match', () => {
    const cargoBuilds = (text: string) =>
      [...text.matchAll(/cargo build -p mangostudio-runtime[^\n]*/g)].map((match) => match[0]);
    const action = readText('.github/actions/local-runtime/action.yml');
    const qualification = extractJobBlock(
      readText('.github/workflows/cargo-shim.yml'),
      'real-binary-qualification'
    );
    const cacheStep = rustCacheSteps().find(
      (step) =>
        step.file === '.github/workflows/cargo-shim.yml' && qualification.includes(step.block)
    );

    expect(
      extractStepBlock(action, 'Restore the cargo cache', 4),
      'local-runtime action cache key'
    ).toContain('shared-key: local-runtime');
    expect(cacheStep?.block, 'real-binary-qualification rust-cache step').toContain(
      'shared-key: local-runtime'
    );
    expect(cargoBuilds(action), 'local-runtime action cargo builds').toHaveLength(2);
    expect(cargoBuilds(qualification), 'real-binary-qualification cargo builds').toEqual(
      cargoBuilds(action)
    );
  });
});

const KEYS_PREFIX = 'Linux-X64-v1-turbo';
const KEYS_VALIDITY =
  'build-bun-1.4.2+744846f84-turbo-2.11.7-7379dba1e49fa0d1b7defca03d34c2fc2c7d35d274433933c20f200e5ec7d597';
const PULL_REQUEST_EVENT = {
  event_name: 'pull_request',
  ref: 'refs/pull/12/merge',
  run_id: '4242',
  event: { pull_request: { number: 12 } },
} as const;
const MAIN_PUSH_EVENT = {
  event_name: 'push',
  ref: 'refs/heads/main',
  run_id: '4242',
  event: {},
} as const;

/** The env the `keys` step receives once GitHub has interpolated the inputs. */
function keysEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    CACHE_EPOCH: 'v1',
    EXACT_KEY: '',
    EXACT_RESTORE: 'false',
    FAMILY: 'turbo',
    MODE: 'restore',
    PATH_INPUT: '.turbo/cache',
    RESTORE_PREFIX: 'build-',
    ROTATE: 'true',
    ROTATION: '4242-1',
    VALIDITY: KEYS_VALIDITY,
    WRITE_SCOPE: 'main',
    ...overrides,
  };
}

/** `hashFiles('a', 'b')` -> ['a', 'b']. */
function hashedGlobs(validity: string): string[] {
  const args = /hashFiles\(([^)]*)\)/.exec(validity)?.[1] ?? '';
  return args
    .split(',')
    .map((glob) => glob.trim().replace(/^'|'$/g, ''))
    .filter(Boolean);
}

function turboSites(file: string): CacheScopedCallSite[] {
  return cacheScopedCallSites().filter(
    (site) => site.file === file && site.inputs.family === 'turbo'
  );
}

/** A workflow job's `env:` mapping, read from the parsed YAML rather than the text. */
function jobEnv(file: string, job: string): Record<string, string> {
  const workflow = Bun.YAML.parse(readText(file)) as {
    jobs: Record<string, { env?: Record<string, string> }>;
  };
  return workflow.jobs[job]?.env ?? {};
}

function withTempDir<T>(body: (dir: string) => Promise<T> | T): Promise<T> | T {
  const dir = mkdtempSync(join(tmpdir(), 'cache-policy-'));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  try {
    const result = body(dir);
    if (result instanceof Promise) return result.finally(cleanup);
    cleanup();
    return result;
  } catch (error) {
    cleanup();
    throw error;
  }
}

describe('QA canonical Check evidence', () => {
  test('consumes the producer report without a duplicate Turbo cache restore', () => {
    const file = '.github/workflows/qa-metrics.yml';
    expect(turboSites(file)).toEqual([]);
    const collect = extractJobBlock(readText(file), 'collect');
    expect(collect).toContain('name: qa-check-evidence');
    expect(collect).toContain('QA_CHECK_INVOCATION_ID:');
    expect(collect).not.toContain('bun run turbo:version');
    expect(collect).not.toContain('bun run check');
  });
});

describe('Turbo snapshot key', () => {
  for (const { file } of TURBO_LANES) {
    test(`${file} hashes every config that selects a snapshot`, () => {
      const keyed = turboSites(file).find((site) => site.inputs.validity?.includes('hashFiles('));
      const globs = hashedGlobs(keyed?.inputs.validity ?? '');
      const missing = TURBO_KEY_GLOBS.filter((glob) => !globs.includes(glob));
      expect(
        missing,
        `expected ${file} turbo key to hash ${TURBO_KEY_GLOBS.join(', ')} | received missing: ${missing.join(', ')} (hashed: ${globs.join(', ') || 'no hashFiles'})`
      ).toEqual([]);
    });

    test(`${file} hashes a glob that reaches every workspace turbo.json and manifest`, () => {
      const keyed = turboSites(file).find((site) => site.inputs.validity?.includes('hashFiles('));
      const globs = hashedGlobs(keyed?.inputs.validity ?? '');
      const workspaces = (JSON.parse(readText('package.json')) as { workspaces: string[] })
        .workspaces;
      // scanSync reports backslash paths on Windows; the globs are POSIX.
      const files = workspaces.flatMap((pattern) =>
        [...new Bun.Glob(`${pattern}/{package,turbo}.json`).scanSync({ cwd: ROOT_DIR })].map(
          (entry) => entry.replaceAll('\\', '/')
        )
      );
      expect(
        files.filter((candidate) => candidate.endsWith('/turbo.json')).length,
        'expected at least one workspace turbo.json on disk | received: none'
      ).toBeGreaterThan(0);
      for (const candidate of files) {
        const covered = globs.some((glob) => new Bun.Glob(glob).match(candidate));
        expect(
          covered,
          `expected ${file} turbo key to cover '${candidate}' | received globs: ${globs.join(', ')}`
        ).toBe(true);
      }
    });
  }
});

describe('Turbo snapshot rotation', () => {
  for (const lane of TURBO_LANES) {
    test(`${lane.file} restores, runs Turbo, then saves new outputs under a rotated key`, () => {
      const job = extractJobBlock(readText(lane.file), lane.job);
      const sites = turboSites(lane.file);
      const modes = sites.map((site) => site.inputs.mode ?? 'restore-save');
      expect(
        modes,
        `expected ${lane.file} turbo cache modes: restore, save | received: ${modes}`
      ).toEqual(['restore', 'save']);

      const [restore, save] = sites;
      for (const site of sites) {
        expect(
          site.inputs.rotate,
          `expected ${lane.file} turbo ${site.inputs.mode} step rotate: true | received: ${site.inputs.rotate}`
        ).toBe('true');
      }

      const at = (block: string) => job.indexOf(block);
      const commandAt = job.indexOf(lane.command);
      expect(
        at(restore.block) < commandAt && commandAt < at(save.block),
        `expected ${lane.file} step order: restore, '${lane.command}', save | received: restore@${at(restore.block)}, command@${commandAt}, save@${at(save.block)}`
      ).toBe(true);

      // The save step only inherits the restore step's validity, so the two
      // can never key different snapshots.
      expect(
        restore.id,
        `expected ${lane.file} turbo restore step id | received: none`
      ).toBeTruthy();
      expect(
        save.inputs.validity,
        `expected ${lane.file} turbo save validity from the restore step | received: ${save.inputs.validity}`
      ).toBe(`${EXPRESSION_START} steps.${restore.id}.outputs.validity }}`);

      // A hit rewrites an entry's manifest, so without the payload glob every
      // run that only hit would still save.
      expect(
        save.inputs['payload-glob'],
        `expected ${lane.file} turbo save payload-glob *.tar.zst | received: ${save.inputs['payload-glob']}`
      ).toBe('*.tar.zst');

      // Turbo caches only tasks that succeeded, but a red job still must not
      // publish a snapshot another run would restore.
      expect(save.block, `expected ${lane.file} turbo save to run only on success`).toMatch(
        /\bif:\s*success\(\)/
      );
    });
  }

  test('test.yml carries no Turbo cache, no version probe and no snapshot bound', () => {
    const file = '.github/workflows/test.yml';
    const received = turboSites(file).map((site) => `${site.inputs.mode ?? 'restore-save'}`);
    expect(
      received,
      `expected ${file} turbo cache-scoped call sites: none | received: ${received.join(', ')}`
    ).toEqual([]);
    const text = readText(file);
    for (const forbidden of ['bun run turbo:version', '.turbo/cache', 'steps.toolchain']) {
      expect(
        text.includes(forbidden),
        `expected ${file} not to contain '${forbidden}' | received: present`
      ).toBe(false);
    }
    const bounds = Object.keys(jobEnv(file, 'shard')).filter((name) =>
      name.startsWith('TURBO_CACHE_')
    );
    expect(
      bounds,
      `expected no TURBO_CACHE_ bound on the shard job | received: ${bounds.join(', ')}`
    ).toEqual([]);
  });

  test('bounds the restored snapshot the same way in every lane', () => {
    const received = TURBO_LANES.map(({ file, job }) => {
      const bounds = Object.entries(jobEnv(file, job)).filter(([name]) =>
        name.startsWith('TURBO_CACHE_')
      );
      return `${file}: ${bounds.map(([name, value]) => `${name}=${value}`).join(', ') || 'none'}`;
    });
    for (const line of received) {
      expect(
        line.replace(/^[^:]+: /, ''),
        `expected TURBO_CACHE_MAX_SIZE like 16MB and no other TURBO_CACHE_ bound | received: ${line}`
      ).toMatch(/^TURBO_CACHE_MAX_SIZE=\d+MB$/);
    }
    expect(
      new Set(received.map((line) => line.replace(/^[^:]+: /, ''))).size,
      `expected one retention bound across lanes | received: ${received.join(' ; ')}`
    ).toBe(1);
  });

  // The composite and the Turbo lanes run on ubuntu-latest, and the three groups
  // below execute its bash and GNU find (`-printf`, `-newer`). Native macOS uses
  // BSD find and Windows lacks this toolchain. The static pins above run everywhere.
  const onLinuxRunners = test.skipIf(process.platform !== 'linux');

  onLinuxRunners(
    'Turbo evicts the oldest restored entries beyond the configured size',
    async () => {
      const { file, job } = TURBO_LANES[0];
      const names = Object.keys(jobEnv(file, job)).filter((name) =>
        name.startsWith('TURBO_CACHE_')
      );
      await withTempDir(async (dir) => {
        const turbo = join(ROOT_DIR, 'node_modules', '.bin', 'turbo');
        const run = async (
          extra: Record<string, string>,
          task = 'build',
          args: readonly string[] = []
        ) => {
          const proc = Bun.spawn({
            cmd: [turbo, 'run', task, '--ui=stream', ...args],
            cwd: dir,
            env: {
              PATH: process.env.PATH ?? '/usr/bin:/bin',
              HOME: dir,
              TURBO_TELEMETRY_DISABLED: '1',
              ...extra,
            },
            stdout: 'pipe',
            stderr: 'pipe',
          });
          const [stdout, stderr, exitCode] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
          ]);
          expect(
            exitCode,
            `expected Turbo ${task} to exit 0 | received: ${exitCode}\n${stdout}\n${stderr}`
          ).toBe(0);
          return (
            /Cached:\s+(\d+) cached, (\d+) total/.exec(stdout)?.slice(1, 3).join('/') ?? stdout
          );
        };

        writeFileSync(
          join(dir, 'package.json'),
          JSON.stringify({
            name: 'fixture',
            private: true,
            packageManager: 'bun@1.4.2',
            workspaces: ['packages/*'],
            scripts: { 'observe-eviction': 'bun observe-eviction.ts' },
          })
        );
        writeFileSync(
          join(dir, 'turbo.json'),
          JSON.stringify({
            tasks: {
              build: { outputs: ['out/**'] },
              '//#observe-eviction': { cache: false },
            },
          })
        );
        writeFileSync(
          join(dir, 'observe-eviction.ts'),
          `import { existsSync } from 'node:fs';
const archive = process.argv[2];
if (!archive) throw new Error('expected cache archive path | received: missing');
const deadline = Date.now() + 5000;
while (existsSync(archive)) {
  if (Date.now() >= deadline) {
    throw new Error('expected oldest cache archive removed | received: ' + archive + ' still exists');
  }
  await Bun.sleep(10);
}
`
        );
        writeFileSync(join(dir, '.gitignore'), 'out\n.turbo\n');
        for (const name of ['a', 'b']) {
          mkdirSync(join(dir, 'packages', name), { recursive: true });
          writeFileSync(
            join(dir, 'packages', name, 'package.json'),
            JSON.stringify({
              name: `@fixture/${name}`,
              version: '1.0.0',
              scripts: { build: 'mkdir -p out && echo built > out/x.txt' },
            })
          );
        }
        Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: dir });
        Bun.spawnSync({ cmd: ['git', 'add', '-A'], cwd: dir });

        expect(await run({}), 'expected a cold run to cache nothing: cached/total | received').toBe(
          '0/2'
        );

        // One package's entry is two days older than the other's, as an entry in
        // a restored snapshot would be.
        const cache = join(dir, '.turbo', 'cache');
        const entries = readdirSync(cache);
        const agedHash = entries.find((entry) => entry.endsWith('.tar.zst'))?.split('.')[0];
        expect(agedHash, 'expected a cache entry per package | received: none').toBeDefined();
        const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
        for (const entry of entries.filter((name) => name.startsWith(`${agedHash}`))) {
          utimesSync(join(cache, entry), old, old);
        }
        const totalBytes = entries.reduce(
          (sum, entry) => sum + statSync(join(cache, entry)).size,
          0
        );

        // Control: without a bound both entries still hit, so the miss below is
        // the eviction and not a broken fixture.
        expect(
          await run({}),
          'expected entries to hit without a bound: cached/total | received'
        ).toBe('2/2');

        // Same variable name the workflows set, sized to hold one of the two entries.
        const bound = Object.fromEntries(
          names.map((name) => [name, `${((totalBytes * 0.75) / 1024 ** 2).toFixed(8)}MB`])
        );
        expect(names, 'expected the workflows to set TURBO_CACHE_MAX_SIZE | received').toEqual([
          'TURBO_CACHE_MAX_SIZE',
        ]);
        // Turbo evicts in a background thread. A build can fetch both entries
        // before eviction finishes, or recreate a removed entry as it builds.
        // An uncached observer leaves the archives alone and keeps Turbo alive
        // until the oldest one is gone, then a separate build proves the miss.
        const agedArchive = join(cache, `${agedHash}.tar.zst`);
        await run(bound, 'observe-eviction', ['--', agedArchive]);
        expect(
          existsSync(agedArchive),
          `expected oldest cache archive removed | received: ${agedArchive} still exists`
        ).toBe(false);
        expect(
          await run({}),
          `expected the oldest entry evicted under ${names[0]}: cached/total | received`
        ).toBe('1/2');
      });
    }
  );

  describe.skipIf(process.platform !== 'linux')('the keys the composite resolves', () => {
    test('keep the unrotated key when rotation is off', async () => {
      await withTempDir(async (dir) => {
        const result = await runCompositeStep('keys', keysEnv({ ROTATE: 'false' }), dir);
        expect(result.exitCode, result.stderr).toBe(0);
        expect(result.outputs['primary-key'], 'expected unrotated primary key | received').toBe(
          `${KEYS_PREFIX}-main-${KEYS_VALIDITY}`
        );
      });
    });

    test('a restore that is not an exact hit saves under a new key with the stable restore prefix', async () => {
      await withTempDir(async (dir) => {
        const first = await runCompositeStep('keys', keysEnv({ ROTATION: '4242-1' }), dir);
        const rerun = await runCompositeStep('keys', keysEnv({ ROTATION: '4242-2' }), dir);
        expect(first.exitCode, first.stderr).toBe(0);

        const stable = `${KEYS_PREFIX}-main-${KEYS_VALIDITY}`;
        const lane = `${KEYS_PREFIX}-main-build-`;
        const restoreKeys = first.outputs['restore-keys'].split('\n');
        const primary = first.outputs['primary-key'];
        // The whole list, not a membership check: a bare family prefix or a
        // `pr-` key added here would let main restore what a pull request wrote.
        expect(
          restoreKeys,
          `expected main restore-keys [${stable}, ${lane}] | received: ${restoreKeys.join(', ')}`
        ).toEqual([stable, lane]);
        expect(
          primary.startsWith(`${stable}-`),
          `expected save key to extend the stable restore prefix ${stable}- | received: ${primary}`
        ).toBe(true);
        expect(
          restoreKeys.includes(primary),
          `expected save key to differ from every restore key | received: ${primary}`
        ).toBe(false);
        expect(
          rerun.outputs['primary-key'],
          `expected a re-run attempt to save under its own key | received: ${rerun.outputs['primary-key']}`
        ).not.toBe(primary);
      });
    });

    test('a pull request restores its own chain, then main, and saves only under its own scope', async () => {
      await withTempDir(async (dir) => {
        const scope = evaluateWriteScope(PULL_REQUEST_EVENT);
        const result = await runCompositeStep('keys', keysEnv({ WRITE_SCOPE: scope }), dir);
        expect(result.exitCode, result.stderr).toBe(0);

        const own = `${KEYS_PREFIX}-pr-12-${KEYS_VALIDITY}-`;
        const stable = `${KEYS_PREFIX}-main-${KEYS_VALIDITY}`;
        const lane = `${KEYS_PREFIX}-main-build-`;
        const restoreKeys = result.outputs['restore-keys'].split('\n');
        const primary = result.outputs['primary-key'];
        expect(
          restoreKeys,
          `expected restore order: own chain, trusted main, loose main lane | received: ${restoreKeys.join(', ')}`
        ).toEqual([own, stable, lane]);
        for (const key of restoreKeys.slice(1)) {
          expect(
            key.startsWith(`${KEYS_PREFIX}-main-`),
            `expected every restore key after the pull request's own to start with ${KEYS_PREFIX}-main- | received: ${key}`
          ).toBe(true);
        }
        expect(
          primary.startsWith(own),
          `expected pull request save key under ${own} | received: ${primary}`
        ).toBe(true);
      });
    });

    test('a pull request ref cannot save under the main prefix', async () => {
      await withTempDir(async (dir) => {
        // Even a pull_request event that claims main's ref keeps its own scope:
        // the event name decides, and only a push to main reaches `main`.
        const events = [
          PULL_REQUEST_EVENT,
          { ...PULL_REQUEST_EVENT, ref: 'refs/heads/main' },
          { ...PULL_REQUEST_EVENT, event_name: 'pull_request_target' },
          { ...MAIN_PUSH_EVENT, event_name: 'workflow_dispatch' },
        ];
        for (const event of events) {
          const scope = evaluateWriteScope(event);
          expect(
            scope,
            `expected write scope pr-<n> or run-<id> for ${event.event_name} on ${event.ref} | received: ${scope}`
          ).toMatch(/^(pr-\d+|run-\d+)$/);
          for (const mode of ['restore', 'save']) {
            const result = await runCompositeStep(
              'keys',
              keysEnv({ WRITE_SCOPE: scope, MODE: mode }),
              dir
            );
            const primary = result.outputs['primary-key'];
            expect(
              primary.startsWith(`${KEYS_PREFIX}-main-`),
              `expected ${event.event_name} ${mode} key outside ${KEYS_PREFIX}-main- | received: ${primary}`
            ).toBe(false);
          }
        }
        expect(
          evaluateWriteScope(MAIN_PUSH_EVENT),
          'expected a push to main to write scope main'
        ).toBe('main');
      });
    });

    test('refuse a rotation the mode cannot honour', async () => {
      await withTempDir(async (dir) => {
        const unsupported = await runCompositeStep('keys', keysEnv({ MODE: 'restore-save' }), dir);
        expect(unsupported.exitCode, 'expected exit 1 for rotate with mode restore-save').toBe(1);
        expect(unsupported.stdout).toContain(
          "cache-scoped rotate requires mode restore or save (got 'restore-save')"
        );

        const invalid = await runCompositeStep('keys', keysEnv({ ROTATE: 'yes' }), dir);
        expect(invalid.exitCode, 'expected exit 1 for rotate yes').toBe(1);
        expect(invalid.stdout).toContain(
          "cache-scoped rotate must be 'true' or 'false' (got 'yes')"
        );
      });
    });
  });

  describe.skipIf(process.platform !== 'linux')('the save decision', () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const SAVE_KEY = `${KEYS_PREFIX}-pr-12-${KEYS_VALIDITY}-4242-1`;

    /** A working dir holding a restored cache whose entries date from before the restore. */
    function restoredCache(dir: string): { env: Record<string, string>; cache: string } {
      const cache = join(dir, '.turbo', 'cache');
      mkdirSync(cache, { recursive: true });
      mkdirSync(join(dir, 'runner-temp'));
      const restored = join(cache, 'aaaa.tar.zst');
      writeFileSync(restored, 'restored');
      const past = new Date(Date.now() - DAY_MS);
      utimesSync(restored, past, past);
      return {
        cache,
        env: {
          FAMILY: 'turbo',
          PATH_INPUT: '.turbo/cache',
          PAYLOAD_GLOB: '*.tar.zst',
          PRIMARY_KEY: SAVE_KEY,
          RUNNER_TEMP: join(dir, 'runner-temp'),
        },
      };
    }

    test('saves when Turbo wrote an entry the restored snapshot lacked', async () => {
      await withTempDir(async (dir) => {
        const { env, cache } = restoredCache(dir);
        const baseline = await runCompositeStep('baseline', env, dir);
        expect(baseline.exitCode, baseline.stderr).toBe(0);
        expect(
          baseline.stdout,
          'expected the baseline step to log the restored file count | received'
        ).toContain('restored baseline files=`1`');

        const fresh = join(cache, 'bbbb.tar.zst');
        writeFileSync(fresh, 'computed this run');
        const later = new Date(Date.now() + 5000);
        utimesSync(fresh, later, later);

        const delta = await runCompositeStep('delta', env, dir);
        expect(delta.exitCode, delta.stderr).toBe(0);
        expect(
          delta.outputs['new-files'],
          'expected new cache files since restore: count | received'
        ).toBe('1');
        expect(
          delta.stdout,
          'expected the delta step to log the file that made the save necessary | received'
        ).toContain('bbbb.tar.zst');
        expect(delta.summary, 'expected the step summary to name the key being saved').toContain(
          SAVE_KEY
        );
      });
    });

    test('skips the save when the run only hit the restored snapshot', async () => {
      await withTempDir(async (dir) => {
        const { env } = restoredCache(dir);
        await runCompositeStep('baseline', env, dir);

        const delta = await runCompositeStep('delta', env, dir);
        expect(delta.exitCode, delta.stderr).toBe(0);
        expect(
          delta.outputs['new-files'],
          'expected new cache files since restore: count | received'
        ).toBe('0');
      });
    });

    test('skips the save when a hit only rewrote an entry manifest', async () => {
      await withTempDir(async (dir) => {
        const { env, cache } = restoredCache(dir);
        const manifest = join(cache, 'aaaa-manifest.json');
        writeFileSync(manifest, '{}');
        const past = new Date(Date.now() - DAY_MS);
        utimesSync(manifest, past, past);
        await runCompositeStep('baseline', env, dir);

        // Observed on hosted runners: Turbo rewrites <hash>-manifest.json on
        // every hit, while <hash>.tar.zst is written once, on a miss.
        writeFileSync(manifest, '{"rewritten":true}');
        const later = new Date(Date.now() + 5000);
        utimesSync(manifest, later, later);

        const delta = await runCompositeStep('delta', env, dir);
        expect(delta.exitCode, delta.stderr).toBe(0);
        expect(
          delta.outputs['new-files'],
          'expected a rewritten manifest alone to count 0 new cache files | received'
        ).toBe('0');
      });
    });

    test('counts every entry when the restore found nothing', async () => {
      await withTempDir(async (dir) => {
        mkdirSync(join(dir, 'runner-temp'));
        const env = {
          FAMILY: 'turbo',
          PATH_INPUT: '.turbo/cache',
          PAYLOAD_GLOB: '*.tar.zst',
          PRIMARY_KEY: SAVE_KEY,
          RUNNER_TEMP: join(dir, 'runner-temp'),
        };
        await runCompositeStep('baseline', env, dir);
        expect(existsSync(join(dir, '.turbo'))).toBe(false);

        mkdirSync(join(dir, '.turbo', 'cache'), { recursive: true });
        const fresh = join(dir, '.turbo', 'cache', 'cccc.tar.zst');
        writeFileSync(fresh, 'computed this run');
        const later = new Date(Date.now() + 5000);
        utimesSync(fresh, later, later);

        const delta = await runCompositeStep('delta', env, dir);
        expect(
          delta.outputs['new-files'],
          'expected new cache files since restore: count | received'
        ).toBe('1');
      });
    });

    test('fails closed when no restore ran before the save', async () => {
      await withTempDir(async (dir) => {
        const { env } = restoredCache(dir);
        const delta = await runCompositeStep('delta', env, dir);
        expect(delta.exitCode, 'expected exit 1 for a save with no restore baseline').toBe(1);
        expect(delta.stdout).toContain(
          'cache-scoped rotate save found no restore baseline for family turbo'
        );
      });
    });
  });
});
