import { describe, expect, it } from 'bun:test';

import type { WorkspaceName } from '../../lib/config';
import type { CoverageSummary } from '../model/metrics';
import { type Measurement, measured, stale, unavailable, unsupported } from '../model/states';
import { BASE_REPOSITORY_FILES, makeFakeRepository } from '../testing/fake-repository';
import { expectState } from '../testing/measurement-assertions';
import { makeCoverageSummary } from '../testing/metrics-fixture';
import { type ComponentDeps, collectComponents, coverageLane } from './components';
import { type ComponentSpec, discoverComponents } from './registry';

interface Calls {
  readonly coverageReads: WorkspaceName[];
  readonly tsRoots: string[];
}

const makeDeps = (
  overrides: Partial<ComponentDeps> = {}
): { deps: ComponentDeps; calls: Calls } => {
  const repo = makeFakeRepository(BASE_REPOSITORY_FILES);
  const calls: Calls = { coverageReads: [], tsRoots: [] };
  const deps: ComponentDeps = {
    trackedFiles: repo.trackedFiles,
    readText: repo.readText,
    deliveredCoverage: () => null,
    deliveredLanes: () => unavailable('no lane results in this fixture'),
    deliveredRustCoverage: () => unsupported('no rust coverage in this fixture'),
    readCoverage: (lane) => {
      calls.coverageReads.push(lane);
      return Promise.resolve(makeCoverageSummary(55));
    },
    countTsErrors: (root) => {
      calls.tsRoots.push(root);
      return Promise.resolve(2);
    },
    ...overrides,
  };
  return { deps, calls };
};

const specsOf = (): Promise<ComponentSpec[]> => {
  const repo = makeFakeRepository(BASE_REPOSITORY_FILES);
  return discoverComponents(repo);
};

const byName = <T extends { name: string }>(components: readonly T[], name: string): T => {
  const found = components.find((component) => component.name === name);
  if (!found)
    throw new Error(`expected component ${name} | received: ${components.map((c) => c.name)}`);
  return found;
};

describe('collectComponents', () => {
  it('measures every discovered component with a state per measurement', async () => {
    const { deps } = makeDeps();

    const components = await collectComponents(await specsOf(), deps);

    expect(components.map((component) => component.id)).toEqual([
      'workspace:@x/api',
      'crate:alpha-crate',
      'crate:beta',
      'workspace:mangostudio',
      'scripts:scripts',
    ]);
    for (const component of components) {
      expect(component.loc.state).toBe('measured');
    }
  });

  it('counts a nested root once, under the component that owns it', async () => {
    const { deps } = makeDeps();

    const components = await collectComponents(await specsOf(), deps);
    const alpha = expectState(byName(components, 'alpha-crate').loc, 'measured');

    // src/lib.rs (2 lines) + fuzz_targets/one.rs (1 line) + both Cargo.toml manifests as config.
    expect(alpha.value.production.files).toBe(2);
    expect(alpha.value.config.files).toBe(2);
  });

  it('reads coverage only for the app lanes, and uses the delivered fragment before a local read', async () => {
    const delivered: Measurement<CoverageSummary> = measured(makeCoverageSummary(91));
    const { deps, calls } = makeDeps({
      deliveredCoverage: (lane) => (lane === 'api' ? delivered : null),
    });

    const components = await collectComponents(await specsOf(), deps);

    expect(byName(components, '@x/api').coverage).toBe(delivered);
    expect(calls.coverageReads).toEqual([]);
  });

  it('falls back to a local read when the fragment delivered nothing for the lane', async () => {
    const { deps, calls } = makeDeps();

    const components = await collectComponents(await specsOf(), deps);

    expectState(byName(components, '@x/api').coverage, 'measured');
    expect(calls.coverageReads).toEqual(['api']);
  });

  it('records a failed local coverage read as unavailable with the error, not as zero coverage', async () => {
    const { deps } = makeDeps({
      readCoverage: () => Promise.reject(new Error('lcov.info not found')),
    });

    const components = await collectComponents(await specsOf(), deps);
    const cell = expectState(byName(components, '@x/api').coverage, 'unavailable');

    expect(cell.reasons).toEqual(['lcov.info not found']);
  });

  it('passes a stale delivered fragment through as stale', async () => {
    const staleCell = stale<CoverageSummary>('fragment measured another commit');
    const { deps } = makeDeps({ deliveredCoverage: () => staleCell });

    const components = await collectComponents(await specsOf(), deps);

    expect(byName(components, '@x/api').coverage).toBe(staleCell);
  });

  it('marks coverage unsupported for components without a lane, never as an empty measurement', async () => {
    const { deps } = makeDeps();

    const components = await collectComponents(await specsOf(), deps);

    for (const name of ['mangostudio', 'scripts']) {
      const cell = expectState(byName(components, name).coverage, 'unsupported');
      expect(cell.reasons[0]).toContain('no coverage lane is wired');
    }
  });

  it('says why each kind without a lane has no coverage, so the reason points at the fix', async () => {
    const { deps } = makeDeps();

    const components = await collectComponents(await specsOf(), deps);

    const reasonOf = (name: string): string | undefined =>
      expectState(byName(components, name).coverage, 'unsupported').reasons[0];
    expect(reasonOf('scripts')).toContain('root `bun test scripts` lane runs without --coverage');
    expect(reasonOf('mangostudio')).toContain('scripts/lib/test-lanes.ts');
  });

  it("takes a crate's coverage from the Rust job, per crate, and never from a JS lane", async () => {
    const alpha = measured(makeCoverageSummary(70));
    const { deps, calls } = makeDeps({
      deliveredRustCoverage: (root) =>
        root === 'crates/alpha' ? alpha : unavailable(`${root}: no profile data`),
    });

    const components = await collectComponents(await specsOf(), deps);

    expect(byName(components, 'alpha-crate').coverage).toBe(alpha);
    expect(expectState(byName(components, 'beta').coverage, 'unavailable').reasons).toEqual([
      'crates/beta: no profile data',
    ]);
    expect(calls.coverageReads).toEqual(['api']);
  });

  it('runs the type-check only where a tsconfig is tracked', async () => {
    const { deps, calls } = makeDeps();

    const components = await collectComponents(await specsOf(), deps);

    expect(calls.tsRoots).toEqual(['apps/api', 'scripts']);
    expect(expectState(byName(components, '@x/api').tsErrors, 'measured').value).toBe(2);
    const crate = expectState(byName(components, 'beta').tsErrors, 'unsupported');
    expect(crate.reasons[0]).toContain('crates/beta/tsconfig.json is not tracked');
  });

  it('records a crashed type-check as unavailable rather than zero errors', async () => {
    const { deps } = makeDeps({ countTsErrors: () => Promise.reject(new Error('tsc crashed')) });

    const components = await collectComponents(await specsOf(), deps);

    expect(expectState(byName(components, 'scripts').tsErrors, 'unavailable').reasons).toEqual([
      'tsc crashed',
    ]);
  });

  it('marks a component partial when one of its files is unreadable', async () => {
    const repo = makeFakeRepository({
      ...BASE_REPOSITORY_FILES,
      'packages/cli/src/main.ts': new Error('EACCES'),
    });
    const { deps } = makeDeps({ trackedFiles: repo.trackedFiles, readText: repo.readText });

    const components = await collectComponents(await specsOf(), deps);

    expectState(byName(components, 'mangostudio').loc, 'partial');
    expectState(byName(components, '@x/api').loc, 'measured');
  });
});

describe('coverageLane', () => {
  const spec = (root: string): ComponentSpec => ({
    id: `workspace:${root}`,
    kind: 'workspace',
    name: root,
    root,
    hasTsconfig: false,
  });

  it('maps only apps/<lane> to a lane', () => {
    expect(coverageLane(spec('apps/frontend'))).toBe('frontend');
    expect(coverageLane(spec('apps/api'))).toBe('api');
    expect(coverageLane(spec('apps/shared'))).toBe('shared');
    expect(coverageLane(spec('packages/api'))).toBeNull();
    expect(coverageLane(spec('apps/web'))).toBeNull();
  });
});
