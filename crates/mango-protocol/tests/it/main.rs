//! The protocol crate's integration tests, linked as one test binary.
//!
//! Every file under `tests/*.rs` is its own test binary, and each one links this crate with the
//! `tokio`, `websocket`, `spawn` and `testing` feature trees it uses. None of the suites below
//! needs a process of its own (no environment, signal, or process-global state; the transports
//! bind ephemeral ports and name their sockets by process id and a counter), so they are modules
//! of this one binary and the crate links once. Each module keeps the name of the file it used to
//! be, so `cargo test --test it properties` runs what `cargo test --test properties` did.
//!
//! Each module gates itself with its own inner `#![cfg(feature = ...)]`, exactly as its file did
//! when it was a target, so a feature subset still compiles and runs only what it selects.
//!
//! A new test file joins here; the module list below is the whole registry, and `layout` fails
//! when a file under `it/` is not declared in it. Declare each module on its own bare `mod name;`
//! line (no `pub`, no attribute on the same line), because `layout` reads exactly that shape; a
//! `cfg` gate belongs in the module file as an inner `#![cfg(...)]`.

// The fakes implement the `tokio` feature's `Port` trait; every module that uses them is gated on
// that feature (or one that implies it), so a build without it must not compile them either.
#[cfg(feature = "tokio")]
mod support;

mod conformance;
mod conformance_drift;
mod contract;
mod fixtures;
mod fixtures_legacy_hello;
mod fixtures_ssh_argv;
mod layout;
mod properties;
mod session;
mod transport_ipc;
mod transport_ndjson;
mod transport_spawn;
mod transport_websocket;
mod transport_websocket_backpressure;
