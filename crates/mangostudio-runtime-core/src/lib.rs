//! The shared layer of the MangoStudio runtime host.
//!
//! `mangostudio-runtime` is one binary built from three crates, split by how the release profile
//! treats them (see the root `Cargo.toml` and `docs/reference/runtime-metrics.md`):
//!
//! - this crate holds what every request path builds on, so it keeps `opt-level = 3`: the method
//!   [`registry`] and its [`ports`], [`consent`], the [`runtime_home`] layout and its locks, the
//!   bounded [`subprocess`] runner and the [`blocking`] pool they share;
//! - `mangostudio-runtime-cold` holds the code a request mostly waits in (the MCP client, the
//!   external-agent host, machine probing, the toolchain commands) and builds with
//!   `opt-level = "s"`;
//! - `mangostudio-runtime` keeps `fs.grep`, the transport, the PTY and the CLI at `opt-level = 3`,
//!   re-exports the modules of the other two under their old paths, and owns the binary.
//!
//! A module lives here instead of in the binary crate when a cold module needs it: the cold crate
//! cannot depend on the binary crate, so anything the two share has to sit below both. Every
//! module that crosses the crate boundary is `pub` but `#[doc(hidden)]` unless it was public
//! before the split; the supported surface is `mangostudio_runtime`'s re-exports.
//!
//! Module docs that name `apps/runtime/...` name the TypeScript source a module was ported
//! from; it is in git history.

// Panic isolation (`panic.rs`, `abandoned_call.rs`, and
// `mango_protocol::session::dispatch`'s own `JoinSet`) recovers a handler's
// panic by catching its unwind. Under `panic = "abort"` there is no unwind to
// catch: one panicking request would kill the process and every session in
// it. The workspace release profile pins `panic = "unwind"`; this refuses to
// build the crate if any profile or `-C panic` flag ever overrides that.
#[cfg(panic = "abort")]
compile_error!(
    "mangostudio-runtime-core requires panic = \"unwind\": handler panic isolation catches unwinds, \
     and panic = \"abort\" would turn one panicking request into a process exit"
);

#[doc(hidden)]
pub mod abandoned_call;
pub mod blocking;
#[doc(hidden)]
pub mod canonical;
pub mod config;
pub mod consent;
#[doc(hidden)]
pub mod diagnostics;
pub mod discovery;
pub mod event_check;
#[doc(hidden)]
pub mod executable_path;
#[doc(hidden)]
pub mod file_identity;
#[doc(hidden)]
pub mod hex;
#[doc(hidden)]
pub mod json_size;
#[doc(hidden)]
pub mod lossy_utf8;
pub mod manifest;
pub mod panic;
#[doc(hidden)]
pub mod platform;
pub mod ports;
#[doc(hidden)]
pub mod probe_cache;
pub mod registry;
#[doc(hidden)]
pub mod release;
#[doc(hidden)]
pub mod result_value;
pub mod runtime_home;
pub mod serve;
pub mod setup;
pub mod slot_publish;
#[doc(hidden)]
pub mod slot_update_lock;
pub mod subprocess;
// One scratch-directory helper shared by the three crates' unit tests; the file has no
// `crate::` imports on purpose, so each crate compiles its own copy (see its module docs).
#[cfg(test)]
#[path = "../../mangostudio-runtime/src/test_support.rs"]
pub(crate) mod test_support;
#[doc(hidden)]
pub mod tool_argument;
#[doc(hidden)]
pub mod verbatim_path;
