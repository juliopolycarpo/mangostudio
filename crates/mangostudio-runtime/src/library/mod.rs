//! The read half of the `library.*` method group: discovery, lockstep
//! hashing, and bounded reads of the agent homes on this machine.
//!
//! Ported from `apps/shared/src/library/machine/` (`discovery.ts`,
//! `instance-reader.ts`, `read.ts`, `settings-sources.ts`, `cache.ts`),
//! `apps/shared/src/library/hash.ts`, and the read handlers of
//! `apps/runtime/src/services/library/service.ts`. Those TypeScript modules
//! are the parity baseline: `ts_compat_tests` replays a corpus the real
//! TypeScript code produced (`apps/runtime/scripts/generate-library-fixtures.ts`).
//!
//! # Method inventory
//!
//! | Method | Implemented here |
//! | --- | --- |
//! | `library.locations` | yes |
//! | `library.settings-sources` | yes |
//! | `library.scan` | yes |
//! | `library.read` | yes |
//! | `library.read-tree` | yes |
//! | `library.apply` | no — the mutation/backup lane |
//! | `library.remove` | no — the mutation/backup lane |
//! | `library.undo` | no — the mutation/backup lane |
//! | `library.backups` | no — read-only, but it belongs with the backup store's fixtures |
//! | `library.gc` | no — the mutation/backup lane |
//!
//! Because five of the ten methods carrying the `library` capability are
//! unregistered, [`crate::manifest::build_features`] keeps
//! `features.library` false: the hub gates every library surface on that
//! one boolean, and advertising it now would send writes to a runtime that
//! answers them with "not implemented". The five reads are still callable
//! directly (consent permitting); the hub simply does not route to them yet.
//!
//! # Where paths come from
//!
//! This runtime resolves its own location roots. Every handler builds its
//! [`crate::probing::detection::path_env::PathEnv`] through the one seam
//! [`crate::probing::host::build_runtime_path_env`] that `probing.*` also
//! uses: this process's environment and home directory, with the request's
//! `pathEnv.env` merged on top. The hub pins its configured MangoStudio
//! directories there only when the runtime is on the hub's own machine; a
//! remote runtime receives no pins and resolves everything from its own
//! environment, so it never inherits the hub's `SKILLS_DIR`, `AGENTS_DIR`
//! or config homes. The home directory itself is never overridable.
//!
//! # Diagnostics
//!
//! Nameable-but-broken entries are invalid instances with a stable reason,
//! unnameable ones are `unreadableEntries` rows, and malformed arguments are
//! `tool_argument` errors. One case is inherited from the baseline as is: a
//! location directory that exists but cannot be listed (permission denied,
//! or a file where a directory belongs) contributes no rows and writes a
//! diagnostic line to stderr, because the contract has no location-level
//! slot to report it in. Changing that is a contract decision, not a port.

mod cache;
mod collation;
mod describe;
mod discovery;
mod frontmatter;
mod fs;
mod hash;
mod js;
mod names;
mod read;
mod reader;
mod service;
#[cfg(test)]
mod service_tests;
mod settings_sources;
mod tree;
#[cfg(test)]
mod ts_compat_tests;
mod types;
mod workers;

pub(crate) use service::register;
