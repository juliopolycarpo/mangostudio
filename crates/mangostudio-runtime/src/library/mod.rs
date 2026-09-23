//! The `library.*` method group: discovery, lockstep hashing and bounded
//! reads of the agent homes on this machine, and — in [`mutation`] — the
//! writes, backups and recovery that change them.
//!
//! Ported from `apps/shared/src/library/machine/` (`discovery.ts`,
//! `instance-reader.ts`, `read.ts`, `settings-sources.ts`, `cache.ts`, and
//! the write engines listed in [`mutation`]), `apps/shared/src/library/hash.ts`,
//! and `apps/runtime/src/services/library/service.ts`. Those TypeScript
//! modules are the parity baseline: `ts_compat_tests` and
//! `mutation::ts_backup_compat_tests` replay a corpus the real TypeScript
//! code produced (`apps/runtime/scripts/generate-library-fixtures.ts`).
//!
//! # Method inventory
//!
//! | Method | Consent | Implemented in |
//! | --- | --- | --- |
//! | `library.locations` | library | `service` |
//! | `library.settings-sources` | library | `service` |
//! | `library.scan` | library | `service` |
//! | `library.read` | library | `service` |
//! | `library.read-tree` | library | `service` |
//! | `library.apply` | library + fsWrite | `mutation` |
//! | `library.remove` | library + fsWrite | `mutation` |
//! | `library.undo` (restore) | library + fsWrite | `mutation` |
//! | `library.backups` | library | `mutation` — read-only, never prunes |
//! | `library.gc` | library + fsWrite | `mutation` — the explicit purge |
//!
//! With all ten registered, [`crate::manifest::build_features`] advertises
//! `features.library` exactly when consent grants `library` — the
//! `readonly` preset included, where the writes answer consent denials and
//! `library.backups` still lists — and the hub routes its library service
//! here.
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
mod mutation;
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
