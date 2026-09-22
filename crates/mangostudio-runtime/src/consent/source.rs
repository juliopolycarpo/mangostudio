//! Re-reading `runtime.json`'s `allow` set on every authorization check.
//!
//! Uses the TypeScript host's allow resolution, but deliberately rereads
//! authority rather than trusting an unchanged metadata fingerprint.
//!
//! # The security property this module exists for
//!
//! A config file that **was** readable and **becomes** unreadable —
//! permissions tightened out from under this process, a directory dropped
//! in its place, disk corruption — must never be read as "unchanged, keep
//! the last grant" and must never fall back to `full`. It downgrades to
//! `none`, the same as a file that was never readable at all. Revocation is
//! the fail-closed direction: an owner who tightens a file's permissions to
//! take capabilities away must never end up with a runtime that kept
//! serving the old, wider grant because the read happened to fail instead
//! of returning `none` on disk.

use std::path::PathBuf;

use mangostudio_runtime_contract::manifest::{ManifestProfile, capability_keys};
use serde_json::Value;

use crate::consent::presets::{ResolvedCapabilityAllow, consent_preset, default_consent_for_slot};
use crate::runtime_home::{RuntimeSlot, read_runtime_slot_config};

/// Reads the current consent for one slot without caching authority.
/// Metadata and file identity can remain unchanged across a revocation.
///
/// # Example
///
/// ```
/// use mangostudio_runtime::consent::source::ConsentSource;
/// use mangostudio_runtime::runtime_home::RuntimeSlot;
///
/// let home = std::env::temp_dir().join("mango-consent-source-doctest");
/// let source = ConsentSource::new(RuntimeSlot::Host, home);
/// // No file on disk yet: `host` starts fully consented.
/// assert!(source.refresh().shell);
/// ```
pub struct ConsentSource {
    slot: RuntimeSlot,
    mango_home: PathBuf,
}

impl ConsentSource {
    /// Builds a source for `slot`'s `runtime.json` under `mango_home`. Reads
    /// nothing until [`ConsentSource::refresh`] is first called.
    #[must_use]
    pub fn new(slot: RuntimeSlot, mango_home: PathBuf) -> Self {
        Self { slot, mango_home }
    }

    /// This source's slot, for a caller (a consent denial's remediation
    /// sentence) that needs to name it without holding one separately.
    #[must_use]
    pub fn slot(&self) -> RuntimeSlot {
        self.slot
    }

    /// Re-reads the config and resolves consent without reusing prior authority.
    ///
    /// # Example
    ///
    /// ```ignore
    /// if source.refresh().shell { /* launch after the final check */ }
    /// ```
    #[must_use]
    pub fn refresh(&self) -> ResolvedCapabilityAllow {
        let state = read_runtime_slot_config(self.slot, &self.mango_home);
        if state.error.is_some() {
            consent_preset(ManifestProfile::None)
        } else {
            resolve_allow(self.slot, state.stored.as_ref())
        }
    }
}

/// Fills every default in from `slot`, mirroring
/// `resolveRuntimeSlotConfig`'s `allow` computation exactly: a stored
/// `allow` that is missing a key takes the *slot default* for that key —
/// except `externalAgents`, whose absence always resolves to denied,
/// regardless of what the slot would otherwise default to (an old file
/// never consented to launching vendor processes, so its absence cannot be
/// read as consent). No stored document at all keeps the slot default in
/// full, `externalAgents` included.
///
/// `pub(crate)`: [`crate::consent::invocation`] resolves the same stored
/// value it just decided `setup.state` from, inside the one lock scope that
/// read it, rather than letting [`ConsentSource::refresh`] re-read the file
/// a second time under no lock at all.
pub(crate) fn resolve_allow(slot: RuntimeSlot, stored: Option<&Value>) -> ResolvedCapabilityAllow {
    let defaults = default_consent_for_slot(slot);
    let Some(stored) = stored else {
        return defaults;
    };
    // An absent `externalAgents` reads as denied even where the slot's
    // default grants everything, so it starts from `false`, not the default.
    let mut allow = ResolvedCapabilityAllow {
        external_agents: false,
        ..defaults
    };
    for key in capability_keys() {
        if let Some(granted) = stored
            .get("allow")
            .and_then(|allow| allow.get(key)?.as_bool())
        {
            allow.set(key, granted);
        }
    }
    allow
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::ConsentSource;
    use crate::runtime_home::{RuntimeSlot, write_runtime_slot_config};
    use crate::test_support::scratch_dir as scratch_home;

    #[test]
    fn an_absent_file_takes_the_slots_default() {
        let home = scratch_home("absent-host");
        let source = ConsentSource::new(RuntimeSlot::Host, home.to_path_buf());
        assert!(source.refresh().shell, "host defaults to full");

        let remote = ConsentSource::new(RuntimeSlot::Remote, home.to_path_buf());
        assert!(!remote.refresh().shell, "remote defaults to none");
    }

    #[test]
    fn a_stored_profile_is_read_back() {
        let home = scratch_home("stored-readonly");
        write_runtime_slot_config(
            RuntimeSlot::Host,
            &home,
            &[(
                "allow",
                Some(json!({
                    "fsRead": true, "fsWrite": false, "shell": false, "git": true,
                    "probing": true, "mcp": false, "library": true,
                    "checkpoints": false, "update": false,
                })),
            )],
        )
        .unwrap();

        let source = ConsentSource::new(RuntimeSlot::Host, home.to_path_buf());
        let allow = source.refresh();
        assert!(allow.fs_read);
        assert!(!allow.shell);
    }

    #[test]
    fn a_change_is_picked_up_without_reconnecting() {
        let home = scratch_home("live-update");
        let source = ConsentSource::new(RuntimeSlot::Host, home.to_path_buf());
        assert!(source.refresh().shell, "host starts fully consented");

        write_runtime_slot_config(
            RuntimeSlot::Host,
            &home,
            &[("allow", Some(json!({ "shell": false })))],
        )
        .unwrap();
        assert!(
            !source.refresh().shell,
            "a later write must be visible on the very next refresh"
        );
    }

    #[test]
    fn same_size_same_timestamp_rewrite_cannot_reuse_consent() {
        let home = scratch_home("consent-metadata-preserved");
        write_runtime_slot_config(
            RuntimeSlot::Host,
            &home,
            &[("allow", Some(json!({"shell": true})))],
        )
        .unwrap();
        let source = ConsentSource::new(RuntimeSlot::Host, home.to_path_buf());
        assert!(source.refresh().shell);
        let path = crate::runtime_home::slot_config_path(RuntimeSlot::Host, &home);
        let before = std::fs::read_to_string(&path).unwrap();
        assert!(before.contains("\"shell\": true"));
        let after = before.replace("\"shell\": true", "\"shell\":false");
        assert_eq!(before.len(), after.len());
        let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
        std::fs::write(&path, after).unwrap();
        std::fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(modified)
            .unwrap();
        assert!(
            !source.refresh().shell,
            "fresh authority must not depend on cached file metadata"
        );
    }

    #[cfg(unix)]
    #[test]
    fn removing_read_permission_without_changing_contents_fails_closed() {
        if nix::unistd::Uid::effective().is_root() {
            // Root reads through chmod 000, so it cannot exercise denial.
            eprintln!("skipping permission denial test: running as root");
            return;
        }
        use std::os::unix::fs::PermissionsExt as _;

        let home = scratch_home("cache-hit");
        write_runtime_slot_config(
            RuntimeSlot::Host,
            &home,
            &[("allow", Some(json!({ "shell": true })))],
        )
        .unwrap();
        let source = ConsentSource::new(RuntimeSlot::Host, home.to_path_buf());
        assert!(source.refresh().shell);

        // Read permission can change without changing contents or mtime.
        let path = crate::runtime_home::slot_config_path(RuntimeSlot::Host, &home);
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();

        assert!(
            !source.refresh().shell,
            "unreadable consent must deny even when contents are unchanged"
        );
    }

    /// The security property the module exists for: a file that was
    /// readable and becomes unreadable downgrades to `none` — not the
    /// previous grant, not `full`.
    ///
    /// Also covers changed contents followed by permission revocation.
    #[cfg(unix)]
    #[test]
    fn revocation_by_removing_read_permission_fails_closed_to_none() {
        if nix::unistd::Uid::effective().is_root() {
            // Root reads through a `chmod 000` file anyway, so the
            // revocation this test forces would never actually take
            // effect and `after.shell` would still be `true` — a failure,
            // not a pass, if this ran unguarded under root.
            eprintln!(
                "skipping revocation_by_removing_read_permission_fails_closed_to_none: running as root"
            );
            return;
        }
        use std::os::unix::fs::PermissionsExt as _;

        let home = scratch_home("revoke-permission");
        write_runtime_slot_config(
            RuntimeSlot::Host,
            &home,
            &[("allow", Some(json!({ "shell": true, "fsRead": true })))],
        )
        .unwrap();
        let source = ConsentSource::new(RuntimeSlot::Host, home.to_path_buf());
        assert!(source.refresh().shell, "granted before revocation");

        // Change the contents before removing permission as a separate case.
        write_runtime_slot_config(
            RuntimeSlot::Host,
            &home,
            &[(
                "allow",
                Some(json!({ "shell": true, "fsRead": true, "probing": true })),
            )],
        )
        .unwrap();
        let path = crate::runtime_home::slot_config_path(RuntimeSlot::Host, &home);
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();

        let after = source.refresh();
        assert!(!after.shell, "revocation must deny shell, not keep it");
        assert!(!after.fs_read, "revocation must deny every capability");

        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    }

    /// The same property, forced through a directory sitting where the file
    /// belongs (`EISDIR`) rather than a permission bit — portable, and the
    /// one that still proves the point even in an environment (a root
    /// build, a container) where a `0o000` file mode does not actually
    /// block a read.
    #[test]
    fn revocation_by_a_directory_replacing_the_file_fails_closed_to_none() {
        let home = scratch_home("revoke-eisdir");
        write_runtime_slot_config(
            RuntimeSlot::Host,
            &home,
            &[("allow", Some(json!({ "shell": true })))],
        )
        .unwrap();
        let source = ConsentSource::new(RuntimeSlot::Host, home.to_path_buf());
        assert!(source.refresh().shell, "granted before revocation");

        let path = crate::runtime_home::slot_config_path(RuntimeSlot::Host, &home);
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();

        assert!(
            !source.refresh().shell,
            "a directory sitting where the file belongs must fail closed, not keep the old grant"
        );
    }

    #[test]
    fn a_malformed_file_fails_closed_to_none_not_the_slots_default() {
        let home = scratch_home("malformed");
        let dir = crate::runtime_home::slot_dir(RuntimeSlot::Host, &home);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("runtime.json"), b"{ not json").unwrap();

        let source = ConsentSource::new(RuntimeSlot::Host, home.to_path_buf());
        assert!(
            !source.refresh().shell,
            "malformed JSON must fail closed even though host defaults to full"
        );
    }

    #[test]
    fn an_absent_external_agents_key_is_denied_even_under_a_slot_that_defaults_to_full() {
        let home = scratch_home("external-agents-absent");
        write_runtime_slot_config(
            RuntimeSlot::Host,
            &home,
            &[("allow", Some(json!({ "shell": true })))],
        )
        .unwrap();
        let source = ConsentSource::new(RuntimeSlot::Host, home.to_path_buf());
        let allow = source.refresh();
        assert!(allow.shell, "shell falls back to the slot default");
        assert!(
            !allow.external_agents,
            "an absent externalAgents key must never be read as consent"
        );
    }
}
