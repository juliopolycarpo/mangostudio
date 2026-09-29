// Attaches the per-component measurements (static LoC, coverage, TypeScript
// errors) to the discovered registry. Every measurement is explicit: a metric a
// component has no collector for is `unsupported`, never a missing key or a zero.

import { ALL_WORKSPACE_NAMES, type WorkspaceName } from '../../lib/config';
import type { Component, CoverageSummary } from '../model/metrics';
import { type Measurement, unsupported } from '../model/states';
import { measureComponentLoc } from './loc';
import { type ComponentSpec, ownerOf } from './registry';
import { measure } from './support';

export interface ComponentDeps {
  readonly trackedFiles: readonly string[];
  readonly readText: (path: string) => Promise<string>;
  /** Coverage the Test job delivered for a workspace lane, or null when it delivered none. */
  readonly deliveredCoverage: (workspace: WorkspaceName) => Measurement<CoverageSummary> | null;
  /** Local fallback when no fragment delivered a lane's coverage. */
  readonly readCoverage: (workspace: WorkspaceName) => Promise<CoverageSummary>;
  /** Number of TypeScript errors for the tsconfig under `root`. */
  readonly countTsErrors: (root: string) => Promise<number>;
}

/** The JS app lane a component is, or null: only `apps/<lane>` has an LCOV lane today. */
export const coverageLane = (spec: ComponentSpec): WorkspaceName | null =>
  ALL_WORKSPACE_NAMES.find((lane) => spec.root === `apps/${lane}`) ?? null;

const coverageOf = (
  spec: ComponentSpec,
  deps: ComponentDeps
): Promise<Measurement<CoverageSummary>> => {
  const lane = coverageLane(spec);
  if (lane === null) {
    return Promise.resolve(unsupported(`no coverage lane is wired for ${spec.kind} ${spec.name}`));
  }
  const delivered = deps.deliveredCoverage(lane);
  if (delivered) return Promise.resolve(delivered);
  return measure(`coverage:${lane}`, () => deps.readCoverage(lane));
};

const tsErrorsOf = (spec: ComponentSpec, deps: ComponentDeps): Promise<Measurement<number>> => {
  if (!spec.hasTsconfig) {
    return Promise.resolve(
      unsupported(`${spec.root}/tsconfig.json is not tracked; no type-check is defined`)
    );
  }
  return measure(`ts:${spec.name}`, () => deps.countTsErrors(spec.root));
};

/**
 * Measure every discovered component. Files are assigned by longest root, so a
 * nested root is counted once, under the component that owns it.
 * // Usage: const components = await collectComponents(specs, deps);
 */
export const collectComponents = async (
  specs: readonly ComponentSpec[],
  deps: ComponentDeps
): Promise<Component[]> => {
  const filesByComponent = new Map<string, string[]>(specs.map((spec) => [spec.id, []]));
  for (const path of deps.trackedFiles) {
    const owner = ownerOf(specs, path);
    if (owner) filesByComponent.get(owner.id)?.push(path);
  }

  const components: Component[] = [];
  for (const spec of specs) {
    components.push({
      id: spec.id,
      kind: spec.kind,
      name: spec.name,
      root: spec.root,
      loc: await measureComponentLoc(filesByComponent.get(spec.id) ?? [], deps.readText),
      coverage: await coverageOf(spec, deps),
      tsErrors: await tsErrorsOf(spec, deps),
    });
  }
  return components;
};
