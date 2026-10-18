import { describe, expect, test } from 'bun:test';

import { readText } from './support/read-text';
import { extractStepBlocksAtIndent } from './support/workflow-blocks';
import { cacheScopedCallSites } from './support/workflow-files';

interface SetupStep {
  readonly id?: string;
  readonly name?: string;
  readonly if?: string;
  readonly run?: string;
  readonly with?: Readonly<Record<string, string>>;
  readonly 'continue-on-error'?: boolean;
}

function setupSteps(): readonly SetupStep[] {
  const manifest = Bun.YAML.parse(readText('.github/actions/setup-mango/action.yml')) as {
    runs: { steps: SetupStep[] };
  };
  return manifest.runs.steps;
}

// Only the conjunction/comparison subset used by this composite. An unsupported
// expression fails the test rather than silently treating an unknown guard as true.
function stepRuns(step: SetupStep, facts: Readonly<Record<string, string>>): boolean {
  if (!step.if) return facts.success === 'true';
  return step.if.split(' && ').every((term) => {
    const group = term.replace(/^\((.*)\)$/, '$1');
    return group.split(' || ').some((comparison) => {
      if (comparison === 'success()') return facts.success === 'true';
      const match = /^([\w.-]+) (==|!=) '([^']*)'$/.exec(comparison);
      if (!match) throw new Error(`Unsupported setup condition: ${comparison}`);
      const [, key, operator, expected] = match;
      if (!(key in facts)) throw new Error(`Missing setup condition fact: ${key}`);
      return operator === '==' ? facts[key] === expected : facts[key] !== expected;
    });
  });
}

/** Named fake of the external immutable cache service; compression precedes reservation. */
class FakeBunCache {
  lookups = 0;
  compressions = 0;
  saves = 0;

  constructor(
    readonly present: boolean,
    readonly lookup: 'true' | 'false' | '' | 'failure' = present ? 'true' : 'false'
  ) {}

  check(): string {
    this.lookups += 1;
    if (this.lookup === 'failure') throw new Error('Cache lookup unavailable');
    return this.lookup;
  }

  save(): void {
    this.compressions += 1;
    if (!this.present) this.saves += 1;
  }
}

function runSetup(
  cache: FakeBunCache,
  overrides: Readonly<Record<string, string>> = {},
  failedLookupOutput = ''
): { installs: number } {
  const facts: Record<string, string> = {
    success: 'true',
    'github.event_name': 'push',
    'github.ref': 'refs/heads/main',
    'steps.cache.outputs.cache-hit': 'false',
    'steps.bun-save-check.outcome': 'skipped',
    'steps.bun-save-check.outputs.cache-hit': '',
    ...overrides,
  };
  let installs = 0;
  for (const step of setupSteps()) {
    if (!stepRuns(step, facts)) continue;
    if (step.run?.includes('bun install --frozen-lockfile')) installs += 1;
    if (step.id === 'bun-save-check') {
      try {
        facts['steps.bun-save-check.outputs.cache-hit'] = cache.check();
        facts['steps.bun-save-check.outcome'] = 'success';
      } catch {
        facts['steps.bun-save-check.outputs.cache-hit'] = failedLookupOutput;
        facts['steps.bun-save-check.outcome'] = 'failure';
        if (!step['continue-on-error']) facts.success = 'false';
      }
    }
    if (step.with?.mode === 'save' && step.with.family === 'bun') cache.save();
  }
  return { installs };
}

describe('setup-mango Bun cache lifecycle', () => {
  test('saves the populated Bun cache inline only after a successful main push miss', () => {
    const manifest = readText('.github/actions/setup-mango/action.yml');
    const steps = extractStepBlocksAtIndent(manifest, 4);
    const bun = cacheScopedCallSites().filter((site) => site.inputs.family === 'bun');
    expect(bun.map((site) => site.inputs.mode)).toEqual(['restore', 'restore', 'save']);
    const [restore, , save] = bun;
    for (const input of ['family', 'path', 'validity', 'cache-epoch']) {
      expect(save.inputs[input], input).toBe(restore.inputs[input]);
    }
    expect(restore.id).toBe('cache');
    expect(save.block).toContain("success() && github.event_name == 'push'");
    expect(save.block).toContain("github.ref == 'refs/heads/main'");
    expect(save.block).toContain("steps.cache.outputs.cache-hit != 'true'");
    const install = steps.findIndex((step) => step.includes('bun install --frozen-lockfile'));
    expect(install).toBeGreaterThan(steps.indexOf(restore.block));
    expect(install).toBeLessThan(steps.indexOf(save.block));
    expect(steps[install]).not.toMatch(/\n\s+if:/);
    expect(restore.inputs['fail-on-cache-miss']).toBeUndefined();
  });
});

describe('setup-mango late Bun writer lookup', () => {
  test('does not compress when another writer already completed the exact key', () => {
    const cache = new FakeBunCache(true);
    expect(runSetup(cache).installs).toBe(1);
    expect(cache.lookups).toBe(1);
    expect(cache.compressions).toBe(0);
  });

  test('allows another eligible writer to save when the preferred writer never completes', () => {
    const cache = new FakeBunCache(false);
    expect(runSetup(cache).installs).toBe(1);
    expect(cache.compressions).toBe(1);
    expect(cache.saves).toBe(1);
  });

  test.each(['false', ''] as const)('does not suppress a save on a non-exact result: %j', (hit) => {
    const cache = new FakeBunCache(false, hit);
    runSetup(cache);
    expect(cache.saves).toBe(1);
  });

  test('falls back to the normal save after a lookup failure, even with a stale true output', () => {
    const cache = new FakeBunCache(false, 'failure');
    expect(runSetup(cache, {}, 'true').installs).toBe(1);
    expect(cache.lookups).toBe(1);
    expect(cache.saves).toBe(1);
  });

  test('keeps an immutable reservation collision possible after simultaneous lookup misses', () => {
    const cache = new FakeBunCache(true, 'false');
    runSetup(cache);
    expect(cache.lookups).toBe(1);
    expect(cache.compressions).toBe(1);
    expect(cache.saves).toBe(0);
  });

  test('still installs on an initial exact hit without lookup or save', () => {
    const cache = new FakeBunCache(true);
    expect(runSetup(cache, { 'steps.cache.outputs.cache-hit': 'true' }).installs).toBe(1);
    expect(cache.lookups).toBe(0);
    expect(cache.compressions).toBe(0);
  });

  test.each([
    { 'github.event_name': 'pull_request', 'github.ref': 'refs/pull/42/merge' },
    { 'github.event_name': 'push', 'github.ref': 'refs/heads/feature' },
    { 'github.event_name': 'workflow_dispatch', 'github.ref': 'refs/heads/main' },
    { 'github.event_name': 'schedule', 'github.ref': 'refs/heads/main' },
  ])('keeps lookup and save outside ineligible event/ref: %j', (facts) => {
    const cache = new FakeBunCache(false);
    expect(runSetup(cache, facts).installs).toBe(1);
    expect(cache.lookups).toBe(0);
    expect(cache.compressions).toBe(0);
  });

  test('does not look up or save after a mandatory failure or cancellation', () => {
    const cache = new FakeBunCache(false);
    runSetup(cache, { success: 'false' });
    expect(cache.lookups).toBe(0);
    expect(cache.compressions).toBe(0);
  });

  test('uses the same archive identity for an exact metadata-only lookup after frozen install', () => {
    const steps = setupSteps();
    const restore = steps.find((step) => step.id === 'cache');
    const lookup = steps.find((step) => step.id === 'bun-save-check');
    const save = steps.find((step) => step.with?.mode === 'save');
    for (const key of ['family', 'path', 'validity', 'cache-epoch']) {
      expect(lookup?.with?.[key], key).toBe(restore?.with?.[key]);
      expect(lookup?.with?.[key], key).toBe(save?.with?.[key]);
    }
    expect(lookup?.with?.['lookup-only']).toBe('true');
    expect(lookup?.with?.['exact-restore']).toBe('true');
    expect(lookup?.['continue-on-error']).toBe(true);
    expect(steps.indexOf(lookup as SetupStep)).toBeGreaterThan(
      steps.findIndex((step) => step.run?.includes('bun install --frozen-lockfile'))
    );
    expect(steps.indexOf(lookup as SetupStep)).toBeLessThan(steps.indexOf(save as SetupStep));
  });
});
