import { describe, expect, test } from 'bun:test';

import { readText } from './support/read-text';
import { extractJobBlocks, extractStepBlocksAtIndent } from './support/workflow-blocks';
import {
  cacheScopedCallSites,
  compositeActionFiles,
  workflowFiles,
} from './support/workflow-files';

const CACHE_ACTION_SHA = '55cc8345863c7cc4c66a329aec7e433d2d1c52a9';
const EXPRESSION_START = '$' + '{{';
const CACHE_EPOCH_EXPRESSION = `cache-epoch: ${EXPRESSION_START} vars.CI_CACHE_EPOCH || 'v1' }}`;
const EXPECTED_FAMILIES = ['bun', 'turbo', 'lint-tools', 'playwright', 'timings'] as const;
const RUST_CACHE_PREFIX_KEY = `prefix-key: v0-rust-${EXPRESSION_START} hashFiles('Cargo.toml') }}`;
const RUST_CACHE_SAVE_IF = `save-if: ${EXPRESSION_START} github.ref == 'refs/heads/main' }}`;
// The fuzz workspace is excluded from the root workspace and has its own
// manifest, so the root manifest's profiles never apply to it.
const RUST_CACHE_EXEMPT_FILES = new Set(['.github/workflows/protocol-fuzz.yml']);

interface RustCacheStep {
  readonly file: string;
  readonly block: string;
}

/**
 * Every Swatinem/rust-cache step across workflows (steps at indent 6) and
 * composite actions (steps at indent 4), outside the exempt fuzz workspace.
 *
 * @example
 * for (const step of rustCacheSteps()) expect(step.block).toContain('prefix-key:');
 */
function rustCacheSteps(): RustCacheStep[] {
  const isRustCache = (block: string) => /^\s*(?:-\s+)?uses: Swatinem\/rust-cache@/m.test(block);
  const workflowSteps = workflowFiles()
    .filter((file) => !RUST_CACHE_EXEMPT_FILES.has(file))
    .flatMap((file) =>
      extractJobBlocks(readText(file)).flatMap(({ block }) =>
        extractStepBlocksAtIndent(block, 6).map((step) => ({ file, block: step }))
      )
    );
  const actionSteps = compositeActionFiles().flatMap((file) =>
    extractStepBlocksAtIndent(readText(file), 4).map((step) => ({ file, block: step }))
  );
  return [...workflowSteps, ...actionSteps].filter((step) => isRustCache(step.block));
}

describe('CI cache policy', () => {
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
    expect(manifest).toMatch(/\$\{RUNNER_OS\}-\$\{RUNNER_ARCH\}/);
    expect(manifest).toContain(`${EXPRESSION_START} inputs.cache-epoch }}`);
    expect(manifest).toContain("github.event_name == 'pull_request'");
    expect(manifest).toContain("github.ref == 'refs/heads/main'");
    expect(manifest).toContain('-main-');
    expect(manifest).not.toContain('github.sha');
    for (const output of ['cache-hit:', 'cache-restored:', 'primary-key:', 'restored-prefix:']) {
      expect(manifest).toContain(output);
    }
    expect(manifest).toContain('$GITHUB_STEP_SUMMARY');
    expect(manifest).not.toMatch(/path:.*(?:credential|secret|token)/i);
    expect(manifest).toContain('must not contain empty segments');
    expect(manifest).toContain("exact-restore must be 'true' or 'false'");
  });

  test('passes the repository epoch fallback to every cache-scoped call', () => {
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
        if (!line.includes('uses: ./.github/actions/setup-mango')) continue;
        const followingLines = lines.slice(index + 1, index + 4).map((value) => value.trim());
        expect(followingLines, `${workflowFile}:${index + 1}`).toContain(CACHE_EPOCH_EXPRESSION);
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

    const bun = byFamily('bun');
    expect(bun).toHaveLength(1);
    expect(bun[0].inputs.validity).toContain("hashFiles('bun.lock')");
    // The revision, not the version: every canary build reports the same
    // `1.4.0-canary.1` from `bun --version`, so a key built on that would share
    // one Bun build's extracted packages with a different one.
    expect(readText('.github/actions/setup-mango/action.yml')).toContain('bun --revision');

    const turbo = byFamily('turbo');
    expect(turbo.length).toBeGreaterThan(0);
    for (const site of turbo) {
      expect(site.inputs.validity).toContain("hashFiles('turbo.jsonc', 'package.json'");
      expect(site.inputs['restore-prefix']).toMatch(/^(check|test|build)-$/);
    }
    expect(readText('.github/workflows/lint.yml')).toContain('bun run turbo:version');

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
    expect(readText('.github/workflows/lint.yml')).toContain('tsc --version');

    const lintTools = byFamily('lint-tools');
    expect(lintTools).toHaveLength(1);
    expect(lintTools[0].inputs.validity).toContain(
      "hashFiles('scripts/lib/actions-lint/manifest.ts')"
    );
    expect(lintTools[0].inputs['exact-restore']).toBe('true');

    const playwright = byFamily('playwright');
    expect(playwright.length).toBe(2);
    for (const site of playwright) {
      expect(site.inputs['exact-restore']).toBe('true');
      expect(['restore', 'save']).toContain(site.inputs.mode);
    }
    expect(readText('.github/workflows/browser-smoke.yml')).toContain('playwright --version');
    expect(readText('.github/workflows/browser-smoke.yml')).toContain(
      "steps.pw-cache.outputs.cache-restored == 'true'"
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

  // rust-cache keys on the lockfile, toolchain, and environment, not on
  // `[profile.*]`. A profile change then restores an exact-match entry full of
  // artifacts built under the old profile, cargo rebuilds every crate, and the
  // save step skips an exact hit ("Cache up-to-date"), so the stale entry is
  // never replaced. Hashing the root manifest into the prefix makes a profile
  // change a new key.
  test('keys every rust-cache step on the root manifest', () => {
    const steps = rustCacheSteps();
    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) {
      expect(step.block, `${step.file}: rust-cache step without the manifest prefix-key`).toContain(
        RUST_CACHE_PREFIX_KEY
      );
    }
  });

  // Pull requests restore main's rust caches but cannot replace them, so a
  // pull request adds nothing to the 10 GiB repository quota that main's own
  // entries already fill most of.
  test('saves rust caches only from main', () => {
    const steps = rustCacheSteps();
    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) {
      expect(step.block, `${step.file}: rust-cache step that saves outside main`).toContain(
        RUST_CACHE_SAVE_IF
      );
    }
  });
});
