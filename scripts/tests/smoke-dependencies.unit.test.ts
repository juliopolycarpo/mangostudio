import { describe, expect, test } from 'bun:test';

import { readText } from './support/read-text';
import { walkRuntimeImports } from './support/runtime-imports';
import { extractJobBlock, extractStepBlocks } from './support/workflow-blocks';

const KNOWN_SMOKE_ENTRYPOINTS = [
  'scripts/test-build.ts',
  'scripts/release/extract-distribution.ts',
  'scripts/release/distribution-manifest.ts',
  'scripts/release/stage-docker-ctx.ts',
] as const;

const BUN_SCRIPT_ENTRY_RE =
  /\bbun((?:\s+--[^\s]+)*)\s+(?:run\s+)?(?:\.\/)?(scripts\/[\w./-]+\.ts)\b/g;

const SMOKE_SOURCE_FILES = [
  '.github/workflows/smoke-binary.yml',
  '.github/actions/download-distribution/action.yml',
] as const;

interface BunScriptInvocation {
  readonly source: string;
  readonly script: string;
  readonly flags: readonly string[];
}

function bunScriptInvocations(): BunScriptInvocation[] {
  const invocations: BunScriptInvocation[] = [];
  for (const source of SMOKE_SOURCE_FILES) {
    for (const match of readText(source).matchAll(BUN_SCRIPT_ENTRY_RE)) {
      const script = match[2];
      if (script) {
        invocations.push({ source, script, flags: (match[1] ?? '').split(/\s+/).filter(Boolean) });
      }
    }
  }
  return invocations;
}

function deriveSmokeScriptEntrypoints(): string[] {
  return [...new Set(bunScriptInvocations().map((invocation) => invocation.script))].sort();
}

describe('smoke matrix runtime dependencies', () => {
  test('derives script entrypoints from smoke workflow and download-distribution', () => {
    const entrypoints = deriveSmokeScriptEntrypoints();
    expect(entrypoints.length).toBeGreaterThan(0);
    for (const known of KNOWN_SMOKE_ENTRYPOINTS) {
      expect(entrypoints, known).toContain(known);
    }
  });

  test('smoke script invocations opt out of auto-install', () => {
    for (const { source, script, flags } of bunScriptInvocations()) {
      expect(flags, `${source} → ${script}`).toContain('--no-install');
    }
  });

  test('smoke script entrypoints have no external runtime imports', () => {
    for (const entry of deriveSmokeScriptEntrypoints()) {
      const { externalSpecifiers } = walkRuntimeImports(entry);
      expect([...externalSpecifiers.keys()], entry).toEqual([]);
    }
  });

  test('runtime import walker detects external packages on a known consumer', () => {
    const { externalSpecifiers } = walkRuntimeImports('scripts/qa-gate/metrics-envelope.ts');
    expect(externalSpecifiers.has('@sinclair/typebox')).toBe(true);
  });

  test('smoke jobs install dependencies only when rebuild is enabled', () => {
    const workflow = readText('.github/workflows/smoke-binary.yml');
    for (const job of ['binary', 'docker'] as const) {
      const jobBlock = extractJobBlock(workflow, job);
      expect(jobBlock).toContain('uses: oven-sh/setup-bun@');
      const setupMangoSteps = extractStepBlocks(jobBlock).filter((step) =>
        /uses: \.\/\.github\/actions\/setup-mango/.test(step)
      );
      expect(setupMangoSteps, job).toHaveLength(1);
      expect(setupMangoSteps[0]).toMatch(/if: \$\{\{ inputs\.rebuild \}\}/);
    }
    expect(workflow).not.toMatch(
      /persist-credentials: false\n\n\s+- uses: \.\/\.github\/actions\/setup-mango/
    );
  });
});
