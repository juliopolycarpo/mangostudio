// Relevance policies over literal repository paths.
import { validateChangedPaths } from './changed-paths';

const DISTRIBUTION_IRRELEVANT_PATTERN =
  /^(docs\/|\.github\/ISSUE_TEMPLATE\/|\.github\/(CODE_OF_CONDUCT|CONTRIBUTING|SECURITY|pull_request_template)\.md$|[^/]*\.md$|LICENSE$)/;

const STANDALONE_ROOT_TEST = /^scripts\/tests\/[a-z0-9_-]+\.unit\.test\.ts$/;
const RELEASE_SENSITIVE_ROOT_TESTS = new Set([
  'scripts/tests/install-ps1-layout.unit.test.ts',
  'scripts/tests/verify-release-tag.unit.test.ts',
]);

export const RELEASE_PATTERN =
  /^(\.github\/workflows\/release[^/]*\.yml$|\.github\/workflows\/canary\.yml$|\.github\/workflows\/runtime-build\.yml$|scripts\/release\/|scripts\/install\/|scripts\/tests\/install-ps1-layout\.unit\.test\.ts$|scripts\/tests\/support\/windows-user-path\.ts$|scripts\/build(-runtime)?\.ts$|scripts\/lib\/|scripts\/ci\/dry-run-artifacts\.ts$|\.github\/actions\/download-distribution\/|packages\/cli\/|crates\/(mangostudio-launcher|mangostudio-runtime|mangostudio-runtime-contract|mango-protocol)\/|Cargo\.(toml|lock)$|rust-toolchain\.toml$|\.cargo\/config\.toml$|\.github\/actions\/setup-zigbuild\/|Dockerfile$)/;

export const LAUNCHER_PATTERN =
  /^(crates\/mangostudio-launcher\/|Cargo\.(toml|lock)$|rust-toolchain\.toml$|\.github\/workflows\/release(-dry-run)?\.yml$|scripts\/release\/verify-launcher-package\.sh$)/;

/**
 * Skip distribution for a documentation-only or standalone root-test-only diff.
 * @example
 * distributionRelevant(['docs/guide.md']); // false
 */
export function distributionRelevant(paths: readonly string[]): boolean {
  validateChangedPaths(paths);
  return (
    !paths.every((path) => DISTRIBUTION_IRRELEVANT_PATTERN.test(path)) &&
    !paths.every(
      (path) => STANDALONE_ROOT_TEST.test(path) && !RELEASE_SENSITIVE_ROOT_TESTS.has(path)
    )
  );
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
      (path) =>
        RELEASE_PATTERN.test(path) ||
        path === 'scripts/ci/changed-paths.ts' ||
        path === 'tsconfig.json' ||
        path === 'tsconfig.native-build.json'
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

// CodeQL's Rust extraction reads Rust sources and the manifests that select
// them. The workflow, its config and this classifier are included so a change
// to the gate itself is analyzed by every leg it controls.
const CODEQL_RUST_PATTERN =
  /^(crates\/|Cargo\.(toml|lock)$|rust-toolchain\.toml$|\.cargo\/|\.github\/workflows\/codeql\.yml$|\.github\/codeql\/|scripts\/lib\/(ci-lanes|changed-paths)\.ts$|scripts\/ci\/changed-paths\.ts$)|\.rs$/;

/**
 * Whether a pull request diff can change what the CodeQL Rust legs report.
 * @example
 * codeqlRustRelevant(['apps/api/src/index.ts']); // false
 */
export function codeqlRustRelevant(paths: readonly string[]): boolean {
  validateChangedPaths(paths);
  return paths.some((path) => CODEQL_RUST_PATTERN.test(path));
}
