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
 */
const CONTRACT_SOURCE_PATTERNS = [
  /^apps\/shared\/src\/.*\.ts$/,
  /^scripts\/runtime-contract\//,
] as const;

/** True when scoped changes can move what the emitted contract artifacts contain. */
export function touchesContractArtifactSurface(files: string[]): boolean {
  return files.some((file) => {
    const path = file.replaceAll('\\', '/');
    return CONTRACT_SOURCE_PATTERNS.some((pattern) => pattern.test(path));
  });
}
