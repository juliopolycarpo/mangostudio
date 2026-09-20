//! The runtime-home layout: `~/.mango/runtime/<slot>/…`.
//!
//! Mirrors `apps/runtime/src/runtime-home.ts` (the disk-touching half) and
//! `apps/shared/src/runtime-home/paths.ts` (the pure path arithmetic).
//! Every name below is taken from
//! `mangostudio_runtime_contract::strings::runtime_home` — never hand-typed
//! — and every shape read from or written to disk is checked against
//! `mangostudio_runtime_contract::schemas::validate_runtime_home`, the same
//! validator the dispatcher and the TypeScript side both build from
//! `runtime-home.schema.json`.
//!
//! # What this module does not do
//!
//! It reads and writes `runtime.json` and `credentials.json` as
//! schema-checked JSON `Value`s, merged shallowly under a lock. It does
//! **not** resolve consent: `RUNTIME_CONSENT_PRESETS`, `profileForAllow`,
//! and the fully-merged `ResolvedRuntimeSlotConfig` in
//! `apps/shared/src/runtime-home/consent.ts` are capability policy, owned
//! by whichever layer also owns the consent gate and audit log. The one
//! piece of that policy this module does need — which slots start
//! pre-consented — is [`DefaultSetupState`], because a caller reading an
//! absent or unusable `runtime.json` has to know which default it fell
//! back to; the module stops there and hands the rest to whoever resolves
//! capabilities.
//!
//! # Credentials: refuse, don't replace, when the file might carry
//! # something newer
//!
//! `credentials.json` gets one rule `runtime.json` does not:
//! [`write_runtime_slot_credentials`] refuses to touch a file it cannot
//! read at all, or one that names a `schemaVersion` newer than this build
//! speaks — see [`WriteError::Refused`] — instead of replacing it the way
//! [`write_runtime_slot_config`] replaces an unusable `runtime.json`.
//! Mirrors `readRuntimeSlotCredentialsState`'s `refused` outcome in
//! `runtime-home.ts`: a build that cannot see what a newer schema version
//! carries must not silently downgrade the file to the one it understands.
//! Every other unusable shape (missing, corrupt JSON, a wrong-typed token
//! at the schema version this build knows) is still replaced, matching
//! that same function's `replaceable` outcome. Judging whether a *value*
//! (a token's shape, its liveness) looks acceptable is still out of
//! scope — this module only distinguishes "safe to overwrite" from
//! "not for this build to decide" at the schema-version level.

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

/// The mode `credentials.json` is created with on Unix, mirroring
/// `runtime-home.ts`'s `OWNER_ONLY`. Applied at `open(2)` via
/// [`atomic::write_new_file`], never `chmod`ed on afterwards — see that
/// function's doc comment for why a post-create `chmod` leaves a window
/// this does not.
const OWNER_ONLY_MODE: u32 = 0o600;

/// The only `credentials.json` shape this build reads or writes, mirroring
/// `runtime-home.ts`'s own `CREDENTIALS_SCHEMA_VERSION`. A stored
/// `schemaVersion` other than this is a build this one does not understand
/// — see [`credentials_write_gate`].
const CREDENTIALS_SCHEMA_VERSION: u32 = 1;

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
/// A `Result`, not a panic: unlike `os.homedir()` throwing into a
/// JavaScript caller that can catch it, a panic here has no such catcher,
/// and a `remote` slot is routinely a service account — exactly the case
/// most likely to have neither a password-database entry nor `HOME`/
/// `USERPROFILE` set. `readRuntimeSlotState` already models "could not
/// resolve" as data on its result rather than an exception; this follows
/// the same shape instead of being the one path in this crate a caller
/// cannot recover from.
///
/// # Errors
/// When `MANGO_HOME` was not the caller's override and the platform cannot
/// resolve a home directory either. The message names all three places a
/// value could have come from — `MANGO_HOME`, `HOME`, `USERPROFILE` — since
/// this is the point a caller has nothing else to check.
pub fn home_dir() -> std::io::Result<PathBuf> {
    std::env::home_dir().ok_or_else(|| {
        std::io::Error::other(
            "could not resolve this account's home directory: MANGO_HOME is unset, and \
             neither HOME (Unix) nor USERPROFILE (Windows) named one either",
        )
    })
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
///
/// Uses `cfg!(windows)` — this platform, not a parameter — which is only
/// correct for a runtime describing paths on the machine it runs on.
/// `apps/shared/src/runtime-home/paths.ts`'s `runtimeBinaryName` takes the
/// platform as an argument instead, precisely because a *hub* builds paths
/// for a `wsl` slot it is provisioning from the outside, on a different
/// platform than its own. A future installer lane building paths for a
/// slot other than "the one this process is" needs that same parameter,
/// not this function.
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

/// Why a stored document could not be trusted, naming both the path and
/// the underlying cause so a caller can match on the failure mode rather
/// than parsing a message.
#[derive(Debug)]
pub enum SlotFileError {
    /// Present but this process could not read it: a permissions failure,
    /// or a directory sitting where the file belongs (`EISDIR` and kin).
    Unreadable {
        /// The file this process tried and failed to read.
        path: PathBuf,
        /// The underlying I/O failure.
        source: std::io::Error,
    },
    /// Present and readable, but not valid JSON.
    Malformed {
        /// The file whose contents did not parse as JSON.
        path: PathBuf,
        /// The underlying parse failure.
        source: serde_json::Error,
    },
    /// Valid JSON, but refused by `validate_runtime_home`.
    SchemaInvalid {
        /// The file whose contents failed schema validation.
        path: PathBuf,
        /// Which part of the schema rejected it.
        source: Violation,
    },
}

impl std::fmt::Display for SlotFileError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SlotFileError::Unreadable { path, source } => {
                write!(
                    formatter,
                    "{} could not be read ({source}).",
                    path.display()
                )
            }
            SlotFileError::Malformed { path, source } => {
                write!(
                    formatter,
                    "{} is not valid JSON ({source}).",
                    path.display()
                )
            }
            SlotFileError::SchemaInvalid { path, source } => {
                write!(
                    formatter,
                    "{} does not match the runtime-home schema ({source}).",
                    path.display()
                )
            }
        }
    }
}

impl std::error::Error for SlotFileError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            SlotFileError::Unreadable { source, .. } => Some(source),
            SlotFileError::Malformed { source, .. } => Some(source),
            SlotFileError::SchemaInvalid { source, .. } => Some(source),
        }
    }
}

/// What was on disk at `path`, or why it could not be trusted.
///
/// Mirrors the `{ stored, error }` half of `RuntimeSlotState` in
/// `runtime-home.ts` (the `config` field — the fully-resolved,
/// default-filled shape — is the consent-policy half this crate does not
/// build; see the module docs).
#[derive(Debug, Default)]
pub struct SlotFileState {
    /// The file exactly as stored and schema-checked, or `None` when there
    /// was none, or when what was there could not be trusted (see
    /// `error`).
    pub stored: Option<Value>,
    /// Set when a file was present but unusable. A caller must not read
    /// `stored: None` here the same way it reads a genuine absence — for
    /// `host` and `wsl`, [`default_setup_state_for_slot`] is `Configured`,
    /// and treating an unreadable file as if it had never existed would
    /// silently widen what that slot allows. `None` here (alongside
    /// `stored: None`) is the one case that really is absence.
    pub error: Option<SlotFileError>,
}

/// What was on disk at a path, before any schema opinion is formed about
/// it — the one read [`read_schema_checked`] and [`credentials_write_gate`]
/// must each perform exactly once and agree on, so a credentials write
/// never judges the file it is about to merge over from a different read
/// than the one that decided it was safe to.
enum RawDocument {
    /// `NotFound`, or `NotADirectory` from a path component that cannot
    /// hold a file — not an error, since most slots never have one.
    Absent,
    /// A permissions failure or a directory sitting where the file
    /// belongs: read, not parsed.
    Unreadable(std::io::Error),
    /// Read, but not JSON.
    Malformed(serde_json::Error),
    /// Read and parsed, schema opinion still pending.
    Parsed(Value),
}

fn read_raw_document(path: &Path) -> RawDocument {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
            ) =>
        {
            return RawDocument::Absent;
        }
        Err(error) => return RawDocument::Unreadable(error),
    };

    match serde_json::from_str(&raw) {
        Ok(value) => RawDocument::Parsed(value),
        Err(error) => RawDocument::Malformed(error),
    }
}

/// Reads and schema-checks the document at `path`.
///
/// Absence is not an error — most slots never have a file — but anything
/// else is: a permissions failure, a directory sitting where the file
/// belongs, malformed JSON, or a value the schema refuses. Every one of
/// those travels on [`SlotFileState::error`] rather than merging over a
/// default or rewriting the file, matching `readRuntimeSlotState` in
/// `runtime-home.ts`.
fn read_schema_checked(path: &Path, document: RuntimeHomeDocument) -> SlotFileState {
    match read_raw_document(path) {
        RawDocument::Absent => SlotFileState::default(),
        RawDocument::Unreadable(error) => SlotFileState {
            stored: None,
            error: Some(SlotFileError::Unreadable {
                path: path.to_path_buf(),
                source: error,
            }),
        },
        RawDocument::Malformed(error) => SlotFileState {
            stored: None,
            error: Some(SlotFileError::Malformed {
                path: path.to_path_buf(),
                source: error,
            }),
        },
        RawDocument::Parsed(value) => match validate_runtime_home(document, &value) {
            Ok(()) => SlotFileState {
                stored: Some(value),
                error: None,
            },
            Err(violation) => SlotFileState {
                stored: None,
                error: Some(SlotFileError::SchemaInvalid {
                    path: path.to_path_buf(),
                    source: violation,
                }),
            },
        },
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
    /// [`write_runtime_slot_credentials`] refused to touch the existing
    /// file: it could not be read at all, or it names a `schemaVersion`
    /// this build does not speak. The file is untouched — mirrors
    /// `RuntimeCredentialsRefusedError` in `runtime-home.ts`. Never
    /// returned by [`write_runtime_slot_config`]: an unusable
    /// `runtime.json` is still replaced, matching the TypeScript side.
    Refused {
        /// The file this write refused to replace.
        path: PathBuf,
        /// Why: names the path again (a caller may log this alone) and the
        /// specific reason, but never a token value.
        reason: String,
    },
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
            WriteError::Refused { reason, .. } => write!(formatter, "{reason}"),
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
            WriteError::Refused { .. } => None,
        }
    }
}

/// What a merged write did to what was there before.
#[derive(Debug)]
pub struct WriteOutcome {
    /// Set when the previous file was present but unusable (not the schema,
    /// not JSON, not readable) and this write replaced it outright rather
    /// than merging on top of it — the one case `runtime-home.ts`'s own
    /// `readStoredRuntimeSlotConfig` handles the same way but never reports:
    /// its comment says "a file this process cannot parse is one this write
    /// replaces", and the caller never learns that happened. This field is
    /// the difference: the replacement still happens (refusing to write
    /// would leave the slot permanently stuck), but it is never silent.
    ///
    /// For `credentials.json` this can now only ever be
    /// [`SlotFileError::Malformed`] or a [`SlotFileError::SchemaInvalid`]
    /// that is not a `schemaVersion` mismatch: the two reasons that would
    /// otherwise land here are intercepted earlier and returned as
    /// [`WriteError::Refused`] instead, before this write ever runs.
    pub replaced_unusable: Option<SlotFileError>,
}

/// Reads `path` as an object (or starts a fresh one, when absent or
/// unusable), applies `update` (a key set to `None` is removed — the merge
/// equivalent of `runtime-home.ts`'s `stripUndefined`), stamps every pair
/// in `fixed`, validates the result, and publishes it atomically.
///
/// `mode` is threaded straight through to [`atomic::write_new_file`] so a
/// secret-bearing document (`credentials.json`) is opened owner-only at
/// *creation* rather than tightened after the fact: `write_temp_file`'s own
/// doc comment explains why a post-publish `chmod` would leave a window a
/// pre-set `mode` does not.
///
/// `pub(crate)`, not private: [`crate::consent::invocation`] needs to read,
/// decide, and write `runtime.json` inside the *same* [`lock::with_slot_lock`]
/// call — a decision taken from one read must publish from that read, never
/// a second one that could observe a concurrent writer's change in between —
/// so it calls this directly rather than going through
/// [`write_runtime_slot_config`], which takes its own lock and would
/// deadlock (the lock file has no re-entrant acquire) if called from inside
/// a closure already holding it.
pub(crate) fn merge_write(
    path: &Path,
    document: RuntimeHomeDocument,
    fixed: &[(&'static str, Value)],
    update: &[(&str, Option<Value>)],
    mode: Option<u32>,
) -> Result<WriteOutcome, WriteError> {
    let state = read_schema_checked(path, document);
    merge_write_from_state(path, document, state, fixed, update, mode)
}

/// [`merge_write`] over an already-read [`SlotFileState`], for a caller
/// (`write_runtime_slot_credentials_with`) that must gate on that exact
/// read rather than let this function take its own, independent one: a
/// second read here could observe the file in a different state than the
/// one the gate approved, and then merge over *that* — silently discarding
/// whatever the gate's read saw and the update did not mention.
fn merge_write_from_state(
    path: &Path,
    document: RuntimeHomeDocument,
    state: SlotFileState,
    fixed: &[(&'static str, Value)],
    update: &[(&str, Option<Value>)],
    mode: Option<u32>,
) -> Result<WriteOutcome, WriteError> {
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
    atomic::write_new_file(path, &bytes, mode).map_err(WriteError::Io)?;

    Ok(WriteOutcome {
        replaced_unusable: state.error,
    })
}

/// The file's `schemaVersion`, but only when it is a number this build does
/// not speak. `None` for everything else — a document whose only problem is
/// a wrong-shaped token, a document with no `schemaVersion` at all, and a
/// document that is not an object — mirroring
/// `unsupportedCredentialsSchemaVersion` in `runtime-home.ts` exactly: that
/// function reads `typeof version === 'number'`, which JSON's single
/// number type makes `as_f64` the faithful Rust equivalent of, rather than
/// `as_u64`/`as_i64`, either of which would call a fractional or negative
/// `schemaVersion` "not a number".
fn unsupported_credentials_schema_version(parsed: &Value) -> Option<f64> {
    let version = parsed.as_object()?.get("schemaVersion")?.as_f64()?;
    (version != f64::from(CREDENTIALS_SCHEMA_VERSION)).then_some(version)
}

/// Whether an existing `credentials.json` may be replaced outright, or must
/// be refused instead.
enum CredentialsWriteGate {
    /// Absent, fully valid, or unusable in a way a rewrite may repair
    /// (corrupt JSON, or a schema violation that is not a version
    /// mismatch). Carries the exact read this decision was made from, so
    /// [`merge_write_from_state`] merges over what the gate actually saw
    /// rather than reading the file again and risking a different answer.
    Proceed(SlotFileState),
    /// This process cannot see what a replace would destroy: the file
    /// could not be read at all, or it names a `schemaVersion` this build
    /// does not speak. Carries the message for [`WriteError::Refused`].
    Refuse(String),
}

/// Inspects `path` before a credentials write touches it, mirroring the
/// `refused` half of `readRuntimeSlotCredentialsState` in
/// `runtime-home.ts`. The single read this and the eventual merge both
/// need — `runtime-home.ts` reads `credentials.json` through two separate
/// functions for a different reason (`readRuntimeSlotCredentialsState` and
/// the merge inside `writeCredentials` answer genuinely separate
/// questions there), but on the Rust side both questions are answered from
/// this one read: a second, independent read here would let the file
/// change underneath the decision this makes, between this call and the
/// merge that trusts it.
fn credentials_write_gate(path: &Path) -> CredentialsWriteGate {
    match read_raw_document(path) {
        RawDocument::Absent => CredentialsWriteGate::Proceed(SlotFileState::default()),
        RawDocument::Unreadable(error) => {
            CredentialsWriteGate::Refuse(format!("{} could not be read ({error}).", path.display()))
        }
        RawDocument::Malformed(error) => CredentialsWriteGate::Proceed(SlotFileState {
            stored: None,
            error: Some(SlotFileError::Malformed {
                path: path.to_path_buf(),
                source: error,
            }),
        }),
        RawDocument::Parsed(value) => {
            match validate_runtime_home(RuntimeHomeDocument::Credentials, &value) {
                Ok(()) => CredentialsWriteGate::Proceed(SlotFileState {
                    stored: Some(value),
                    error: None,
                }),
                Err(violation) => match unsupported_credentials_schema_version(&value) {
                    Some(version) => CredentialsWriteGate::Refuse(format!(
                        "{} is schemaVersion {version}, which this build of the runtime does not understand.",
                        path.display()
                    )),
                    None => CredentialsWriteGate::Proceed(SlotFileState {
                        stored: None,
                        error: Some(SlotFileError::SchemaInvalid {
                            path: path.to_path_buf(),
                            source: violation,
                        }),
                    }),
                },
            }
        }
    }
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
        merge_write(&path, RuntimeHomeDocument::SlotConfig, &fixed, update, None)
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
    write_runtime_slot_credentials_with(slot, mango_home, update, owner_only::restrict_to_owner)
}

/// Generates a fresh `serveToken` credential and stores it, mirroring
/// `runtime-home.ts`'s `bootstrapServeToken`: 32 bytes from the operating
/// system's CSPRNG, base64url-encoded (matching Node's
/// `Buffer#toString('base64url')` — unpadded, `+`/`/` replaced by `-`/`_`),
/// written through [`write_runtime_slot_credentials`] so it gets the exact
/// same owner-only handling any other credential does.
///
/// Called once, the moment `serve` finds no token anywhere else to use — see
/// `crate::cli`'s token resolution — never regenerated on top of an existing
/// one, the same way `resolveServeToken` only reaches this after every other
/// source came back empty.
///
/// # Errors
/// See [`WriteError`].
///
/// # Panics
/// If the operating system's random source is unavailable. A serve token is
/// a bearer credential; a caller here needs a hard failure, never a silently
/// weaker fallback.
pub fn bootstrap_serve_token(
    slot: RuntimeSlot,
    mango_home: &Path,
) -> Result<(String, bool), WriteError> {
    let token = generate_serve_token();
    let (_, restricted) = write_runtime_slot_credentials(
        slot,
        mango_home,
        &[("serveToken", Some(Value::String(token.clone())))],
    )?;
    Ok((token, restricted))
}

/// 32 CSPRNG bytes, base64url (no padding) encoded.
fn generate_serve_token() -> String {
    use base64::Engine as _;
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("the operating system's CSPRNG must be available");
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// [`write_runtime_slot_credentials`] with an injectable `restrict` step, so
/// a test can observe the file's state *before* re-restricting it rather
/// than only after — the two are indistinguishable from the outside once
/// `restrict` has actually run, which is exactly what makes the real
/// `restrict_to_owner` unsuitable for proving `mode` was already applied at
/// creation.
fn write_runtime_slot_credentials_with(
    slot: RuntimeSlot,
    mango_home: &Path,
    update: &[(&str, Option<Value>)],
    restrict: impl Fn(&Path) -> bool,
) -> Result<(WriteOutcome, bool), WriteError> {
    let path = slot_credentials_path(slot, mango_home);
    let lock_path = slot_credentials_lock_path(slot, mango_home);
    let fixed: [(&'static str, Value); 1] =
        [("schemaVersion", Value::from(CREDENTIALS_SCHEMA_VERSION))];
    lock::with_slot_lock(&lock_path, &lock::LockPolicy::default(), || {
        // Checked under the same lock a repair would need anyway.
        // `credentials_write_gate` performs the one read this decision and
        // the merge below both need; see its own doc comment for why
        // reading again here would defeat it.
        let state = match credentials_write_gate(&path) {
            CredentialsWriteGate::Refuse(reason) => {
                return Err(WriteError::Refused {
                    path: path.clone(),
                    reason,
                });
            }
            CredentialsWriteGate::Proceed(state) => state,
        };
        // `Some(OWNER_ONLY_MODE)`, not `None`: opened owner-only at creation
        // (see `merge_write`'s doc comment), with `restrict` below as the
        // belt-and-braces re-assertion `runtime-home.ts` also runs after
        // every write — and the only mechanism at all on Windows, where a
        // Unix file mode does nothing.
        let outcome = merge_write_from_state(
            &path,
            RuntimeHomeDocument::Credentials,
            state,
            &fixed,
            update,
            Some(OWNER_ONLY_MODE),
        )?;
        Ok((outcome, restrict(&path)))
    })
    .map_err(WriteError::Lock)?
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use mangostudio_runtime_contract::strings::runtime_home::SLOTS;
    use serde_json::{Value, json};

    use super::{
        CredentialsWriteGate, DefaultSetupState, RuntimeHomeDocument, RuntimeSlot, SlotFileError,
        WriteError, bootstrap_serve_token, credentials_write_gate, default_setup_state_for_slot,
        home_dir, merge_write_from_state, read_runtime_slot_config, read_runtime_slot_credentials,
        resolve_runtime_slot, slot_config_path, slot_credentials_path, slot_current_binary_path,
        slot_dir, slot_for_path, write_runtime_slot_config, write_runtime_slot_credentials,
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
        // does not second-guess; the contract is only that it answers, on
        // a machine that has an account to resolve at all — which every
        // machine this test runs on does.
        assert!(!home_dir().unwrap().as_os_str().is_empty());
    }

    #[test]
    fn reading_an_absent_config_reports_no_error_and_nothing_stored() {
        let home = scratch_home("absent");
        let state = read_runtime_slot_config(RuntimeSlot::Remote, &home);
        assert_eq!(state.stored, None);
        assert!(state.error.is_none());
    }

    #[test]
    fn reading_malformed_json_reports_a_typed_error_not_absence() {
        let home = scratch_home("malformed");
        let dir = slot_dir(RuntimeSlot::Host, &home);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("runtime.json"), b"{ not json").unwrap();

        let state = read_runtime_slot_config(RuntimeSlot::Host, &home);
        assert_eq!(state.stored, None);
        let error = state.error.unwrap();
        assert!(matches!(error, SlotFileError::Malformed { .. }));
        assert!(error.to_string().contains("not valid JSON"));
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
        let error = state.error.unwrap();
        assert!(matches!(error, SlotFileError::SchemaInvalid { .. }));
        assert!(
            error
                .to_string()
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
        let error = state.error.unwrap();
        assert!(matches!(error, SlotFileError::Unreadable { .. }));
        assert!(error.to_string().contains("could not be read"));
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

        let replaced = outcome.replaced_unusable.unwrap();
        assert!(matches!(replaced, SlotFileError::Malformed { .. }));
        assert!(replaced.to_string().contains("not valid JSON"));
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
        assert!(outcome.replaced_unusable.is_none());
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
        assert!(outcome.replaced_unusable.is_none());

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

    #[cfg(unix)]
    #[test]
    fn credentials_json_is_opened_owner_only_at_creation_not_chmoded_on_afterwards() {
        use std::cell::Cell;
        use std::os::unix::fs::PermissionsExt as _;

        use super::write_runtime_slot_credentials_with;

        // The regression this guards: `merge_write` for `credentials.json`
        // could pass `mode: None` and rely on `restrict_to_owner` running
        // afterwards to close the gap. That would leave the file briefly
        // (and, on a filesystem where the publishing rename and a `chmod`
        // are not atomic together, not so briefly) world- or
        // group-readable with a live token in it.
        //
        // Asserting the mode *after* `write_runtime_slot_credentials`
        // returns does not tell that apart from a correct implementation:
        // the real `restrict_to_owner` always runs before the call returns
        // and always leaves the file at 0600 on success, whichever mode it
        // started at. So this test replaces `restrict_to_owner` with a
        // recorder that captures the mode the instant it is invoked — after
        // `merge_write` has published the file, before anything re-restricts
        // it — which is the one observation point where "opened owner-only
        // at creation" and "opened loose, then chmodded" actually disagree.
        let home = scratch_home("credentials-mode-at-creation");
        let recorded_mode: Cell<Option<u32>> = Cell::new(None);

        write_runtime_slot_credentials_with(
            RuntimeSlot::Remote,
            &home,
            &[("pairingToken", Some(json!("mrt_mode_check")))],
            |path| {
                let mode = std::fs::metadata(path).unwrap().permissions().mode();
                recorded_mode.set(Some(mode & 0o777));
                true
            },
        )
        .unwrap();

        assert_eq!(recorded_mode.get(), Some(0o600));
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
    fn a_credentials_merge_uses_the_gates_own_snapshot_not_a_fresh_read() {
        // The regression this guards: `credentials_write_gate` and the
        // merge it approves used to read `credentials.json` independently.
        // If the file changed between those two reads — another process's
        // write racing this one, outside the lock this crate controls, or
        // simply a filesystem this process does not have exclusive control
        // over — the merge would silently build over whatever the *second*
        // read saw instead of the snapshot the gate actually approved,
        // discarding any credential the update did not mention.
        let home = scratch_home("credentials-toctou");
        let path = slot_credentials_path(RuntimeSlot::Remote, &home);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            br#"{"schemaVersion":1,"pairingToken":"keep-me","serveToken":"also-keep-me"}"#,
        )
        .unwrap();

        let state = match credentials_write_gate(&path) {
            CredentialsWriteGate::Proceed(state) => state,
            CredentialsWriteGate::Refuse(reason) => {
                panic!("expected the gate to proceed on a valid file, got Refuse({reason})")
            }
        };

        // Simulate the file changing after the gate's read but before the
        // merge — a schemaVersion this build refuses outright, so a fresh
        // second read would refuse to see `serveToken` at all.
        std::fs::write(&path, br#"{"schemaVersion":999}"#).unwrap();

        let fixed: [(&'static str, Value); 1] = [("schemaVersion", Value::from(1))];
        merge_write_from_state(
            &path,
            RuntimeHomeDocument::Credentials,
            state,
            &fixed,
            &[("pairingToken", Some(json!("rotated")))],
            Some(0o600),
        )
        .unwrap();

        let published: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(published["pairingToken"], json!("rotated"));
        assert_eq!(
            published["serveToken"],
            json!("also-keep-me"),
            "the merge must reuse the gate's snapshot, not re-read the file the gate approved"
        );
    }

    #[test]
    fn a_future_credentials_schema_version_is_refused_not_replaced() {
        // The row #1078 added on the TypeScript side: a `credentials.json`
        // naming a `schemaVersion` this build does not speak carries fields
        // (here, a pairing token and one this build has never heard of)
        // that a silent replace would destroy without this process ever
        // having seen them. `merge_write`'s general "replace what cannot be
        // trusted" rule is correct for `runtime.json`; it is wrong here.
        let home = scratch_home("future-schema-version");
        let dir = slot_dir(RuntimeSlot::Remote, &home);
        std::fs::create_dir_all(&dir).unwrap();
        let raw = br#"{"schemaVersion":2,"pairingToken":"keep-me","futureOnly":"precious"}"#;
        std::fs::write(dir.join("credentials.json"), raw).unwrap();

        let error = write_runtime_slot_credentials(
            RuntimeSlot::Remote,
            &home,
            &[("serveToken", Some(json!("new")))],
        )
        .expect_err("schemaVersion 2 is newer than this build speaks");
        assert!(matches!(error, WriteError::Refused { .. }));

        // Untouched: still exactly the bytes this test wrote, not a
        // downgrade to `{"schemaVersion":1,"serveToken":"new"}`.
        let after = std::fs::read(dir.join("credentials.json")).unwrap();
        assert_eq!(after, raw);
    }

    #[cfg(unix)]
    #[test]
    fn an_unreadable_credentials_file_is_refused_not_replaced() {
        use std::os::unix::fs::PermissionsExt as _;

        let home = scratch_home("unreadable-credentials");
        let dir = slot_dir(RuntimeSlot::Remote, &home);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("credentials.json");
        let raw = br#"{"schemaVersion":1,"pairingToken":"keep-me"}"#;
        std::fs::write(&path, raw).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();

        let error = write_runtime_slot_credentials(
            RuntimeSlot::Remote,
            &home,
            &[("serveToken", Some(json!("new")))],
        )
        .expect_err("this process cannot read the file, so it cannot rule out destroying it");
        assert!(matches!(error, WriteError::Refused { .. }));

        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        let after = std::fs::read(&path).unwrap();
        assert_eq!(after, raw);
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
        assert!(state.error.is_none());
        assert!(state.stored.is_some());
    }

    #[test]
    fn bootstrap_serve_token_generates_32_random_bytes_of_base64url_with_no_padding() {
        let home = scratch_home("bootstrap-serve-token");
        let (token, _restricted) = bootstrap_serve_token(RuntimeSlot::Remote, &home).unwrap();

        // 32 bytes of base64url, unpadded: ceil(32 * 4 / 3) = 43 characters.
        assert_eq!(token.len(), 43, "{token}");
        assert!(
            token
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'),
            "expected only the base64url alphabet, got {token:?}"
        );
        assert!(!token.contains('='), "base64url here must not be padded");
        assert!(!token.contains('+'), "base64url replaces + with -");
        assert!(!token.contains('/'), "base64url replaces / with _");
    }

    #[test]
    fn bootstrap_serve_token_never_repeats_across_calls() {
        let home = scratch_home("bootstrap-serve-token-unique");
        let (first, _) = bootstrap_serve_token(RuntimeSlot::Remote, &home).unwrap();
        let (second, _) = bootstrap_serve_token(RuntimeSlot::Remote, &home).unwrap();
        assert_ne!(first, second);
    }

    #[test]
    fn bootstrap_serve_token_persists_through_the_credentials_writer() {
        let home = scratch_home("bootstrap-serve-token-persist");
        let (token, _) = bootstrap_serve_token(RuntimeSlot::Remote, &home).unwrap();

        let stored = read_runtime_slot_credentials(RuntimeSlot::Remote, &home)
            .stored
            .expect("bootstrap_serve_token must have written credentials.json");
        assert_eq!(stored["serveToken"], json!(token));
    }
}
