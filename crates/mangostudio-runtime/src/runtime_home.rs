//! The runtime-home layout: `~/.mango/runtime/<slot>/…`.
//!
//! Mirrors `apps/runtime/src/runtime-home.ts` (the disk-touching half) and
//! `apps/shared/src/runtime-home/paths.ts` (the pure path arithmetic).
//! Every name below is taken from
//! `mangostudio_runtime_contract::strings::runtime_home` — never hand-typed
//! — and every shape read from or written to disk is checked against
//! `mangostudio_runtime_contract::schemas::validate_runtime_home`, the same
//! validator PR 002's dispatcher and the TypeScript side both build from
//! `runtime-home.schema.json`.
//!
//! # What this module does not do
//!
//! It reads and writes `runtime.json` and `credentials.json` as
//! schema-checked JSON `Value`s, merged shallowly under a lock. It does
//! **not** resolve consent: `RUNTIME_CONSENT_PRESETS`, `profileForAllow`,
//! and the fully-merged `ResolvedRuntimeSlotConfig` in
//! `apps/shared/src/runtime-home/consent.ts` are capability policy, owned
//! by the dispatcher lane that also owns the consent gate and audit log
//! (see the crate-level docs). The one piece of that policy this module
//! does need — which slots start pre-consented — is
//! [`DefaultSetupState`], because a caller reading an absent or unusable
//! `runtime.json` has to know which default it fell back to; the module
//! stops there and hands the rest to whoever resolves capabilities.
//!
//! Credential *validation* — what a future `schemaVersion`, an unreadable
//! file, or a wrong-typed token should mean — is also out of scope: PR
//! #1078 is still settling that on the TypeScript side, and this module
//! reads/writes `credentials.json` as bytes and schema only, so it has
//! nothing to un-settle when that lands.

use std::path::{Path, PathBuf};

use mangostudio_runtime_contract::schemas::{
    RuntimeHomeDocument, Violation, validate_runtime_home,
};
use mangostudio_runtime_contract::strings::runtime_home as names;
use serde_json::{Map, Value};

pub mod atomic;
pub mod lock;
pub mod owner_only;

/// The lock guarding `credentials.json`.
///
/// Not in `strings.json` (nor in `apps/shared`): unlike
/// [`names::CONFIG_LOCK_FILE_NAME`], which crosses into the shared contract
/// because a Windows hub provisioning a WSL distribution writes
/// `runtime.json` from *outside* a runtime process and must take the same
/// lock a runtime's own writers do, nothing outside a runtime process ever
/// writes `credentials.json`. `runtime-home.ts` spells this as a local
/// `const CREDENTIALS_LOCK_FILE = 'credentials.lock'` for the same reason;
/// this mirrors that local literal rather than inventing a contract entry
/// for a name only this crate and its TypeScript counterpart ever read.
pub const CREDENTIALS_LOCK_FILE_NAME: &str = "credentials.lock";

/// One of the three places a runtime's bytes and consent can live.
///
/// `strings::runtime_home::SLOTS` — `["host", "wsl", "remote"]` — is the
/// full set today; there is no fourth slot in the contract, the JSON
/// schema, or `RuntimeSlotSchema` on the TypeScript side. (An earlier draft
/// of this crate's brief described a `user-<id>` slot; it does not exist
/// anywhere in the shared contract or `apps/shared/src/runtime-home`, and
/// inventing one here would fail `validate_runtime_home` against real
/// `runtime.json` files and diverge from every TypeScript reader of them.)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RuntimeSlot {
    /// Shipped beside the hub binary by this machine's own install.
    Host,
    /// Pushed into a WSL distribution by a Windows hub.
    Wsl,
    /// Placed over ssh, or installed by hand for a WebSocket or Direct URL pair.
    Remote,
}

/// A string that names none of [`RuntimeSlot`]'s three variants.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnknownRuntimeSlot(pub String);

impl std::fmt::Display for UnknownRuntimeSlot {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{:?} is not a runtime-home slot", self.0)
    }
}

impl std::error::Error for UnknownRuntimeSlot {}

impl RuntimeSlot {
    /// Every slot, in `strings.json`'s own order.
    pub const ALL: [RuntimeSlot; 3] = [RuntimeSlot::Host, RuntimeSlot::Wsl, RuntimeSlot::Remote];

    /// The on-disk and on-wire spelling, taken from
    /// `strings::runtime_home::SLOTS` — see the test in this module that
    /// asserts the two never drift apart.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            RuntimeSlot::Host => names::SLOTS[0],
            RuntimeSlot::Wsl => names::SLOTS[1],
            RuntimeSlot::Remote => names::SLOTS[2],
        }
    }
}

impl std::fmt::Display for RuntimeSlot {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl std::str::FromStr for RuntimeSlot {
    type Err = UnknownRuntimeSlot;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        RuntimeSlot::ALL
            .into_iter()
            .find(|slot| slot.as_str() == value)
            .ok_or_else(|| UnknownRuntimeSlot(value.to_string()))
    }
}

/// Resolves the account's home directory the way Node's `os.homedir()`
/// does, so a Rust runtime and a TypeScript one agree on the same
/// directory when neither has `MANGO_HOME` set.
///
/// `std::env::home_dir` was fixed in Rust 1.85 (Windows now asks
/// `USERPROFILE`/`GetUserProfileDirectoryW` instead of a Cygwin-style
/// `HOME`) and its deprecation lint was lifted in 1.87
/// (rust-lang/rust#132650); this workspace's 1.97 floor postdates both, so
/// this crate calls it directly rather than adding `dirs`/`directories` —
/// both solve XDG config/cache/data resolution, a different problem from
/// "what does this account call home".
///
/// # Panics
/// When the platform cannot resolve a home directory at all (no `HOME` or
/// `USERPROFILE`, and no password-database entry either). This is the same
/// situation Node's `os.homedir()` throws on; a runtime host with no home
/// directory has no sound state directory to fall back to.
#[must_use]
pub fn home_dir() -> PathBuf {
    std::env::home_dir()
        .unwrap_or_else(|| panic!("could not resolve this account's home directory"))
}

/// `<home>/.mango`.
#[must_use]
pub fn mango_home_dir(home: &Path) -> PathBuf {
    home.join(names::HOME_DIR_NAME)
}

/// `<mango_home>/runtime`.
#[must_use]
pub fn runtime_home_dir(mango_home: &Path) -> PathBuf {
    mango_home.join(names::RUNTIME_DIR_NAME)
}

/// `<mango_home>/runtime/<slot>`.
#[must_use]
pub fn slot_dir(slot: RuntimeSlot, mango_home: &Path) -> PathBuf {
    runtime_home_dir(mango_home).join(slot.as_str())
}

/// `<mango_home>/runtime/<slot>/runtime.json`.
#[must_use]
pub fn slot_config_path(slot: RuntimeSlot, mango_home: &Path) -> PathBuf {
    slot_dir(slot, mango_home).join(names::CONFIG_FILE_NAME)
}

/// `<mango_home>/runtime/<slot>/runtime.lock`.
#[must_use]
pub fn slot_config_lock_path(slot: RuntimeSlot, mango_home: &Path) -> PathBuf {
    slot_dir(slot, mango_home).join(names::CONFIG_LOCK_FILE_NAME)
}

/// `<mango_home>/runtime/<slot>/credentials.json`.
#[must_use]
pub fn slot_credentials_path(slot: RuntimeSlot, mango_home: &Path) -> PathBuf {
    slot_dir(slot, mango_home).join(names::CREDENTIALS_FILE_NAME)
}

/// `<mango_home>/runtime/<slot>/credentials.lock`.
#[must_use]
pub fn slot_credentials_lock_path(slot: RuntimeSlot, mango_home: &Path) -> PathBuf {
    slot_dir(slot, mango_home).join(CREDENTIALS_LOCK_FILE_NAME)
}

/// `<mango_home>/runtime/<slot>/audit.log`.
#[must_use]
pub fn slot_audit_log_path(slot: RuntimeSlot, mango_home: &Path) -> PathBuf {
    slot_dir(slot, mango_home).join(names::AUDIT_LOG_FILE_NAME)
}

/// `<mango_home>/runtime/<slot>/current`: the link a launcher points at,
/// which survives every upgrade.
#[must_use]
pub fn slot_current_dir(slot: RuntimeSlot, mango_home: &Path) -> PathBuf {
    slot_dir(slot, mango_home).join(names::CURRENT_LINK_NAME)
}

/// `<mango_home>/runtime/<slot>/<version>`: where an install writes bytes
/// before publishing them through `current`.
#[must_use]
pub fn slot_version_dir(slot: RuntimeSlot, version: &str, mango_home: &Path) -> PathBuf {
    slot_dir(slot, mango_home).join(version)
}

/// The runtime binary's file name on this platform: `strings::BINARY_BASENAME`,
/// with `.exe` appended on Windows.
#[must_use]
pub fn binary_name() -> String {
    if cfg!(windows) {
        format!("{}.exe", names::BINARY_BASENAME)
    } else {
        names::BINARY_BASENAME.to_string()
    }
}

/// `<slot_current_dir>/<binary_name>`.
#[must_use]
pub fn slot_current_binary_path(slot: RuntimeSlot, mango_home: &Path) -> PathBuf {
    slot_current_dir(slot, mango_home).join(binary_name())
}

/// `<slot_version_dir>/<binary_name>`.
#[must_use]
pub fn slot_version_binary_path(slot: RuntimeSlot, version: &str, mango_home: &Path) -> PathBuf {
    slot_version_dir(slot, version, mango_home).join(binary_name())
}

/// Lowercases `path` on Windows only, mirroring `runtimeSlotForPath`'s own
/// platform split: Windows paths are case-insensitive, POSIX paths are not
/// (and there, `\` is an ordinary filename character, never a separator —
/// which `Path`'s own component parsing on a non-Windows target already
/// gets right without this crate re-deriving it).
fn normalize_for_comparison(path: &Path) -> PathBuf {
    if cfg!(windows) {
        PathBuf::from(path.as_os_str().to_string_lossy().to_lowercase())
    } else {
        path.to_path_buf()
    }
}

/// Which slot a path belongs to, or `None` when it is outside the home
/// entirely.
///
/// A runtime has to answer this about its own executable: the same binary
/// serves a `host` install and an ssh-pushed `remote` one, and only its
/// location says which consent file governs it. Comparison is
/// component-wise via [`Path::starts_with`] rather than string-prefix
/// matching, so `…/runtime/remotely` can never be mistaken for the
/// `remote` slot the way a naive string prefix check could.
///
/// # Example
/// ```
/// use std::path::Path;
/// use mangostudio_runtime::runtime_home::{RuntimeSlot, slot_for_path};
///
/// let home = Path::new("/home/ada/.mango");
/// let remote = Path::new("/home/ada/.mango/runtime/remote/0.1.0/mangostudio-runtime");
/// assert_eq!(slot_for_path(remote, home), Some(RuntimeSlot::Remote));
/// assert_eq!(slot_for_path(Path::new("/usr/local/bin/mangostudio-runtime"), home), None);
/// ```
#[must_use]
pub fn slot_for_path(path: &Path, mango_home: &Path) -> Option<RuntimeSlot> {
    let candidate = normalize_for_comparison(path);
    RuntimeSlot::ALL.into_iter().find(|&slot| {
        let root = normalize_for_comparison(&slot_dir(slot, mango_home));
        candidate.starts_with(&root)
    })
}

/// Which slot governs this process, from where its executable sits.
///
/// A binary outside the home entirely — beside a hub, or on a `PATH` — is
/// the machine's own install, so it answers to `host`.
#[must_use]
pub fn resolve_runtime_slot(mango_home: &Path, executable_paths: &[PathBuf]) -> RuntimeSlot {
    executable_paths
        .iter()
        .filter(|path| !path.as_os_str().is_empty())
        .find_map(|path| slot_for_path(path, mango_home))
        .unwrap_or(RuntimeSlot::Host)
}

/// Which slot this running process's own executable belongs to.
///
/// # Example
/// ```
/// use mangostudio_runtime::runtime_home::{RuntimeSlot, resolve_runtime_slot_for_current_exe};
///
/// let outside_any_home = std::env::temp_dir().join("definitely-not-a-mango-home");
/// assert_eq!(resolve_runtime_slot_for_current_exe(&outside_any_home), RuntimeSlot::Host);
/// ```
#[must_use]
pub fn resolve_runtime_slot_for_current_exe(mango_home: &Path) -> RuntimeSlot {
    let current = std::env::current_exe().ok();
    resolve_runtime_slot(mango_home, current.as_slice())
}

/// Whether a slot with no answer yet starts life pre-consented.
///
/// The one piece of `apps/shared/src/runtime-home/consent.ts`'s
/// `defaultConsentForSlot` this crate needs: `host` and `wsl` were placed
/// by somebody with an account on this machine, so absence there means
/// full consent (`Configured`); `remote` was placed by somebody's hub, so
/// absence there means nobody has answered (`Pending`). The *capability
/// set* each state resolves to — `RUNTIME_CONSENT_PRESETS`, merged over a
/// stored `allow` — is consent policy, not layout, and stays with the
/// dispatcher lane.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DefaultSetupState {
    /// This slot is answered by default: `host`, `wsl`.
    Configured,
    /// This slot waits for an explicit answer: `remote`.
    Pending,
}

/// See [`DefaultSetupState`].
#[must_use]
pub fn default_setup_state_for_slot(slot: RuntimeSlot) -> DefaultSetupState {
    match slot {
        RuntimeSlot::Remote => DefaultSetupState::Pending,
        RuntimeSlot::Host | RuntimeSlot::Wsl => DefaultSetupState::Configured,
    }
}

/// What was on disk at `path`, or why it could not be trusted.
///
/// Mirrors the `{ stored, error }` half of `RuntimeSlotState` in
/// `runtime-home.ts` (the `config` field — the fully-resolved,
/// default-filled shape — is the consent-policy half this crate does not
/// build; see the module docs).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SlotFileState {
    /// The file exactly as stored and schema-checked, or `None` when there
    /// was none, or when what was there could not be trusted (see
    /// `error`).
    pub stored: Option<Value>,
    /// Set when a file was present but unusable: not readable, not JSON, or
    /// not schema-valid. A caller must not read `stored: None` here the
    /// same way it reads a genuine absence — for `host` and `wsl`,
    /// [`default_setup_state_for_slot`] is `Configured`, and treating an
    /// unreadable file as if it had never existed would silently widen
    /// what that slot allows. `None` here (alongside `stored: None`) is the
    /// one case that really is absence.
    pub error: Option<String>,
}

/// Reads and schema-checks the document at `path`.
///
/// Absence (`NotFound`, or `NotADirectory` from a path component that
/// cannot hold a file) is not an error — most slots never have a file —
/// but anything else is: a permissions failure, a directory sitting where
/// the file belongs, malformed JSON, or a value the schema refuses.
/// Every one of those travels on [`SlotFileState::error`] rather than
/// merging over a default or rewriting the file, matching
/// `readRuntimeSlotState` in `runtime-home.ts`.
fn read_schema_checked(path: &Path, document: RuntimeHomeDocument) -> SlotFileState {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
            ) =>
        {
            return SlotFileState::default();
        }
        Err(error) => {
            return SlotFileState {
                stored: None,
                error: Some(format!("{} could not be read ({error}).", path.display())),
            };
        }
    };

    let value: Value = match serde_json::from_str(&raw) {
        Ok(value) => value,
        Err(error) => {
            return SlotFileState {
                stored: None,
                error: Some(format!("{} is not valid JSON ({error}).", path.display())),
            };
        }
    };

    if let Err(violation) = validate_runtime_home(document, &value) {
        return SlotFileState {
            stored: None,
            error: Some(format!(
                "{} does not match the runtime-home schema ({violation}).",
                path.display()
            )),
        };
    }

    SlotFileState {
        stored: Some(value),
        error: None,
    }
}

/// Reads and schema-checks `runtime.json` for `slot`.
#[must_use]
pub fn read_runtime_slot_config(slot: RuntimeSlot, mango_home: &Path) -> SlotFileState {
    read_schema_checked(
        &slot_config_path(slot, mango_home),
        RuntimeHomeDocument::SlotConfig,
    )
}

/// Reads and schema-checks `credentials.json` for `slot`.
///
/// Bytes and schema only — see the module docs for why this crate does not
/// judge whether a stored token looks acceptable.
#[must_use]
pub fn read_runtime_slot_credentials(slot: RuntimeSlot, mango_home: &Path) -> SlotFileState {
    read_schema_checked(
        &slot_credentials_path(slot, mango_home),
        RuntimeHomeDocument::Credentials,
    )
}

/// Why a merged write to a runtime-home document failed.
#[derive(Debug)]
pub enum WriteError {
    /// Could not acquire the slot lock in time (or at all).
    Lock(lock::LockError),
    /// The merged document failed `validate_runtime_home` — the write
    /// never reached disk.
    SchemaInvalid(Violation),
    /// The merged document could not be serialised. Not expected in
    /// practice (every value here came from `serde_json::Value`, which
    /// always encodes), kept as a variant rather than a `panic!` because a
    /// caller should be able to match on every failure mode of a
    /// filesystem write.
    Encode(serde_json::Error),
    /// The temp-file-then-rename publish failed.
    Io(std::io::Error),
}

impl std::fmt::Display for WriteError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WriteError::Lock(error) => write!(formatter, "{error}"),
            WriteError::SchemaInvalid(violation) => write!(formatter, "{violation}"),
            WriteError::Encode(error) => {
                write!(formatter, "could not encode the merged document: {error}")
            }
            WriteError::Io(error) => {
                write!(formatter, "could not publish the merged document: {error}")
            }
        }
    }
}

impl std::error::Error for WriteError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            WriteError::Lock(error) => Some(error),
            WriteError::SchemaInvalid(violation) => Some(violation),
            WriteError::Encode(error) => Some(error),
            WriteError::Io(error) => Some(error),
        }
    }
}

/// What a merged write did to what was there before.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct WriteOutcome {
    /// Set when the previous file was present but unusable (not the schema,
    /// not JSON, not readable) and this write replaced it outright rather
    /// than merging on top of it — the one case `runtime-home.ts`'s own
    /// `readStoredRuntimeSlotConfig` handles the same way but never reports:
    /// its comment says "a file this process cannot parse is one this write
    /// replaces", and the caller never learns that happened. This field is
    /// the difference: the replacement still happens (refusing to write
    /// would leave the slot permanently stuck), but it is never silent.
    pub replaced_unusable: Option<String>,
}

/// Reads `path` as an object (or starts a fresh one, when absent or
/// unusable), applies `update` (a key set to `None` is removed — the merge
/// equivalent of `runtime-home.ts`'s `stripUndefined`), stamps every pair
/// in `fixed`, validates the result, and publishes it atomically.
fn merge_write(
    path: &Path,
    document: RuntimeHomeDocument,
    fixed: &[(&'static str, Value)],
    update: &[(&str, Option<Value>)],
) -> Result<WriteOutcome, WriteError> {
    let state = read_schema_checked(path, document);
    let mut object = match state.stored {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    };

    for (key, value) in update {
        match value {
            Some(v) => {
                object.insert((*key).to_string(), v.clone());
            }
            None => {
                object.remove(*key);
            }
        }
    }
    for (key, value) in fixed {
        object.insert((*key).to_string(), value.clone());
    }

    let value = Value::Object(object);
    validate_runtime_home(document, &value).map_err(WriteError::SchemaInvalid)?;
    let mut bytes = serde_json::to_vec_pretty(&value).map_err(WriteError::Encode)?;
    bytes.push(b'\n');
    atomic::write_new_file(path, &bytes, None).map_err(WriteError::Io)?;

    Ok(WriteOutcome {
        replaced_unusable: state.error,
    })
}

/// Merges `update` into `slot`'s `runtime.json` under its lock and
/// publishes the result atomically.
///
/// Only the keys named in `update` are touched — an installer writing
/// `version` must not disturb consent someone else answered, and vice
/// versa, which is exactly why this is locked rather than read-merge-write
/// without one: two writers interleaving without the lock lose whichever
/// field the loser set.
///
/// # Errors
/// See [`WriteError`].
pub fn write_runtime_slot_config(
    slot: RuntimeSlot,
    mango_home: &Path,
    update: &[(&str, Option<Value>)],
) -> Result<WriteOutcome, WriteError> {
    let path = slot_config_path(slot, mango_home);
    let lock_path = slot_config_lock_path(slot, mango_home);
    let fixed: [(&'static str, Value); 2] = [
        ("schemaVersion", Value::from(1)),
        ("slot", Value::from(slot.as_str())),
    ];
    lock::with_slot_lock(&lock_path, &lock::LockPolicy::default(), || {
        merge_write(&path, RuntimeHomeDocument::SlotConfig, &fixed, update)
    })
    .map_err(WriteError::Lock)?
}

/// Merges `update` into `slot`'s `credentials.json` under its own lock,
/// publishes it atomically, and restricts it to this account.
///
/// Bytes and schema only, as documented on [`read_runtime_slot_credentials`]:
/// this does not judge whether `update`'s values look like real tokens.
///
/// # Errors
/// See [`WriteError`].
pub fn write_runtime_slot_credentials(
    slot: RuntimeSlot,
    mango_home: &Path,
    update: &[(&str, Option<Value>)],
) -> Result<(WriteOutcome, bool), WriteError> {
    let path = slot_credentials_path(slot, mango_home);
    let lock_path = slot_credentials_lock_path(slot, mango_home);
    let fixed: [(&'static str, Value); 1] = [("schemaVersion", Value::from(1))];
    lock::with_slot_lock(&lock_path, &lock::LockPolicy::default(), || {
        let outcome = merge_write(&path, RuntimeHomeDocument::Credentials, &fixed, update)?;
        Ok((outcome, owner_only::restrict_to_owner(&path)))
    })
    .map_err(WriteError::Lock)?
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use mangostudio_runtime_contract::strings::runtime_home::SLOTS;
    use serde_json::{Value, json};

    use super::{
        DefaultSetupState, RuntimeSlot, WriteError, default_setup_state_for_slot, home_dir,
        read_runtime_slot_config, read_runtime_slot_credentials, resolve_runtime_slot,
        slot_config_path, slot_current_binary_path, slot_dir, slot_for_path,
        write_runtime_slot_config, write_runtime_slot_credentials,
    };

    fn scratch_home(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "mango-runtime-home-test-{name}-{}-{}",
            std::process::id(),
            line!()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn every_slot_spells_itself_exactly_as_strings_json_does() {
        // The regression this guards: `strings.rs` (and the `strings.json`
        // it mirrors) is the single source of truth for these three names.
        // A hand-typed literal here that drifts from it would still compile
        // and would still fail against a real TypeScript-written home.
        let spelled: Vec<&str> = RuntimeSlot::ALL.iter().map(|slot| slot.as_str()).collect();
        assert_eq!(spelled, SLOTS.to_vec());
    }

    #[test]
    fn from_str_round_trips_every_slot_and_rejects_an_unknown_one() {
        for slot in RuntimeSlot::ALL {
            assert_eq!(slot.as_str().parse::<RuntimeSlot>().unwrap(), slot);
        }
        assert!("nowhere".parse::<RuntimeSlot>().is_err());
    }

    #[test]
    fn anchors_each_slot_under_runtime_beneath_the_home() {
        let home = Path::new("/home/ada/.mango");
        assert_eq!(
            slot_dir(RuntimeSlot::Remote, home),
            home.join("runtime").join("remote")
        );
        assert_eq!(
            slot_config_path(RuntimeSlot::Host, home),
            home.join("runtime").join("host").join("runtime.json")
        );
    }

    #[test]
    fn the_current_binary_path_ends_in_the_platform_binary_name() {
        let home = Path::new("/home/ada/.mango");
        let path = slot_current_binary_path(RuntimeSlot::Host, home);
        let expected = if cfg!(windows) {
            "mangostudio-runtime.exe"
        } else {
            "mangostudio-runtime"
        };
        assert_eq!(path.file_name().unwrap(), expected);
    }

    #[test]
    fn slot_for_path_finds_the_owning_slot() {
        let home = Path::new("/home/ada/.mango");
        let remote_binary = home
            .join("runtime")
            .join("remote")
            .join("0.1.0")
            .join("mangostudio-runtime");
        assert_eq!(
            slot_for_path(&remote_binary, home),
            Some(RuntimeSlot::Remote)
        );
    }

    #[test]
    fn slot_for_path_does_not_mistake_a_sibling_name_for_the_slot_it_prefixes() {
        // `…/runtime/remotely` must never read as the `remote` slot — the
        // whole reason this uses `Path::starts_with` (component-wise)
        // rather than a raw string-prefix check.
        let home = Path::new("/home/ada/.mango");
        let sibling = home.join("runtime").join("remotely").join("file");
        assert_eq!(slot_for_path(&sibling, home), None);
    }

    #[test]
    fn resolve_runtime_slot_defaults_to_host_outside_every_slot() {
        let home = Path::new("/home/ada/.mango");
        let outside = [PathBuf::from("/usr/local/bin/mangostudio-runtime")];
        assert_eq!(resolve_runtime_slot(home, &outside), RuntimeSlot::Host);
    }

    #[test]
    fn resolve_runtime_slot_skips_empty_candidates() {
        let home = Path::new("/home/ada/.mango");
        let wsl = home
            .join("runtime")
            .join("wsl")
            .join("current")
            .join("mangostudio-runtime");
        let candidates = [PathBuf::new(), wsl.clone()];
        assert_eq!(resolve_runtime_slot(home, &candidates), RuntimeSlot::Wsl);
    }

    #[test]
    fn remote_defaults_to_pending_and_the_others_to_configured() {
        assert_eq!(
            default_setup_state_for_slot(RuntimeSlot::Remote),
            DefaultSetupState::Pending
        );
        assert_eq!(
            default_setup_state_for_slot(RuntimeSlot::Host),
            DefaultSetupState::Configured
        );
        assert_eq!(
            default_setup_state_for_slot(RuntimeSlot::Wsl),
            DefaultSetupState::Configured
        );
    }

    #[test]
    fn home_dir_resolves_to_something_nonempty() {
        // What it resolves to is platform policy this crate deliberately
        // does not second-guess; the contract is only that it answers.
        assert!(!home_dir().as_os_str().is_empty());
    }

    #[test]
    fn reading_an_absent_config_reports_no_error_and_nothing_stored() {
        let home = scratch_home("absent");
        let state = read_runtime_slot_config(RuntimeSlot::Remote, &home);
        assert_eq!(state.stored, None);
        assert_eq!(state.error, None);
    }

    #[test]
    fn reading_malformed_json_reports_a_typed_error_not_absence() {
        let home = scratch_home("malformed");
        let dir = slot_dir(RuntimeSlot::Host, &home);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("runtime.json"), b"{ not json").unwrap();

        let state = read_runtime_slot_config(RuntimeSlot::Host, &home);
        assert_eq!(state.stored, None);
        assert!(state.error.unwrap().contains("not valid JSON"));
    }

    #[test]
    fn reading_a_schema_invalid_config_reports_a_typed_error() {
        let home = scratch_home("schema-invalid");
        let dir = slot_dir(RuntimeSlot::Host, &home);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("runtime.json"),
            br#"{"schemaVersion":1,"slot":"nowhere"}"#,
        )
        .unwrap();

        let state = read_runtime_slot_config(RuntimeSlot::Host, &home);
        assert_eq!(state.stored, None);
        assert!(
            state
                .error
                .unwrap()
                .contains("does not match the runtime-home schema")
        );
    }

    #[test]
    fn reading_a_directory_where_the_file_belongs_is_unreadable_not_absent() {
        let home = scratch_home("eisdir");
        let dir = slot_dir(RuntimeSlot::Host, &home);
        // A directory named `runtime.json` fails the read with `EISDIR` —
        // the portable stand-in for EACCES/EPERM/EIO: a file is there and
        // this process cannot see what it says.
        std::fs::create_dir_all(dir.join("runtime.json")).unwrap();

        let state = read_runtime_slot_config(RuntimeSlot::Host, &home);
        assert_eq!(state.stored, None);
        assert!(state.error.unwrap().contains("could not be read"));
    }

    #[test]
    fn writing_creates_the_slot_directory_and_stamps_schema_version_and_slot() {
        let home = scratch_home("write-fresh");
        write_runtime_slot_config(
            RuntimeSlot::Remote,
            &home,
            &[("hubUrl", Some(json!("wss://hub.test")))],
        )
        .unwrap();

        let state = read_runtime_slot_config(RuntimeSlot::Remote, &home);
        let stored = state.stored.unwrap();
        assert_eq!(stored["schemaVersion"], json!(1));
        assert_eq!(stored["slot"], json!("remote"));
        assert_eq!(stored["hubUrl"], json!("wss://hub.test"));
    }

    #[test]
    fn writing_merges_rather_than_replacing_the_stored_document() {
        let home = scratch_home("merge");
        write_runtime_slot_config(
            RuntimeSlot::Remote,
            &home,
            &[("hubUrl", Some(json!("wss://hub.test")))],
        )
        .unwrap();
        write_runtime_slot_config(
            RuntimeSlot::Remote,
            &home,
            &[("version", Some(json!("0.1.1")))],
        )
        .unwrap();

        let stored = read_runtime_slot_config(RuntimeSlot::Remote, &home)
            .stored
            .unwrap();
        assert_eq!(stored["hubUrl"], json!("wss://hub.test"));
        assert_eq!(stored["version"], json!("0.1.1"));
    }

    #[test]
    fn writing_none_removes_a_previously_set_key() {
        let home = scratch_home("clear-key");
        write_runtime_slot_config(
            RuntimeSlot::Remote,
            &home,
            &[("hubUrl", Some(json!("wss://hub.test")))],
        )
        .unwrap();
        write_runtime_slot_config(RuntimeSlot::Remote, &home, &[("hubUrl", None)]).unwrap();

        let stored = read_runtime_slot_config(RuntimeSlot::Remote, &home)
            .stored
            .unwrap();
        assert!(stored.get("hubUrl").is_none());
    }

    #[test]
    fn a_write_reports_when_it_replaced_a_file_it_could_not_trust() {
        let home = scratch_home("replace-corrupt");
        let dir = slot_dir(RuntimeSlot::Host, &home);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("runtime.json"), b"{ not json").unwrap();

        let outcome = write_runtime_slot_config(
            RuntimeSlot::Host,
            &home,
            &[("version", Some(json!("0.2.0")))],
        )
        .unwrap();

        assert!(
            outcome
                .replaced_unusable
                .unwrap()
                .contains("not valid JSON")
        );
        let stored = read_runtime_slot_config(RuntimeSlot::Host, &home)
            .stored
            .unwrap();
        assert_eq!(stored["version"], json!("0.2.0"));
    }

    #[test]
    fn a_fresh_write_reports_no_replacement_when_nothing_was_there() {
        let home = scratch_home("no-replace");
        let outcome = write_runtime_slot_config(
            RuntimeSlot::Remote,
            &home,
            &[("version", Some(json!("0.1.0")))],
        )
        .unwrap();
        assert_eq!(outcome.replaced_unusable, None);
    }

    #[test]
    fn a_write_that_would_violate_the_schema_never_reaches_disk() {
        let home = scratch_home("schema-refuses-write");
        // `schemaVersion` and `slot` are always re-stamped by `merge_write`
        // itself (see `fixed`), so an update cannot smuggle a bad value
        // through those two keys — `digest` is a field the caller actually
        // controls, and its pattern is easy to violate.
        let error = write_runtime_slot_config(
            RuntimeSlot::Remote,
            &home,
            &[("digest", Some(json!("not-a-digest")))],
        )
        .expect_err("digest must match ^sha256:[a-f0-9]{64}$");
        assert!(matches!(error, WriteError::SchemaInvalid(_)));
        assert!(!slot_config_path(RuntimeSlot::Remote, &home).exists());
    }

    #[test]
    fn keeps_both_writers_fields_when_two_updates_race() {
        let home = scratch_home("race");
        let home_a = home.clone();
        let home_b = home.clone();

        let a = std::thread::spawn(move || {
            write_runtime_slot_config(
                RuntimeSlot::Remote,
                &home_a,
                &[("version", Some(json!("0.1.1")))],
            )
        });
        let b = std::thread::spawn(move || {
            write_runtime_slot_config(
                RuntimeSlot::Remote,
                &home_b,
                &[("hubUrl", Some(json!("wss://hub.test")))],
            )
        });
        a.join().unwrap().unwrap();
        b.join().unwrap().unwrap();

        let stored = read_runtime_slot_config(RuntimeSlot::Remote, &home)
            .stored
            .unwrap();
        assert_eq!(stored["version"], json!("0.1.1"));
        assert_eq!(stored["hubUrl"], json!("wss://hub.test"));
    }

    #[test]
    fn credentials_are_written_bytes_and_schema_only_and_kept_out_of_runtime_json() {
        let home = scratch_home("credentials");
        let (outcome, restricted) = write_runtime_slot_credentials(
            RuntimeSlot::Remote,
            &home,
            &[("pairingToken", Some(json!("mrt_x")))],
        )
        .unwrap();
        assert_eq!(outcome.replaced_unusable, None);

        let stored = read_runtime_slot_credentials(RuntimeSlot::Remote, &home)
            .stored
            .unwrap();
        assert_eq!(stored["pairingToken"], json!("mrt_x"));

        #[cfg(unix)]
        assert!(
            restricted,
            "chmod 0600 should succeed on a freshly written file on Unix"
        );
        #[cfg(not(unix))]
        let _ = restricted;

        let config_state = read_runtime_slot_config(RuntimeSlot::Remote, &home);
        assert_eq!(
            config_state.stored, None,
            "writing credentials must never touch runtime.json"
        );
    }

    #[test]
    fn credentials_merge_keeps_the_other_token_across_a_rotation() {
        let home = scratch_home("credentials-merge");
        write_runtime_slot_credentials(
            RuntimeSlot::Remote,
            &home,
            &[("pairingToken", Some(json!("first")))],
        )
        .unwrap();
        write_runtime_slot_credentials(
            RuntimeSlot::Remote,
            &home,
            &[("serveToken", Some(json!("serve")))],
        )
        .unwrap();
        write_runtime_slot_credentials(
            RuntimeSlot::Remote,
            &home,
            &[("pairingToken", Some(json!("second")))],
        )
        .unwrap();

        let stored = read_runtime_slot_credentials(RuntimeSlot::Remote, &home)
            .stored
            .unwrap();
        assert_eq!(stored["pairingToken"], json!("second"));
        assert_eq!(stored["serveToken"], json!("serve"));
    }

    #[test]
    fn unrelated_fields_a_newer_runtime_wrote_are_ignored_not_fatal() {
        let home = scratch_home("forward-compat");
        let dir = slot_dir(RuntimeSlot::Wsl, &home);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("runtime.json"),
            serde_json::to_vec(&Value::Object(
                [
                    ("schemaVersion".to_string(), json!(1)),
                    ("slot".to_string(), json!("wsl")),
                    (
                        "somethingNewerWrote".to_string(),
                        json!("from a later release"),
                    ),
                ]
                .into_iter()
                .collect(),
            ))
            .unwrap(),
        )
        .unwrap();

        let state = read_runtime_slot_config(RuntimeSlot::Wsl, &home);
        assert_eq!(state.error, None);
        assert!(state.stored.is_some());
    }
}
