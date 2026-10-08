//! `mangostudio-runtime`'s process entry point.
//!
//! Everything real lives in [`mangostudio_runtime::cli`]: this binary only
//! collects `argv`, the real process environment, and the release stamp,
//! and hands them to it.

use std::env;
use std::process::ExitCode;

use mangostudio_runtime::cli;
use mangostudio_runtime::config::ProcessEnv;

/// The release this binary reports: `--version`, the handshake's peer
/// version, and every health payload.
///
/// `scripts/build.ts` stamps the distribution's release version in at compile
/// time through `MANGOSTUDIO_RELEASE_VERSION`, because a canary or dry-run
/// build carries a version (`0.0.0-dryrun`, `<x>-canary.<sha>`) the committed
/// manifest never does, and the hub refuses a sibling runtime whose release
/// differs from its own. A plain `cargo build` falls back to the manifest
/// version, which `bun run check:versions` keeps in lockstep with the app.
/// This is a compile-time stamp, not host configuration: nothing reads it
/// from the process environment at run time.
const VERSION: &str = match option_env!("MANGOSTUDIO_RELEASE_VERSION") {
    Some(version) => version,
    None => env!("CARGO_PKG_VERSION"),
};

fn main() -> ExitCode {
    let args: Vec<String> = env::args().skip(1).collect();
    let code = cli::run_with_version(&args, &ProcessEnv, VERSION);
    match u8::try_from(code) {
        Ok(code) => ExitCode::from(code),
        Err(_) => ExitCode::FAILURE,
    }
}

// Exercising this binary's behaviour needs `CARGO_BIN_EXE_mangostudio-runtime`,
// which Cargo only populates for an integration test crate (under `tests/`),
// not for a unit test compiled into the binary itself — see `tests/it/cli.rs`.
// `cli::run_with_version`'s dispatch and exit-code logic is unit-tested directly in
// `src/cli.rs`.
