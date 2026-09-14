// Change-scoping rule for the generated runtime-contract artifact gate.

/**
 * Files whose contents are emitted into the artifacts, plus the artifacts
 * themselves and the emitter.
 *
 * Wider than it looks necessary on purpose. The contract's method schemas reach
 * into most of `apps/shared/src` — a library shape, an MCP descriptor, an
 * environment status are all reachable from a method's params — so narrowing
 * this to `runtime-contract/` would let an edit two modules away go out with a
 * stale catalog and turn the gate red only on somebody else's full run.
 *
 * The generated directory is named separately because the artifacts are `.json`
 * and the first pattern only covers TypeScript: a hand-edited catalog is the
 * other case the gate exists for, and it has to be caught on the scoped run
 * that is about to commit it.
 *
 * Manifests and the lockfile are here because none of the bytes are written by
 * this repository: `typebox` decides how a schema serializes and
 * `@mangostudio/protocol` decides how `buildCatalog` lays the document out, so
 * bumping either moves `catalog.json` without touching a single `.ts` file.
 * That is the same edit the `@mangostudio/protocol` entry in
 * `COHORT_DEPENDENCIES` exists to keep on one version.
 */
const CONTRACT_SOURCE_PATTERNS = [
  /^apps\/shared\/src\/.*\.ts$/,
  /^apps\/shared\/src\/runtime-contract\/generated\//,
  /^scripts\/runtime-contract\//,
  /^(?:.*\/)?package\.json$/,
  /^bun\.lock$/,
] as const;

/** True when scoped changes can move what the emitted contract artifacts contain. */
export function touchesContractArtifactSurface(files: string[]): boolean {
  return files.some((file) => {
    const path = file.replaceAll('\\', '/');
    return CONTRACT_SOURCE_PATTERNS.some((pattern) => pattern.test(path));
  });
}
