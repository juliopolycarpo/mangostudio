//! The cold half of the MangoStudio runtime host: the code a request mostly waits in.
//!
//! The release profile builds this crate with `opt-level = "s"` (root `Cargo.toml`, next to the
//! per-dependency overrides), which takes about a third out of the code it holds and costs the
//! hot paths nothing: none of `fs.grep`, the relay, the PTY or the protocol framing runs here.
//! `docs/reference/runtime-metrics.md` has the measurements and the reasoning for the split.
//!
//! - [`mcp`]: the MCP client, over stdio and over HTTP.
//! - `external_agents`: hosting the vendor agent CLIs through the external-agent SDK.
//! - [`probing`]: what is installed on this machine and where.
//! - [`commands`]: the toolchain, environment and service commands built on probing.
//! - `login`: the sign-in commands and verified Cursor aliases.
//!
//! The crate builds on `mangostudio-runtime-core` and is linked, with the hot half, into the one
//! `mangostudio-runtime` binary, which re-exports these modules under their old paths. Modules
//! that cross the crate boundary are `pub` and `#[doc(hidden)]` unless they were public before
//! the split.

// The doc comments of the modules below keep their pre-split links to private items; those
// resolve under `--document-private-items` and describe internals, so they stay links.
#![allow(rustdoc::private_intra_doc_links)]

#[cfg(panic = "abort")]
compile_error!(
    "mangostudio-runtime-cold requires panic = \"unwind\": handler panic isolation catches \
     unwinds, and panic = \"abort\" would turn one panicking request into a process exit"
);

pub mod commands;
#[doc(hidden)]
pub mod external_agents;
#[doc(hidden)]
pub mod login;
pub mod mcp;
pub mod probing;
// One scratch-directory helper shared by the three crates' unit tests; the file has no
// `crate::` imports on purpose, so each crate compiles its own copy (see its module docs).
#[cfg(test)]
#[path = "../../mangostudio-runtime/src/test_support.rs"]
pub(crate) mod test_support;
