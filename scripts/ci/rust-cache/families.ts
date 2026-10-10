// Exact names produced by the pinned rust-cache action, not prefix matches.
// Its `shared-key` wins over `key` + GITHUB_JOB. The environment hash also
// separates toolchains, target flags and release-profile overrides.
export const RUST_CACHE_FAMILIES = [
  'workspace',
  'launcher-msrv',
  'musl-clippy',
  'runtime-home-fixture-freshness',
  'local-runtime',
  'rust-coverage',
  'rust',
  'interop',
  'semver-checks',
  'schema-equality',
  'fresh-dependencies-fresh',
  'runtime-build-linux-x64',
  'runtime-build-linux-arm64',
  'runtime-build-linux-x64-musl',
  'runtime-build-linux-arm64-musl',
  'runtime-build-darwin-x64',
  'runtime-build-darwin-arm64',
  'runtime-build-windows-x64',
  'runtime-build-windows-arm64',
] as const;

// Entrypoints that can save the families above, directly or through a reusable
// workflow/composite. The policy test traces those calls and rejects omissions.
// Including conservative callers that turn caching off is harmless: their
// completion also triggers cleanup, so it cannot strand a deferred sweep.
export const RUST_CACHE_WRITERS = [
  { path: '.github/workflows/ci.yml', name: 'CI' },
  { path: '.github/workflows/cargo-shim.yml', name: 'Cargo Shim' },
  { path: '.github/workflows/protocol-ci.yml', name: 'Protocol CI' },
  { path: '.github/workflows/rust-fresh-dependencies.yml', name: 'Rust fresh dependencies' },
  { path: '.github/workflows/randomized-order-nightly.yml', name: 'Randomized Order Nightly' },
  { path: '.github/workflows/browser-smoke.yml', name: 'Smoke — Browser' },
  { path: '.github/workflows/smoke-binary.yml', name: 'Smoke — Binary' },
  { path: '.github/workflows/release.yml', name: 'Release' },
  { path: '.github/workflows/release-dry-run.yml', name: 'Release Dry Run' },
] as const;

export const MAIN_CACHE_REF = 'refs/heads/main';
export const MAIN_WRITER_EVENTS = ['push', 'schedule', 'workflow_dispatch'] as const;
