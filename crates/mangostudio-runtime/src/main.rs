//! `mangostudio-runtime`'s process entry point.
//!
//! Everything real lives in [`mangostudio_runtime::cli`]: this binary only
//! collects `argv` and the real process environment, and hands both to it.

use std::env;
use std::process::ExitCode;

use mangostudio_runtime::cli;
use mangostudio_runtime::config::ProcessEnv;

fn main() -> ExitCode {
    let args: Vec<String> = env::args().skip(1).collect();
    let code = cli::run(&args, &ProcessEnv);
    match u8::try_from(code) {
        Ok(code) => ExitCode::from(code),
        Err(_) => ExitCode::FAILURE,
    }
}

// Exercising this binary's behaviour needs `CARGO_BIN_EXE_mangostudio-runtime`,
// which Cargo only populates for an integration test crate (under `tests/`),
// not for a unit test compiled into the binary itself — see `tests/cli.rs`.
// `cli::run`'s own dispatch and exit-code logic is unit-tested directly in
// `src/cli.rs`.
