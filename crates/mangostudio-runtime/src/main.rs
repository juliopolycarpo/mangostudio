//! `mangostudio-runtime`'s process entry point.
//!
//! Everything real lives in [`mangostudio_runtime::cli`]: this binary only
//! collects `argv`, the real process environment, and the release stamp,
//! and hands them to it.

use std::env;
use std::process::ExitCode;

use mangostudio_runtime::cli;
use mangostudio_runtime::config::ProcessEnv;
use mangostudio_runtime::release_stamp::{self, MAGIC_LEN, SLOT_LEN};

/// The marker `scripts/lib/runtime-stamp.ts` searches the linked binary for. Random bytes, so
/// no other data collides with it; the patcher requires exactly one copy. It occurs only in
/// [`RELEASE_STAMP`]'s initializer: nothing compares against it, because a comparison would
/// leave a second copy in the machine code. `scripts/tests/runtime-stamp-layout.unit.test.ts`
/// pins this line to the patcher's copy.
const STAMP_MAGIC: [u8; MAGIC_LEN] = [
    0x1a, 0x42, 0x4a, 0x48, 0x2a, 0x3c, 0x9b, 0xff, 0xa0, 0x2d, 0xe3, 0xfe, 0x39, 0x92, 0x88, 0x81,
];

/// The slot a distribution's release version is written into after the link: the magic, a zero
/// length byte (unstamped) and a zeroed value field.
///
/// The release version is not a compile input. A canary or dry-run build carries a version
/// (`0.0.0-dryrun`, `<x>-canary.<sha>`) the committed manifest never does, and the hub refuses a
/// sibling runtime whose release differs from its own, so `scripts/build-runtime.ts` and
/// `scripts/build.ts` stamp the linked binary through `scripts/lib/runtime-stamp.ts`. Two commits
/// with equal Rust inputs therefore compile to the same bytes. A plain `cargo build` leaves the
/// slot empty and reports the manifest version, which `bun run check:versions` keeps in lockstep
/// with the app.
///
/// `#[used]` keeps the item through the compiler; [`main`] reads it through `black_box` so the
/// optimizer, fat LTO included, cannot fold the zero length it sees at compile time.
#[used]
static RELEASE_STAMP: [u8; SLOT_LEN] = unstamped_slot();

/// [`RELEASE_STAMP`]'s initial contents: [`STAMP_MAGIC`] followed by zeros.
const fn unstamped_slot() -> [u8; SLOT_LEN] {
    let mut slot = [0u8; SLOT_LEN];
    let mut index = 0;
    while index < MAGIC_LEN {
        slot[index] = STAMP_MAGIC[index];
        index += 1;
    }
    slot
}

fn main() -> ExitCode {
    // `black_box` hides that the slot is a constant, so the read happens at run time.
    let slot = std::hint::black_box(&RELEASE_STAMP);
    let version = match release_stamp::release_version(slot, env!("CARGO_PKG_VERSION")) {
        Ok(version) => version,
        Err(error) => {
            eprintln!("mangostudio-runtime: {error}");
            return ExitCode::FAILURE;
        }
    };
    let args: Vec<String> = env::args().skip(1).collect();
    let code = cli::run_with_version(&args, &ProcessEnv, version);
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
