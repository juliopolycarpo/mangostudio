//! The runtime's integration tests, linked as one test binary.
//!
//! Every file under `tests/*.rs` is its own test binary, and each one links the whole runtime
//! library and its dependency tree. The suites below need nothing a shared process would spoil, so
//! they are modules of this one binary: the library links once, and `support`'s fakes compile
//! once. Each module keeps the name of the file it used to be, so `cargo test --test it consent`
//! runs what `cargo test --test consent` did.
//!
//! What stays a separate `tests/*.rs` target, and why:
//!
//! - `subprocess_guardian.rs`, `subprocess_windows.rs`: each test re-executes its own test binary
//!   with `--exact <test name>` as the fixture child, so the binary's test names are part of the
//!   fixture, and each one kills or reaps processes whose lifetime is the point.
//! - `transport_stdio_console_close.rs`: attaches a pseudoconsole and delivers console control
//!   events, which act on process-wide console state.
//! - `generate_rust_fixture.rs`: `#[ignore]`d fixture generator that the fixture-freshness CI lane
//!   runs by target name; it should not build the suites below.
//! - `config_boundary.rs`, `spawn_boundary.rs`, `release_stamp_boundary.rs`: read the crate's
//!   `src/` tree and touch no process state, so they could join, but they link nothing beyond
//!   `std` and a fast standalone target costs less than it saves.
//!
//! A new test file joins here unless it needs one of those properties; the module list below is
//! the whole registry, so a file added under `it/` without a `mod` line is never compiled, and the
//! `layout` test fails for it. Declare each module on its own bare `mod name;` line (no `pub`, no
//! attribute on the same line), because `layout` reads exactly that shape; a `cfg` gate belongs in
//! the module file as an inner `#![cfg(...)]`.

#[path = "../support/mod.rs"]
mod support;

mod audit_isolation;
mod cli;
mod consent;
mod consent_ts_compat;
mod dispatch;
mod injected_version;
mod layout;
mod library_stdio;
mod mcp_stdio_ownership;
mod mcp_stdio_shutdown;
mod panic_isolation;
mod transport_connect;
mod transport_serve;
mod transport_stdio_spawned;
mod ts_compat;
mod update_exclusivity;
mod update_supervised_restart;
