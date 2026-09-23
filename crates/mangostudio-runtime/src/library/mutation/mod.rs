//! The write half of the `library.*` method group — `library.apply`,
//! `library.remove`, `library.undo`, `library.backups` and `library.gc` —
//! ported from `apps/shared/src/library/machine/` (`apply-writes.ts`,
//! `remove-writes.ts`, `undo-writes.ts`, `resource-writer.ts`,
//! `backup-store.ts`, `tree-removal.ts`, `atomic-write.ts`,
//! `path-safety.ts`, `write-queue.ts`, `cancellation.ts`) and the write
//! handlers of `apps/runtime/src/services/library/service.ts`.
//!
//! Restore is `library.undo`; there is no other restore method. The backup
//! store's on-disk layout and manifest format are shared with the
//! TypeScript runtime in both directions (see [`backup_store`]); the
//! ownership and cancellation rules are in [`service`].

mod apply;
mod backup_store;
mod disk;
#[cfg(test)]
mod fakes;
mod hashing;
mod interrupt;
mod paths;
mod removal;
mod service;
#[cfg(test)]
mod ts_backup_compat_tests;
mod undo;
mod writer;

pub(crate) use service::{MutationService, register};
