//! The backup store: recoverable copies of everything an apply replaced or a
//! removal took, plus the manifest that makes the change reversible — a port
//! of `apps/shared/src/library/machine/backup-store.ts`.
//!
//! # On-disk format (shared with the TypeScript runtime)
//!
//! ```text
//! <backupRoot>/<backupId>/manifest.json
//! <backupRoot>/<backupId>/<locationId>/<slug>      a file or a directory tree
//! ```
//!
//! `backupId` is `toISOString()` with `:` replaced by `-`, a `-`, and sixteen
//! hex characters. `manifest.json` is `JSON.stringify(manifest, null, 2)`
//! plus a newline, versions 1–3 are all read, and every validation rule of
//! `isManifest` is reproduced over the raw JSON (so a `null` where a field
//! must be absent or typed rejects the manifest exactly as TypeScript does).
//! Paths inside a manifest are absolute strings in the host's native
//! spelling. Either runtime reads a set the other wrote.
//!
//! # Retention, and the one deliberate difference
//!
//! Retention keeps the newest sets within a count and a byte budget, pinned
//! sets (last copies) are kept unconditionally and charged first, and the
//! set an apply just wrote is never evicted by that apply. A listing reports
//! the same decision as `evictsNext` and never deletes anything.
//!
//! A set with no readable manifest is also kept unconditionally and
//! charged first here, where TypeScript would evict it. Such a set is either
//! still being written — by this process (its owner lock already keeps `gc`
//! out) or by another runtime sharing the same `~/.mango/library-backups` —
//! or it is what a failed commit left behind, whose message names it as the
//! only copy of what was overwritten. Neither is something retention may
//! take on its own; an explicit `purgeBackupIds` request still can.

use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;

use serde_json::{Map, Value, json};

use super::super::collation::locale_compare;
use super::disk::{CopyPurpose, EntryType, MutationFs};
use super::paths::{ResourceKind, fs_path, node_basename, node_dirname, node_join};
use crate::probing::locations::location_by_id;

/// `DEFAULT_RETENTION_COUNT`.
pub(crate) const DEFAULT_RETENTION_COUNT: f64 = 10.0;
/// `DEFAULT_RETENTION_BYTES`: 512 MiB.
pub(crate) const DEFAULT_RETENTION_BYTES: f64 = 512.0 * 1024.0 * 1024.0;
const MANIFEST_NAME: &str = "manifest.json";
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// Which flow wrote a set. `unknown` is only ever a listing answer for a
/// manifest that predates the field.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SetOperation {
    Propagation,
    Removal,
}

impl SetOperation {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Propagation => "propagation",
            Self::Removal => "removal",
        }
    }
}

/// `BackupEntry`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct BackupEntry {
    pub location_id: String,
    pub slug: String,
    pub kind: ResourceKind,
    /// The path as the registry names it, for display.
    pub destination_path: String,
    /// Where the write actually landed, after symlink resolution.
    pub resolved_path: String,
    /// The pre-write copy; absent when the apply created the path.
    pub backup_path: Option<String>,
    /// What the apply wrote (or the removal took), so undo can tell whether
    /// anything moved since.
    pub written_content_hash: String,
    /// Manifest v2: the resource the entry belongs to.
    pub resource_key: Option<String>,
}

/// `BackupManifest`.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct BackupManifest {
    pub version: u8,
    pub backup_id: String,
    pub created_at_ms: f64,
    pub entries: Vec<BackupEntry>,
    pub operation: Option<SetOperation>,
    pub environment_id: Option<String>,
    pub pinned: Option<bool>,
    pub last_copy_resource_keys: Option<Vec<String>>,
}

impl BackupManifest {
    /// The manifest as TypeScript writes it, member order included.
    pub(crate) fn to_json(&self) -> Ordered {
        let mut out = vec![
            ("version", Ordered::scalar(json!(self.version))),
            ("backupId", Ordered::scalar(json!(self.backup_id))),
            ("createdAtMs", Ordered::scalar(number(self.created_at_ms))),
            (
                "entries",
                Ordered::Array(
                    self.entries
                        .iter()
                        .map(|entry| entry_json(entry, self.operation))
                        .collect(),
                ),
            ),
        ];
        if let Some(operation) = self.operation {
            out.push(("operation", Ordered::scalar(json!(operation.as_str()))));
        }
        if let Some(environment_id) = &self.environment_id {
            out.push(("environmentId", Ordered::scalar(json!(environment_id))));
        }
        if let Some(pinned) = self.pinned {
            out.push(("pinned", Ordered::scalar(json!(pinned))));
        }
        if let Some(keys) = &self.last_copy_resource_keys {
            out.push((
                "lastCopyResourceKeys",
                Ordered::Array(keys.iter().map(|key| Ordered::scalar(json!(key))).collect()),
            ));
        }
        Ordered::object(out)
    }

    /// `isManifest`, then the typed shape; `None` for anything it refuses.
    pub(crate) fn from_json(value: &Value) -> Option<Self> {
        let object = value.as_object()?;
        let version = match object.get("version").and_then(Value::as_f64) {
            Some(1.0) => 1,
            Some(2.0) => 2,
            Some(3.0) => 3,
            _ => return None,
        };
        let backup_id = object.get("backupId")?.as_str()?.to_string();
        let created_at_ms = object.get("createdAtMs")?.as_f64()?;
        let environment_id = optional(object, "environmentId", |value| {
            value.as_str().map(str::to_string)
        })?;
        let pinned = optional(object, "pinned", Value::as_bool)?;
        let operation = optional(object, "operation", |value| match value.as_str()? {
            "propagation" => Some(SetOperation::Propagation),
            "removal" => Some(SetOperation::Removal),
            _ => None,
        })?;
        let last_copy_resource_keys = optional(object, "lastCopyResourceKeys", |value| {
            value
                .as_array()?
                .iter()
                .map(|key| key.as_str().map(str::to_string))
                .collect()
        })?;
        let entries = object
            .get("entries")?
            .as_array()?
            .iter()
            .map(entry_from_json)
            .collect::<Option<Vec<_>>>()?;
        Some(Self {
            version,
            backup_id,
            created_at_ms,
            entries,
            operation,
            environment_id,
            pinned,
            last_copy_resource_keys,
        })
    }
}

/// A JSON number that is an integer when it can be, as `JSON.stringify`
/// prints one.
fn number(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() <= MAX_SAFE_INTEGER {
        return json!(value as i64);
    }
    json!(value)
}

/// `candidate.field === undefined || check(candidate.field)`: `Some(None)`
/// for an absent member, `Some(Some(value))` for a valid one, `None` (the
/// manifest is rejected) for any other value — `null` included.
fn optional<T>(
    object: &Map<String, Value>,
    key: &str,
    parse: impl Fn(&Value) -> Option<T>,
) -> Option<Option<T>> {
    match object.get(key) {
        None => Some(None),
        Some(value) => parse(value).map(Some),
    }
}

/// One entry, in the member order the flow that wrote it uses: the removal
/// engine records the copy before the resource key and hash, the
/// propagation engine after them.
fn entry_json(entry: &BackupEntry, operation: Option<SetOperation>) -> Ordered {
    let mut out = vec![
        ("locationId", Ordered::scalar(json!(entry.location_id))),
        ("slug", Ordered::scalar(json!(entry.slug))),
        ("kind", Ordered::scalar(json!(entry.kind.as_str()))),
        (
            "destinationPath",
            Ordered::scalar(json!(entry.destination_path)),
        ),
        ("resolvedPath", Ordered::scalar(json!(entry.resolved_path))),
    ];
    let backup_path = entry
        .backup_path
        .as_ref()
        .map(|path| ("backupPath", Ordered::scalar(json!(path))));
    let removal = operation == Some(SetOperation::Removal);
    if removal {
        out.extend(backup_path.clone());
    }
    let hash = (
        "writtenContentHash",
        Ordered::scalar(json!(entry.written_content_hash)),
    );
    let key = entry
        .resource_key
        .as_ref()
        .map(|key| ("resourceKey", Ordered::scalar(json!(key))));
    if removal {
        out.extend(key);
        out.push(hash);
    } else {
        out.push(hash);
        out.extend(key);
        out.extend(backup_path);
    }
    Ordered::object(out)
}

/// A JSON value whose object members keep insertion order, printed the way
/// `JSON.stringify(value, null, 2)` prints it. `serde_json`'s map sorts its
/// keys in this build, and a manifest is easier to compare across runtimes
/// when both write the same bytes.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Ordered {
    Scalar(Value),
    Array(Vec<Ordered>),
    Object(Vec<(String, Ordered)>),
}

impl Ordered {
    fn scalar(value: Value) -> Self {
        Self::Scalar(value)
    }

    fn object(members: Vec<(&str, Ordered)>) -> Self {
        Self::Object(
            members
                .into_iter()
                .map(|(key, value)| (key.to_string(), value))
                .collect(),
        )
    }

    /// Two-space indented text, no trailing newline.
    pub(crate) fn to_pretty(&self) -> String {
        let mut out = String::new();
        self.write(&mut out, 0);
        out
    }

    fn write(&self, out: &mut String, depth: usize) {
        let pad = |out: &mut String, depth: usize| out.push_str(&"  ".repeat(depth));
        match self {
            Self::Scalar(value) => out.push_str(&value.to_string()),
            Self::Array(items) if items.is_empty() => out.push_str("[]"),
            Self::Object(members) if members.is_empty() => out.push_str("{}"),
            Self::Array(items) => {
                out.push_str("[\n");
                for (index, item) in items.iter().enumerate() {
                    pad(out, depth + 1);
                    item.write(out, depth + 1);
                    out.push_str(if index + 1 < items.len() { ",\n" } else { "\n" });
                }
                pad(out, depth);
                out.push(']');
            }
            Self::Object(members) => {
                out.push_str("{\n");
                for (index, (key, value)) in members.iter().enumerate() {
                    pad(out, depth + 1);
                    out.push_str(&Value::String(key.clone()).to_string());
                    out.push_str(": ");
                    value.write(out, depth + 1);
                    out.push_str(if index + 1 < members.len() {
                        ",\n"
                    } else {
                        "\n"
                    });
                }
                pad(out, depth);
                out.push('}');
            }
        }
    }
}

/// `isBackupEntry`, then the typed shape.
fn entry_from_json(value: &Value) -> Option<BackupEntry> {
    let object = value.as_object()?;
    let text = |key: &str| object.get(key)?.as_str().map(str::to_string);
    Some(BackupEntry {
        location_id: text("locationId")?,
        slug: text("slug")?,
        kind: ResourceKind::parse(object.get("kind")?.as_str()?)?,
        destination_path: text("destinationPath")?,
        resolved_path: text("resolvedPath")?,
        written_content_hash: text("writtenContentHash")?,
        backup_path: optional(object, "backupPath", |value| {
            value.as_str().map(str::to_string)
        })?,
        resource_key: optional(object, "resourceKey", |value| {
            value.as_str().map(str::to_string)
        })?,
    })
}

/// Why a store operation failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum StoreError {
    /// `assertBackupId`'s `TypeError`: the id could leave the backup root.
    InvalidId(String),
    /// `pruneBackupSets`' `TypeError`: a count that keeps nothing.
    InvalidRetention,
    /// An I/O failure, described.
    Io(String),
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidId(id) => write!(formatter, "Invalid library backup id: \"{id}\"."),
            Self::InvalidRetention => {
                formatter.write_str("Library backup retention count must be a positive integer.")
            }
            Self::Io(message) => formatter.write_str(message),
        }
    }
}

fn io(error: std::io::Error) -> StoreError {
    StoreError::Io(error.to_string())
}

/// `BACKUP_ID_PATTERN`: one path segment that is never `.` or `..`.
#[must_use]
pub(crate) fn is_valid_backup_id(backup_id: &str) -> bool {
    let mut bytes = backup_id.bytes();
    let Some(first) = bytes.next() else {
        return false;
    };
    let allowed = |byte: u8| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-';
    allowed(first) && bytes.all(|byte| allowed(byte) || byte == b'.')
}

/// `new Date(ms).toISOString()`.
fn iso_string(epoch_ms: f64) -> String {
    let total_ms = epoch_ms.floor() as i64;
    let days = total_ms.div_euclid(86_400_000);
    let of_day = total_ms.rem_euclid(86_400_000);
    // Howard Hinnant's days-to-civil conversion.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        of_day / 3_600_000,
        of_day / 60_000 % 60,
        of_day / 1000 % 60,
        of_day % 1000
    )
}

/// The clock a store stamps sets with, in epoch milliseconds.
pub(crate) type Clock = Arc<dyn Fn() -> f64 + Send + Sync>;
/// The suffix source for set ids and staging siblings.
pub(crate) type Suffix = Arc<dyn Fn() -> String + Send + Sync>;

/// `BackupStoreDeps`: one caller-supplied root, never invented here.
#[derive(Clone)]
pub(crate) struct BackupStore {
    pub fs: Arc<dyn MutationFs>,
    pub root: String,
    pub platform: String,
    pub retention_count: f64,
    pub retention_bytes: f64,
    pub now_ms: Clock,
    pub random_suffix: Suffix,
}

/// One set as the store sees it on disk.
#[derive(Debug, Clone)]
struct SetOnDisk {
    id: String,
    path: String,
    modified_at_ms: f64,
    size_bytes: u64,
    manifest: Option<BackupManifest>,
}

impl SetOnDisk {
    fn pinned(&self) -> bool {
        self.manifest
            .as_ref()
            .is_some_and(|manifest| manifest.pinned == Some(true))
    }

    /// Kept by retention whatever the budget: see the module docs.
    fn retained_unconditionally(&self) -> bool {
        self.pinned() || self.manifest.is_none()
    }
}

/// `LibraryBackupSet`, the listing row.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackupSetRow {
    pub backup_id: String,
    pub created_at_ms: Value,
    pub size_bytes: u64,
    pub entry_count: usize,
    pub pinned: bool,
    pub last_copy_resource_keys: Vec<String>,
    pub operation: &'static str,
    pub resource_keys: Vec<String>,
    pub evicts_next: bool,
    pub manifest_readable: bool,
}

/// `collectBackupGarbage`'s answer.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
pub(crate) struct GcResult {
    pub purged: Vec<String>,
    pub pruned: Vec<String>,
}

impl BackupStore {
    /// `createBackupId`.
    pub(crate) fn create_backup_id(&self) -> String {
        format!(
            "{}-{}",
            iso_string((self.now_ms)()).replace(':', "-"),
            (self.random_suffix)()
        )
    }

    /// `backupSetPath`, refusing an id that could leave the root.
    pub(crate) fn set_path(&self, backup_id: &str) -> Result<String, StoreError> {
        if !is_valid_backup_id(backup_id) {
            return Err(StoreError::InvalidId(backup_id.to_string()));
        }
        Ok(node_join(&self.platform, &[&self.root, backup_id]))
    }

    /// `backupExistingResource`: copies what is at `resolved_path` to
    /// `<set>/<locationId>/<slug>` and answers where it went.
    pub(crate) fn backup_existing(
        &self,
        resolved_path: &str,
        location_id: &str,
        slug: &str,
        backup_id: &str,
    ) -> Result<String, StoreError> {
        let set = self.set_path(backup_id)?;
        let backup_path = node_join(&self.platform, &[&set, location_id, slug]);
        self.fs
            .create_dir_all(&fs_path(&node_dirname(&self.platform, &backup_path)))
            .map_err(io)?;
        self.fs
            .copy_tree(
                &fs_path(resolved_path),
                &fs_path(&backup_path),
                CopyPurpose::Backup,
            )
            .map_err(io)?;
        Ok(backup_path)
    }

    /// `writeBackupManifest`.
    pub(crate) fn write_manifest(&self, manifest: &BackupManifest) -> Result<(), StoreError> {
        let set = self.set_path(&manifest.backup_id)?;
        self.fs.create_dir_all(&fs_path(&set)).map_err(io)?;
        let text = manifest.to_json().to_pretty();
        self.fs
            .write_text(&Path::new(&set).join(MANIFEST_NAME), &format!("{text}\n"))
            .map_err(io)
    }

    /// `readBackupManifest`: `Ok(None)` for an absent or unparseable set,
    /// an error for an invalid id or an I/O failure other than "not found"
    /// (a permission error is not a retention-pruned set).
    pub(crate) fn read_manifest(
        &self,
        backup_id: &str,
    ) -> Result<Option<BackupManifest>, StoreError> {
        let set = self.set_path(backup_id)?;
        self.read_manifest_at(&set)
    }

    fn read_manifest_at(&self, set: &str) -> Result<Option<BackupManifest>, StoreError> {
        let raw = match self.fs.read_text(&Path::new(set).join(MANIFEST_NAME)) {
            Ok(raw) => raw,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(io(error)),
        };
        Ok(serde_json::from_str::<Value>(&raw)
            .ok()
            .and_then(|value| BackupManifest::from_json(&value)))
    }

    /// `restoreBackupEntry`: the copy is staged beside the destination and
    /// renamed into place. Once the destination is removed the staged copy
    /// is kept even if the rename fails — it is then the closest thing to
    /// the destination that exists.
    pub(crate) fn restore_entry(&self, entry: &BackupEntry) -> Result<(), StoreError> {
        let Some(backup_path) = &entry.backup_path else {
            return Err(StoreError::Io(format!(
                "Backup entry for \"{}\" has nothing to restore.",
                entry.destination_path
            )));
        };
        let parent = node_dirname(&self.platform, &entry.resolved_path);
        let stage = node_join(
            &self.platform,
            &[
                &parent,
                &format!(
                    ".{}.{}.restore",
                    node_basename(&entry.resolved_path),
                    (self.random_suffix)()
                ),
            ],
        );
        self.fs.create_dir_all(&fs_path(&parent)).map_err(io)?;
        if let Err(error) = self.fs.copy_tree(
            &fs_path(backup_path),
            &fs_path(&stage),
            CopyPurpose::Restore,
        ) {
            let _ = self.fs.remove_all(&fs_path(&stage));
            return Err(io(error));
        }
        self.fs
            .remove_all(&fs_path(&entry.resolved_path))
            .map_err(io)?;
        self.fs
            .rename(&fs_path(&stage), &fs_path(&entry.resolved_path))
            .map_err(io)
    }

    /// `discardBackupSet`.
    pub(crate) fn discard_set(&self, backup_id: &str) -> Result<(), StoreError> {
        let set = self.set_path(backup_id)?;
        self.fs.remove_all(&fs_path(&set)).map_err(io)
    }

    /// `purgeBackupSet`: whether the set was there. Purging a missing set
    /// is the state the caller asked for, not an error.
    pub(crate) fn purge_set(&self, backup_id: &str) -> Result<bool, StoreError> {
        let set = self.set_path(backup_id)?;
        let existed = self.fs.exists(&fs_path(&set)).map_err(io)?;
        self.fs.remove_all(&fs_path(&set)).map_err(io)?;
        Ok(existed)
    }

    /// `describeBackupSet`: a directory is a set only when it carries a
    /// manifest or a `<locationId>` subdirectory, so a backup root pointed
    /// at a shared directory never makes retention delete unrelated data.
    fn describe_set(&self, id: &str, path: &str) -> Option<SetOnDisk> {
        let entries = self.fs.read_dir(&fs_path(path)).ok()?;
        let has_manifest = entries
            .iter()
            .any(|(name, kind)| *kind == EntryType::File && name == MANIFEST_NAME);
        let is_set = has_manifest
            || entries.iter().any(|(name, kind)| {
                *kind == EntryType::Directory && location_by_id(name).is_some()
            });
        if !is_set {
            return None;
        }
        let (_, modified_at_ms) = self.fs.stat(&fs_path(path)).ok()?;
        let manifest = if has_manifest {
            self.read_manifest_at(path).ok()?
        } else {
            None
        };
        Some(SetOnDisk {
            id: id.to_string(),
            path: path.to_string(),
            modified_at_ms,
            size_bytes: self.directory_size(&fs_path(path)).ok()?,
            manifest,
        })
    }

    /// `directorySize`: regular files only, symlinks never followed.
    fn directory_size(&self, path: &Path) -> std::io::Result<u64> {
        let mut total = 0;
        for (name, kind) in self.fs.read_dir(path)? {
            let child = path.join(&name);
            total += match kind {
                EntryType::Directory => self.directory_size(&child)?,
                EntryType::File => self.fs.stat(&child)?.0,
                EntryType::Other => 0,
            };
        }
        Ok(total)
    }

    /// `collectBackupSets`: every set, newest first; nothing when the root
    /// does not exist yet.
    fn collect_sets(&self) -> Result<Vec<SetOnDisk>, StoreError> {
        let entries = match self.fs.read_dir(&fs_path(&self.root)) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(io(error)),
        };
        let mut sets: Vec<SetOnDisk> = entries
            .into_iter()
            .filter(|(_, kind)| *kind == EntryType::Directory)
            .filter_map(|(name, _)| {
                let path = node_join(&self.platform, &[&self.root, &name]);
                self.describe_set(&name, &path)
            })
            .collect();
        sets.sort_by(|left, right| {
            right
                .modified_at_ms
                .partial_cmp(&left.modified_at_ms)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| locale_compare(&right.id, &left.id))
        });
        Ok(sets)
    }

    /// `selectRetained`: the one definition prune and listing share.
    fn select_retained(&self, sets: &[SetOnDisk], current: Option<&str>) -> HashSet<String> {
        let mut retained = HashSet::new();
        if let Some(current) = current {
            retained.insert(current.to_string());
        }
        let mut retained_bytes = 0.0;
        for set in sets.iter().filter(|set| set.retained_unconditionally()) {
            retained.insert(set.id.clone());
            retained_bytes += set.size_bytes as f64;
        }
        let current_set = current.and_then(|id| sets.iter().find(|set| set.id == id));
        let ordinary_current = current_set.filter(|set| !set.retained_unconditionally());
        if let Some(set) = ordinary_current {
            retained_bytes += set.size_bytes as f64;
        }
        let mut ordinary_count = if ordinary_current.is_some() { 1.0 } else { 0.0 };
        for set in sets {
            if retained.contains(&set.id) {
                continue;
            }
            if ordinary_count >= self.retention_count {
                break;
            }
            if retained_bytes + set.size_bytes as f64 > self.retention_bytes {
                break;
            }
            retained.insert(set.id.clone());
            retained_bytes += set.size_bytes as f64;
            ordinary_count += 1.0;
        }
        retained
    }

    fn assert_retention_count(&self) -> Result<(), StoreError> {
        let count = self.retention_count;
        let safe = count.is_finite() && count.fract() == 0.0 && count.abs() <= MAX_SAFE_INTEGER;
        if safe && count >= 1.0 {
            return Ok(());
        }
        Err(StoreError::InvalidRetention)
    }

    /// `pruneBackupSets(currentBackupId)`, or the standalone sweep when
    /// `current` is `None` (`pruneBackupSetsAgainstBounds`).
    pub(crate) fn prune(&self, current: Option<&str>) -> Result<(), StoreError> {
        let sets = self.collect_sets()?;
        if sets.is_empty() {
            return Ok(());
        }
        self.assert_retention_count()?;
        let retained = self.select_retained(&sets, current);
        // Every eviction is attempted, as `Promise.all` starts them all; the
        // first failure is what the caller hears about.
        let mut first_error = None;
        for set in sets.iter().filter(|set| !retained.contains(&set.id)) {
            if let Err(error) = self.fs.remove_all(&fs_path(&set.path)) {
                first_error.get_or_insert(io(error));
            }
        }
        first_error.map_or(Ok(()), Err)
    }

    /// `listBackupSets`: read-only. A count too small to keep anything is
    /// reported as every ordinary set evicting, never refused.
    pub(crate) fn list(&self) -> Result<Vec<BackupSetRow>, StoreError> {
        let sets = self.collect_sets()?;
        let retained = self.select_retained(&sets, None);
        Ok(sets
            .iter()
            .map(|set| {
                let manifest = set.manifest.as_ref();
                let mut resource_keys: Vec<String> = manifest
                    .map(|manifest| {
                        manifest
                            .entries
                            .iter()
                            .filter_map(|entry| entry.resource_key.clone())
                            .filter(|key| !key.is_empty())
                            .collect::<HashSet<_>>()
                            .into_iter()
                            .collect()
                    })
                    .unwrap_or_default();
                // `[...new Set(keys)].sort()`: UTF-16 code-unit order.
                resource_keys.sort_by(|left, right| super::super::js::cmp_utf16(left, right));
                BackupSetRow {
                    backup_id: set.id.clone(),
                    created_at_ms: manifest.map_or_else(
                        || json!(set.modified_at_ms.round() as i64),
                        |manifest| number(manifest.created_at_ms),
                    ),
                    size_bytes: set.size_bytes,
                    entry_count: manifest.map_or(0, |manifest| manifest.entries.len()),
                    pinned: set.pinned(),
                    last_copy_resource_keys: manifest
                        .and_then(|manifest| manifest.last_copy_resource_keys.clone())
                        .unwrap_or_default(),
                    operation: manifest
                        .and_then(|manifest| manifest.operation)
                        .map_or("unknown", SetOperation::as_str),
                    resource_keys,
                    evicts_next: !retained.contains(&set.id),
                    manifest_readable: manifest.is_some(),
                }
            })
            .collect())
    }

    /// `collectBackupGarbage`: purges the named sets (idempotently), then
    /// trims the store to its bounds and reports which ids each step took.
    pub(crate) fn gc(&self, purge_ids: &[String]) -> Result<GcResult, StoreError> {
        let mut purged = Vec::new();
        for backup_id in purge_ids {
            self.purge_set(backup_id)?;
            purged.push(backup_id.clone());
        }
        let before = self.collect_sets()?;
        self.prune(None)?;
        let after: HashSet<String> = self.collect_sets()?.into_iter().map(|set| set.id).collect();
        Ok(GcResult {
            purged,
            pruned: before
                .into_iter()
                .map(|set| set.id)
                .filter(|id| !after.contains(id))
                .collect(),
        })
    }
}

#[cfg(test)]
#[path = "backup_store_tests.rs"]
mod tests;
