import { describe, expect, test } from 'bun:test';

import { readText } from './support/read-text';
import { cacheScopedCallSites } from './support/workflow-files';

interface SetupStep {
  readonly id?: string;
  readonly name?: string;
  readonly if?: string;
  readonly run?: string;
  readonly uses?: string;
}

interface SetupManifest {
  readonly outputs?: Readonly<Record<string, unknown>>;
  readonly runs: { readonly steps: readonly SetupStep[] };
}

const MANIFEST_PATH = '.github/actions/setup-mango/action.yml';

function manifest(): SetupManifest {
  return Bun.YAML.parse(readText(MANIFEST_PATH)) as SetupManifest;
}

const describeStep = (step: SetupStep) => step.name ?? step.id ?? step.uses ?? '<unnamed>';

describe('setup-mango frozen install without a Bun package cache', () => {
  test('runs exactly one unconditional frozen install', () => {
    const installs = manifest().runs.steps.filter((step) =>
      step.run?.includes('bun install --frozen-lockfile')
    );
    expect(
      installs.map(describeStep),
      `(${MANIFEST_PATH}): expected frozen install steps: 1 | received`
    ).toHaveLength(1);
    expect(
      installs[0].if,
      `(${MANIFEST_PATH}): expected install step condition: none | received`
    ).toBeUndefined();
  });

  test('transfers no cache: no cache-scoped or actions/cache step', () => {
    const transfers = manifest()
      .runs.steps.filter((step) => /actions\/cache|\/cache-scoped/.test(step.uses ?? ''))
      .map((step) => `${describeStep(step)} (${step.uses})`);
    expect(transfers, `(${MANIFEST_PATH}): expected cache-transfer steps: none | received`).toEqual(
      []
    );
  });

  test('exposes only the Bun revision output that Turbo keys read', () => {
    expect(
      Object.keys(manifest().outputs ?? {}),
      `(${MANIFEST_PATH}): expected outputs: bun-version | received`
    ).toEqual(['bun-version']);
  });

  test('no cache-scoped call under .github/ uses family: bun', () => {
    const bunCalls = cacheScopedCallSites()
      .filter((site) => site.inputs.family === 'bun')
      .map((site) => `${site.file}:${site.id ?? '<no id>'}`);
    expect(bunCalls, 'expected cache-scoped calls with family: bun: none | received').toEqual([]);
  });
});
