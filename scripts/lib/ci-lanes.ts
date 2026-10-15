// Preserve each workflow's current policy over literal filenames. Distribution
// uses an irrelevant-path allowlist; release and launcher remain narrow.
import { validateChangedPaths } from './changed-paths';

const DISTRIBUTION_IRRELEVANT_PATTERN =
  /^(docs\/|\.github\/ISSUE_TEMPLATE\/|\.github\/(CODE_OF_CONDUCT|CONTRIBUTING|SECURITY|pull_request_template)\.md$|[^/]*\.md$|LICENSE$)/;

export const RELEASE_PATTERN =
  /^(\.github\/workflows\/release[^/]*\.yml$|\.github\/workflows\/canary\.yml$|\.github\/workflows\/runtime-build\.yml$|scripts\/release\/|scripts\/install\/|scripts\/tests\/install-ps1-layout\.unit\.test\.ts$|scripts\/tests\/support\/windows-user-path\.ts$|scripts\/build(-runtime)?\.ts$|scripts\/lib\/|scripts\/ci\/dry-run-artifacts\.ts$|\.github\/actions\/download-distribution\/|packages\/cli\/|crates\/(mangostudio-launcher|mangostudio-runtime|mangostudio-runtime-contract|mango-protocol)\/|Cargo\.(toml|lock)$|rust-toolchain\.toml$|\.cargo\/config\.toml$|\.github\/actions\/setup-zigbuild\/|Dockerfile$)/;

export const LAUNCHER_PATTERN =
  /^(crates\/mangostudio-launcher\/|Cargo\.(toml|lock)$|rust-toolchain\.toml$|\.github\/workflows\/release(-dry-run)?\.yml$|scripts\/release\/verify-launcher-package\.sh$)/;

/**
 * Unknown paths select distribution, as they did in CI's shell allowlist.
 * @example
 * distributionRelevant(['docs/guide.md']); // false
 */
export function distributionRelevant(paths: readonly string[]): boolean {
  validateChangedPaths(paths);
  return paths.some((path) => !DISTRIBUTION_IRRELEVANT_PATTERN.test(path));
}

/**
 * Independent release/archive and launcher-package relevance.
 * @example
 * releaseRelevance(['Cargo.toml']); // { release: true, launcher: true }
 */
export function releaseRelevance(paths: readonly string[]): {
  release: boolean;
  launcher: boolean;
} {
  validateChangedPaths(paths);
  return {
    release: paths.some(
      (path) => RELEASE_PATTERN.test(path) || path === 'scripts/ci/changed-paths.ts'
    ),
    launcher: paths.some(
      (path) =>
        LAUNCHER_PATTERN.test(path) ||
        path === 'scripts/ci/changed-paths.ts' ||
        path === 'scripts/lib/changed-paths.ts' ||
        path === 'scripts/lib/ci-lanes.ts'
    ),
  };
}
