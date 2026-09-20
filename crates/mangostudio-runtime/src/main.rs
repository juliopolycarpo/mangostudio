//! `mangostudio-runtime`: deliberately thin for now.
//!
//! Real transports and argument parsing are a later change — this binary
//! answers only `--version` and `--help`, so the release pipeline has
//! something to build and ship alongside `mangostudio` before the dispatcher
//! this crate's library half provides is wired to an actual transport.

use std::env;
use std::process::ExitCode;

const VERSION: &str = env!("CARGO_PKG_VERSION");

fn main() -> ExitCode {
    let mut args = env::args().skip(1);
    match args.next().as_deref() {
        Some("--version" | "-v") => {
            println!("mangostudio-runtime {VERSION}");
            ExitCode::SUCCESS
        }
        Some("--help" | "-h") => {
            print_help();
            ExitCode::SUCCESS
        }
        Some(other) => {
            eprintln!("mangostudio-runtime: unrecognised argument \"{other}\"");
            eprintln!();
            print_help();
            ExitCode::FAILURE
        }
        None => {
            print_help();
            ExitCode::SUCCESS
        }
    }
}

fn print_help() {
    println!(
        "mangostudio-runtime {VERSION}\n\
         \n\
         Usage: mangostudio-runtime [--version | --help]\n\
         \n\
         This build serves no transport yet: real argument parsing and\n\
         transports land in a later change.\n\
         \n\
         Options:\n\
         \x20\x20-v, --version  Print the version and exit\n\
         \x20\x20-h, --help     Print this message and exit"
    );
}

// Exercising this binary's behaviour needs `CARGO_BIN_EXE_mangostudio-runtime`,
// which Cargo only populates for an integration test crate (under `tests/`),
// not for a unit test compiled into the binary itself — see
// `tests/cli.rs`.
