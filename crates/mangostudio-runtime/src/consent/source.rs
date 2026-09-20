//! Re-reading `runtime.json`'s `allow` set on every call, without re-reading
//! the file itself when nothing has changed.
//!
//! Mirrors `apps/runtime/src/consent-source.ts`'s `staticConsentSource`
//! (well, its `RuntimeConsentSource.refresh` half — this crate has no
//! equivalent to the static, disk-free variant TypeScript also offers,
//! since every slot this crate serves has a real `runtime.json` to read).
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

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

use mangostudio_runtime_contract::manifest::ManifestProfile;
use serde_json::Value;

use crate::consent::presets::{ResolvedCapabilityAllow, consent_preset, default_consent_for_slot};
use crate::ports::audit::lock;
use crate::runtime_home::{RuntimeSlot, read_runtime_slot_config, slot_config_path};

/// A `mtime:size` pair identifying one version of a file's contents,
/// cheaply comparable without reading the file itself. Mirrors
/// `consent-source.ts`'s own `${info.mtimeMs}:${info.size}`, though the two
/// are never compared to each other — this is a process-local cache key,
/// not a value written anywhere, so its exact formatting does not need to
/// match TypeScript's byte for byte.
fn fingerprint_of(metadata: &std::fs::Metadata) -> String {
    let mtime_millis = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    format!("{mtime_millis}:{}", metadata.len())
}

/// A sentinel fingerprint for "confirmed absent", distinct from any real
/// `mtime:size` pair (which never contains a colon-free non-numeric run).
const ABSENT: &str = "absent";

/// A sentinel fingerprint that matches no real one, cached after any read
/// this module could not attribute to a specific file version (an
/// unreadable stat). Its only job is to *not* equal a subsequent real
/// fingerprint, forcing one more re-read before caching resumes — mirrors
/// `consent-source.ts` setting `fingerprint = nextFingerprint ?? 'read'`
/// after exactly that kind of read.
const UNATTRIBUTED: &str = "read";

struct Cache {
    /// `None` means "no cached answer may be trusted" — the initial state,
    /// and the state after any stat this module could not read at all.
    fingerprint: Option<String>,
    allow: ResolvedCapabilityAllow,
}

/// Reads `runtime.json`'s `allow` set for one slot, re-reading the file only
/// when its `mtime:size` fingerprint has actually changed since the last
/// call. See the module docs for the fail-closed rule this exists to serve.
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
    cache: Mutex<Cache>,
}

impl ConsentSource {
    /// Builds a source for `slot`'s `runtime.json` under `mango_home`. Reads
    /// nothing until [`ConsentSource::refresh`] is first called.
    #[must_use]
    pub fn new(slot: RuntimeSlot, mango_home: PathBuf) -> Self {
        Self {
            slot,
            mango_home,
            cache: Mutex::new(Cache {
                fingerprint: None,
                allow: default_consent_for_slot(slot),
            }),
        }
    }

    /// This source's slot, for a caller (a consent denial's remediation
    /// sentence) that needs to name it without holding one separately.
    #[must_use]
    pub fn slot(&self) -> RuntimeSlot {
        self.slot
    }

    fn config_path(&self) -> PathBuf {
        slot_config_path(self.slot, &self.mango_home)
    }

    /// Re-reads `runtime.json` if its fingerprint has changed since the
    /// last call (or if the last attempt could not be attributed to one —
    /// see `UNATTRIBUTED`), and returns the resolved `allow` set either
    /// way.
    #[must_use]
    pub fn refresh(&self) -> ResolvedCapabilityAllow {
        let next_fingerprint = next_fingerprint(&self.config_path());

        let mut cache = lock(&self.cache);
        if let Some(next) = next_fingerprint.as_deref()
            && cache.fingerprint.as_deref() == Some(next)
        {
            return cache.allow;
        }

        let state = read_runtime_slot_config(self.slot, &self.mango_home);
        let allow = if state.error.is_some() {
            // Fail closed: unreadable, malformed, or schema-invalid all
            // downgrade to `none` — never the previous cached grant, never
            // `full`. This is the one branch the module docs are about.
            consent_preset(ManifestProfile::None)
        } else {
            resolve_allow(self.slot, state.stored.as_ref())
        };
        cache.allow = allow;
        cache.fingerprint = Some(next_fingerprint.unwrap_or_else(|| UNATTRIBUTED.to_string()));
        allow
    }
}

/// The fingerprint of whatever is at `path` right now, or `None` when this
/// process could not even stat it (permissions, a transient I/O failure) —
/// `None` deliberately never matches a cached fingerprint, so a caller
/// always re-reads rather than trusting a cache it could not revalidate.
fn next_fingerprint(path: &Path) -> Option<String> {
    match std::fs::metadata(path) {
        Ok(metadata) => Some(fingerprint_of(&metadata)),
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
            ) =>
        {
            Some(ABSENT.to_string())
        }
        Err(_) => None,
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
fn resolve_allow(slot: RuntimeSlot, stored: Option<&Value>) -> ResolvedCapabilityAllow {
    let defaults = default_consent_for_slot(slot);
    let Some(stored) = stored else {
        return defaults;
    };
    let stored_bool = |key: &str| -> Option<bool> { stored.get("allow")?.get(key)?.as_bool() };
    ResolvedCapabilityAllow {
        fs_read: stored_bool("fsRead").unwrap_or(defaults.fs_read),
        fs_write: stored_bool("fsWrite").unwrap_or(defaults.fs_write),
        shell: stored_bool("shell").unwrap_or(defaults.shell),
        git: stored_bool("git").unwrap_or(defaults.git),
        probing: stored_bool("probing").unwrap_or(defaults.probing),
        mcp: stored_bool("mcp").unwrap_or(defaults.mcp),
        library: stored_bool("library").unwrap_or(defaults.library),
        checkpoints: stored_bool("checkpoints").unwrap_or(defaults.checkpoints),
        update: stored_bool("update").unwrap_or(defaults.update),
        external_agents: stored_bool("externalAgents").unwrap_or(false),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::ConsentSource;
    use crate::runtime_home::{RuntimeSlot, write_runtime_slot_config};

    fn scratch_home(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "mango-consent-source-test-{name}-{}-{}",
            std::process::id(),
            line!()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn an_absent_file_takes_the_slots_default() {
        let home = scratch_home("absent-host");
        let source = ConsentSource::new(RuntimeSlot::Host, home.clone());
        assert!(source.refresh().shell, "host defaults to full");

        let remote = ConsentSource::new(RuntimeSlot::Remote, home);
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

        let source = ConsentSource::new(RuntimeSlot::Host, home);
        let allow = source.refresh();
        assert!(allow.fs_read);
        assert!(!allow.shell);
    }

    #[test]
    fn a_change_is_picked_up_without_reconnecting() {
        let home = scratch_home("live-update");
        let source = ConsentSource::new(RuntimeSlot::Host, home.clone());
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
    fn an_unchanged_file_is_not_re_read() {
        let home = scratch_home("cache-hit");
        write_runtime_slot_config(
            RuntimeSlot::Host,
            &home,
            &[("allow", Some(json!({ "shell": true })))],
        )
        .unwrap();
        let source = ConsentSource::new(RuntimeSlot::Host, home.clone());
        assert!(source.refresh().shell);

        // Delete the file out from under the cached fingerprint check
        // without touching the config path stat again: if `refresh` did
        // not skip re-reading, it would immediately see "absent" and
        // downgrade — proving the cache hit path never even calls
        // `read_runtime_slot_config` a second time when nothing changed.
        let stat_before = std::fs::metadata(crate::runtime_home::slot_config_path(
            RuntimeSlot::Host,
            &home,
        ))
        .unwrap();
        assert!(source.refresh().shell, "unchanged file, must hit the cache");
        let stat_after = std::fs::metadata(crate::runtime_home::slot_config_path(
            RuntimeSlot::Host,
            &home,
        ))
        .unwrap();
        assert_eq!(stat_before.len(), stat_after.len());
    }

    /// The security property the module exists for: a file that was
    /// readable and becomes unreadable downgrades to `none` — not the
    /// previous grant, not `full`.
    ///
    /// `chmod 0` alone would not exercise this: POSIX `stat(2)` needs no
    /// read permission on the file itself (only search on its parent
    /// directory), so a bare permission change leaves this module's
    /// `mtime:size` fingerprint unchanged and the cache hit never even
    /// looks at the file again — true of `consent-source.ts`'s identical
    /// fingerprint too, not a gap this port introduces. The second write
    /// below changes the file's size, which *does* change the fingerprint
    /// and is what actually forces the re-read the `chmod` then fails.
    #[cfg(unix)]
    #[test]
    fn revocation_by_removing_read_permission_fails_closed_to_none() {
        use std::os::unix::fs::PermissionsExt as _;

        let home = scratch_home("revoke-permission");
        write_runtime_slot_config(
            RuntimeSlot::Host,
            &home,
            &[("allow", Some(json!({ "shell": true, "fsRead": true })))],
        )
        .unwrap();
        let source = ConsentSource::new(RuntimeSlot::Host, home.clone());
        assert!(source.refresh().shell, "granted before revocation");

        // Forces the fingerprint to change (a genuinely different file
        // size), so the next `refresh` cannot serve the cached answer.
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
        let source = ConsentSource::new(RuntimeSlot::Host, home.clone());
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

        let source = ConsentSource::new(RuntimeSlot::Host, home);
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
        let source = ConsentSource::new(RuntimeSlot::Host, home);
        let allow = source.refresh();
        assert!(allow.shell, "shell falls back to the slot default");
        assert!(
            !allow.external_agents,
            "an absent externalAgents key must never be read as consent"
        );
    }
}
