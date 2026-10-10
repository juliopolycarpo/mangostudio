//! The runtime's CLI entry point with a release version chosen at run time.
//!
//! The shipped binary is stamped at compile time (`src/main.rs`), and no CI lane stamps the Rust
//! tests, so a test of the real binary compares the package version with itself and cannot tell a
//! site that reports the injected version from one that reports `CARGO_PKG_VERSION`. This
//! stand-in hands `cli::run_with_version` the version named by
//! `MANGOSTUDIO_TEST_INJECTED_VERSION` instead, a value no manifest carries, so every site that
//! reports a release shows up with the version it was given. `tests/it/injected_version.rs` drives
//! it through `--version`, `health`, `doctor`, `setup`, `install`, `stdio`, `serve` and `connect`.
//!
//! It is a test fixture, never shipped: it is a binary target behind the
//! `injected-version-fixture` feature, so cargo builds it for integration tests (and exports its
//! path to them as `CARGO_BIN_EXE_injected-version-runtime`) only when that feature is on, which
//! every `--all-features` lane does, and a release build never is. The stamp stays a compile-time
//! value in `src/main.rs`.
//!
//! ```text
//! $ MANGOSTUDIO_TEST_INJECTED_VERSION=9.8.7-injected injected-version-runtime --version
//! 9.8.7-injected
//! ```

use std::process::ExitCode;

use mangostudio_runtime::cli;
use mangostudio_runtime::config::ProcessEnv;

/// The variable naming the version this process reports.
const INJECTED_VERSION_VARIABLE: &str = "MANGOSTUDIO_TEST_INJECTED_VERSION";

fn main() -> ExitCode {
    let Ok(version) = std::env::var(INJECTED_VERSION_VARIABLE) else {
        eprintln!(
            "injected_version_runtime: expected {INJECTED_VERSION_VARIABLE} set to the version to \
             report | received: unset"
        );
        return ExitCode::from(2);
    };
    let args: Vec<String> = std::env::args().skip(1).collect();
    let code = cli::run_with_version(&args, &ProcessEnv, &version);
    u8::try_from(code).map_or(ExitCode::FAILURE, ExitCode::from)
}
