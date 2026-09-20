//! Recording every call's outcome to `audit.log`, for real.
//!
//! Mirrors `apps/runtime/src/audit-log.ts`: one JSON line per call, size-
//! bounded rotation, a bounded in-memory buffer for a line a write could
//! not yet land, and a sidecar `.error` file naming the last write failure.
//!
//! # Why `AuditEntry` still carries no `params`
//!
//! [`crate::ports::audit`]'s own module docs already give the reason for
//! leaving `params` off [`crate::ports::audit::AuditEntry`]: this crate
//! implements no methods, so it has no params shapes to redact safely.
//! That reasoning has not changed — this change still implements no
//! methods either — so the field stays off, deliberately, again. What
//! *has* changed is that a real sink now exists to write it to, which is
//! why [`redact::redact_credential_shapes`] is built and tested here rather
//! than left for later: TypeScript's `summarizeAuditArgs` is two things,
//! not one — a fixed whitelist of known-safe parameter keys (`path`,
//! `command`, `cols`, …), which is genuinely params-shape-aware and still
//! has no real caller in this crate, and the credential-shape redaction
//! pass applied to whatever survives that whitelist, which is not
//! params-shape-aware at all. Building the whitelist blind, with no real
//! method params to check it against, would risk exactly the leak this
//! crate's other seams (`panic::catch_panics`, `result_check`) exist to
//! prevent; the redaction pass has no such dependency and is mirrored in
//! full. Whichever later change implements the first method archetype
//! (filesystem, shell, terminal) is what should also design that
//! whitelist and add `params` to `AuditEntry` alongside it.

pub mod redact;

use std::collections::VecDeque;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use mangostudio_runtime_contract::schemas::{RuntimeHomeDocument, validate_runtime_home};
use serde_json::{Map, Value, json};

use crate::ports::audit::{Audit, AuditEntry, Outcome, lock};
use crate::ports::wall_clock::{WallClock, format_iso8601_millis};

/// Written before any hub has identified itself — mirrors `audit-log.ts`'s
/// own local `UNIDENTIFIED_HUB`, not exported from the shared contract
/// there either.
const UNIDENTIFIED_HUB: &str = "unidentified hub";

/// Rotate once the active file would exceed one megabyte.
const DEFAULT_MAX_BYTES: u64 = 1_048_576;

/// Keep the active file plus this many rotated generations.
const DEFAULT_MAX_FILES: u32 = 3;

/// A line this sink could not yet write is held in memory up to this many
/// entries; beyond it, the oldest buffered line is dropped rather than
/// growing without bound.
const MAX_BUFFERED_RECORDS: usize = 1_024;

/// Who a recorded call's hub was, once its handshake identifies it. Mirrors
/// TypeScript's `HubIdentity`.
#[derive(Debug, Clone)]
pub struct HubIdentity {
    /// The account name a transport (ssh, an OS account) attributes the hub to.
    pub user: String,
    /// The host a transport attributes the hub to.
    pub host: String,
}

impl HubIdentity {
    fn label(&self) -> String {
        format!("{}@{}", self.user, self.host)
    }
}

fn outcome_str(outcome: Outcome) -> &'static str {
    match outcome {
        Outcome::Ok => "ok",
        Outcome::Denied => "denied",
        Outcome::Error => "error",
    }
}

struct State {
    hub_label: String,
    buffered: VecDeque<String>,
    dropped: usize,
}

/// Records every call's outcome as one JSON line per call in `audit.log`,
/// under `slot`'s runtime-home directory.
///
/// # Example
///
/// ```
/// use mangostudio_runtime::audit::FileAudit;
/// use mangostudio_runtime::ports::audit::{Audit, AuditEntry, Outcome};
/// use mangostudio_runtime::ports::wall_clock::SystemWallClock;
/// use std::sync::Arc;
/// use std::time::Duration;
///
/// # #[tokio::main(flavor = "current_thread")]
/// # async fn main() {
/// let dir = std::env::temp_dir().join("mango-file-audit-doctest");
/// std::fs::create_dir_all(&dir).unwrap();
/// let audit = FileAudit::new(dir.join("audit.log"), Arc::new(SystemWallClock));
/// audit
///     .record(AuditEntry {
///         method: "runtime.health".to_string(),
///         outcome: Outcome::Ok,
///         duration: Duration::from_millis(5),
///         capability: None,
///         code: None,
///     })
///     .await;
/// let contents = std::fs::read_to_string(dir.join("audit.log")).unwrap();
/// assert!(contents.contains("\"method\":\"runtime.health\""));
/// # }
/// ```
pub struct FileAudit {
    path: PathBuf,
    error_path: PathBuf,
    max_bytes: u64,
    max_files: u32,
    wall_clock: Arc<dyn WallClock>,
    state: Mutex<State>,
}

impl FileAudit {
    /// Builds a sink writing to `path`, timestamping every line with
    /// `wall_clock`. Starts with no hub identified — see
    /// [`FileAudit::set_hub`].
    #[must_use]
    pub fn new(path: PathBuf, wall_clock: Arc<dyn WallClock>) -> Self {
        let mut error_path = path.clone().into_os_string();
        error_path.push(".error");
        Self {
            path,
            error_path: PathBuf::from(error_path),
            max_bytes: DEFAULT_MAX_BYTES,
            max_files: DEFAULT_MAX_FILES,
            wall_clock,
            state: Mutex::new(State {
                hub_label: UNIDENTIFIED_HUB.to_string(),
                buffered: VecDeque::new(),
                dropped: 0,
            }),
        }
    }

    /// Overrides the rotation threshold and generation count this build
    /// otherwise defaults to — for a test that needs rotation to trigger
    /// without writing a megabyte of lines first.
    #[must_use]
    pub fn with_rotation(mut self, max_bytes: u64, max_files: u32) -> Self {
        self.max_bytes = max_bytes;
        self.max_files = max_files.max(1);
        self
    }

    /// Names every subsequent line's `hub` field, once a handshake
    /// identifies the peer. `None` reverts to `"unidentified hub"`.
    pub fn set_hub(&self, hub: Option<HubIdentity>) {
        lock(&self.state).hub_label =
            hub.map_or_else(|| UNIDENTIFIED_HUB.to_string(), |hub| hub.label());
    }

    /// Drains every currently buffered line, retrying its write. Mirrors
    /// `audit-log.ts`'s own drain-on-close loop; a line that still cannot
    /// be written is put back (in order) and reported via the sidecar
    /// error file rather than lost.
    pub fn close(&self) {
        self.drain_buffer();
    }

    fn generation_path(&self, index: u32) -> PathBuf {
        let mut name = self.path.clone().into_os_string();
        name.push(format!(".{index}"));
        PathBuf::from(name)
    }

    fn rotate(&self) -> std::io::Result<()> {
        let oldest = self.generation_path(self.max_files);
        let _ = std::fs::remove_file(&oldest);
        for index in (1..self.max_files).rev() {
            let from = self.generation_path(index);
            if from.exists() {
                std::fs::rename(&from, self.generation_path(index + 1))?;
            }
        }
        if self.path.exists() {
            std::fs::rename(&self.path, self.generation_path(1))?;
        }
        Ok(())
    }

    fn append_line(&self, line: &str) -> std::io::Result<()> {
        let incoming_len = (line.len() + 1) as u64;
        let current_len = std::fs::metadata(&self.path)
            .map(|meta| meta.len())
            .unwrap_or(0);
        if current_len > 0 && current_len + incoming_len > self.max_bytes {
            self.rotate()?;
        }
        use std::io::Write as _;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        file.write_all(line.as_bytes())?;
        file.write_all(b"\n")
    }

    fn set_error(&self, message: &str) {
        let _ = std::fs::write(&self.error_path, format!("{message}\n"));
    }

    fn clear_error(&self) {
        let _ = std::fs::remove_file(&self.error_path);
    }

    /// Writes `line` now if possible; buffers it (dropping the oldest
    /// buffered line past [`MAX_BUFFERED_RECORDS`]) and reports the failure
    /// via the sidecar error file otherwise.
    fn write_or_buffer(&self, line: String) {
        match self.append_line(&line) {
            Ok(()) => self.drain_buffer(),
            Err(error) => {
                let dropped = {
                    let mut state = lock(&self.state);
                    state.buffered.push_back(line);
                    if state.buffered.len() > MAX_BUFFERED_RECORDS {
                        state.buffered.pop_front();
                        state.dropped += 1;
                    }
                    state.dropped
                };
                let suffix = if dropped > 0 {
                    format!(" ({dropped} record(s) dropped)")
                } else {
                    String::new()
                };
                self.set_error(&format!("{error}{suffix}"));
            }
        }
    }

    /// Retries every buffered line, oldest first. Stops at the first one
    /// that still fails, putting it (and everything after it) back so
    /// ordering is preserved for the next attempt.
    fn drain_buffer(&self) {
        let pending: Vec<String> = lock(&self.state).buffered.drain(..).collect();
        if pending.is_empty() {
            self.clear_error();
            return;
        }
        for (index, line) in pending.iter().enumerate() {
            if let Err(error) = self.append_line(line) {
                let mut state = lock(&self.state);
                for remaining in pending[index..].iter().rev() {
                    state.buffered.push_front(remaining.clone());
                }
                drop(state);
                self.set_error(&format!("{error}"));
                return;
            }
        }
        self.clear_error();
    }

    fn build_line(&self, entry: &AuditEntry, hub_label: &str) -> String {
        let mut object = Map::new();
        object.insert(
            "ts".to_string(),
            Value::String(format_iso8601_millis(self.wall_clock.now())),
        );
        object.insert("method".to_string(), Value::String(entry.method.clone()));
        object.insert("hub".to_string(), Value::String(hub_label.to_string()));
        object.insert(
            "outcome".to_string(),
            Value::String(outcome_str(entry.outcome).to_string()),
        );
        // Rounded to a whole millisecond, matching `audit-log.ts`'s own
        // `Math.max(0, Math.round(durationMs))` (the `max(0, ...)` half is
        // structurally unreachable here: `Duration` cannot be negative).
        // Without the rounding, `serde_json` would serialise a value like
        // `5.0` as `"5.0"` rather than `"5"` — a wire difference from every
        // TypeScript-written line, which is always a whole number.
        object.insert(
            "durationMs".to_string(),
            json!((entry.duration.as_secs_f64() * 1000.0).round() as u64),
        );
        if let Some(capability) = &entry.capability {
            object.insert("capability".to_string(), Value::String(capability.clone()));
        }
        if let Some(code) = &entry.code {
            object.insert("code".to_string(), Value::String(code.clone()));
        }
        let value = Value::Object(object);
        debug_assert!(
            validate_runtime_home(RuntimeHomeDocument::AuditRecord, &value).is_ok(),
            "a line this sink builds must always match the schema it also validates against"
        );
        serde_json::to_string(&value)
            .expect("a plain object of strings and numbers always serialises")
    }
}

impl Audit for FileAudit {
    fn record<'a>(&'a self, entry: AuditEntry) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>> {
        Box::pin(async move {
            let hub_label = lock(&self.state).hub_label.clone();
            let line = self.build_line(&entry, &hub_label);
            self.write_or_buffer(line);
        })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    use serde_json::Value;

    use super::{FileAudit, HubIdentity};
    use crate::ports::audit::{Audit, AuditEntry, Outcome};
    use crate::ports::wall_clock::FixedWallClock;

    fn scratch_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "mango-file-audit-test-{name}-{}-{}",
            std::process::id(),
            line!()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn entry(method: &str, outcome: Outcome) -> AuditEntry {
        AuditEntry {
            method: method.to_string(),
            outcome,
            duration: Duration::from_millis(12),
            capability: None,
            code: None,
        }
    }

    fn read_lines(path: &std::path::Path) -> Vec<Value> {
        std::fs::read_to_string(path)
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    #[tokio::test]
    async fn a_recorded_line_matches_the_runtime_home_audit_record_schema() {
        let dir = scratch_dir("schema-valid");
        let clock = Arc::new(FixedWallClock::new(
            UNIX_EPOCH + Duration::from_secs(1_700_000_000),
        ));
        let audit = FileAudit::new(dir.join("audit.log"), clock);
        audit
            .record(AuditEntry {
                method: "terminal.list".to_string(),
                outcome: Outcome::Denied,
                duration: Duration::from_millis(3),
                capability: Some("shell".to_string()),
                code: Some("DENIED".to_string()),
            })
            .await;

        let lines = read_lines(&dir.join("audit.log"));
        assert_eq!(lines.len(), 1);
        let line = &lines[0];
        assert_eq!(line["method"], "terminal.list");
        assert_eq!(line["outcome"], "denied");
        assert_eq!(line["capability"], "shell");
        assert_eq!(line["code"], "DENIED");
        assert_eq!(line["hub"], "unidentified hub");
        assert!(line["ts"].as_str().unwrap().ends_with('Z'));
        assert!(
            mangostudio_runtime_contract::schemas::validate_runtime_home(
                mangostudio_runtime_contract::schemas::RuntimeHomeDocument::AuditRecord,
                line,
            )
            .is_ok()
        );
    }

    /// `durationMs` must land on the wire as a whole JSON number
    /// (`5`, not `5.0`): `serde_json` serialises those two differently, and
    /// only the former round-trips as the same `Number` a TypeScript-written
    /// line (always an integer, via `Math.round`) would parse to.
    #[tokio::test]
    async fn duration_ms_serialises_as_a_whole_number_not_a_float() {
        let dir = scratch_dir("duration-ms-integer");
        let audit = FileAudit::new(
            dir.join("audit.log"),
            Arc::new(FixedWallClock::new(SystemTime::now())),
        );
        audit.record(entry("runtime.health", Outcome::Ok)).await;
        let raw = std::fs::read_to_string(dir.join("audit.log")).unwrap();
        assert!(
            !raw.contains("durationMs\":12.0"),
            "durationMs must serialise as an integer, not a float: {raw}"
        );
        let lines = read_lines(&dir.join("audit.log"));
        assert_eq!(
            lines[0]["durationMs"],
            Value::from(12u64),
            "the 12ms duration `entry(\"runtime.health\", ..)` builds must round-trip as the \
             integer JSON number 12, matching what a TypeScript-written line would parse to"
        );
    }

    #[tokio::test]
    async fn an_ok_outcome_carries_neither_capability_nor_code() {
        let dir = scratch_dir("ok-outcome");
        let audit = FileAudit::new(
            dir.join("audit.log"),
            Arc::new(FixedWallClock::new(SystemTime::now())),
        );
        audit.record(entry("runtime.health", Outcome::Ok)).await;
        let lines = read_lines(&dir.join("audit.log"));
        assert!(lines[0].get("capability").is_none());
        assert!(lines[0].get("code").is_none());
    }

    #[tokio::test]
    async fn set_hub_changes_every_subsequent_lines_hub_field() {
        let dir = scratch_dir("set-hub");
        let audit = FileAudit::new(
            dir.join("audit.log"),
            Arc::new(FixedWallClock::new(SystemTime::now())),
        );
        audit.record(entry("runtime.health", Outcome::Ok)).await;
        audit.set_hub(Some(HubIdentity {
            user: "ada".to_string(),
            host: "hub.example".to_string(),
        }));
        audit.record(entry("runtime.health", Outcome::Ok)).await;

        let lines = read_lines(&dir.join("audit.log"));
        assert_eq!(lines[0]["hub"], "unidentified hub");
        assert_eq!(lines[1]["hub"], "ada@hub.example");
    }

    #[tokio::test]
    async fn rotation_moves_the_active_file_to_generation_one() {
        let dir = scratch_dir("rotate");
        let audit = FileAudit::new(
            dir.join("audit.log"),
            Arc::new(FixedWallClock::new(SystemTime::now())),
        )
        .with_rotation(80, 3);

        // Each line is roughly 60-70 bytes; the second write should push
        // the file past the 80-byte threshold and trigger a rotation
        // before it lands.
        audit.record(entry("runtime.health", Outcome::Ok)).await;
        audit.record(entry("runtime.health", Outcome::Ok)).await;

        assert!(
            dir.join("audit.log.1").exists(),
            "the first line must have been rotated out"
        );
        let active = read_lines(&dir.join("audit.log"));
        assert_eq!(
            active.len(),
            1,
            "the active file holds only the newest line"
        );
        let rotated = read_lines(&dir.join("audit.log.1"));
        assert_eq!(
            rotated.len(),
            1,
            "the rotated-out file keeps the older line"
        );
    }

    #[tokio::test]
    async fn rotation_drops_generations_beyond_the_configured_cap() {
        let dir = scratch_dir("rotate-cap");
        let audit = FileAudit::new(
            dir.join("audit.log"),
            Arc::new(FixedWallClock::new(SystemTime::now())),
        )
        .with_rotation(80, 2);

        for _ in 0..6 {
            audit.record(entry("runtime.health", Outcome::Ok)).await;
        }

        assert!(dir.join("audit.log.1").exists());
        assert!(dir.join("audit.log.2").exists());
        assert!(
            !dir.join("audit.log.3").exists(),
            "only max_files generations may exist beyond the active file"
        );
    }

    #[tokio::test]
    async fn a_write_that_cannot_land_is_buffered_and_reported_in_the_sidecar_error_file() {
        // A directory sitting where the log file belongs makes every write
        // fail with EISDIR, deterministically and without relying on
        // permission bits — and unlike a missing parent directory, this
        // leaves the sidecar `.error` file's own parent intact, which is
        // what this test needs to actually observe the sidecar being
        // written.
        let dir = scratch_dir("unwritable");
        let blocked_path = dir.join("audit.log");
        std::fs::create_dir(&blocked_path).unwrap();
        let audit = FileAudit::new(
            blocked_path.clone(),
            Arc::new(FixedWallClock::new(SystemTime::now())),
        );
        audit.record(entry("runtime.health", Outcome::Ok)).await;

        let mut error_path = blocked_path.into_os_string();
        error_path.push(".error");
        let error_path = std::path::PathBuf::from(error_path);
        assert!(
            error_path.exists(),
            "a failed write must leave a sidecar error file"
        );
        let message = std::fs::read_to_string(&error_path).unwrap();
        assert!(!message.trim().is_empty());
    }

    #[tokio::test]
    async fn close_drains_a_buffered_line_once_the_destination_becomes_writable() {
        let dir = scratch_dir("drain-on-close");
        let path = dir.join("missing-subdir").join("audit.log");
        let audit = FileAudit::new(
            path.clone(),
            Arc::new(FixedWallClock::new(SystemTime::now())),
        );
        audit.record(entry("runtime.health", Outcome::Ok)).await;
        assert!(!path.exists(), "buffered, not yet written");

        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        audit.close();

        let lines = read_lines(&path);
        assert_eq!(lines.len(), 1, "the buffered line must have been drained");
        let mut error_path = path.into_os_string();
        error_path.push(".error");
        assert!(
            !std::path::PathBuf::from(error_path).exists(),
            "a successful drain must clear the sidecar error file"
        );
    }

    #[tokio::test]
    async fn the_buffer_drops_the_oldest_record_past_its_cap() {
        let dir = scratch_dir("buffer-cap");
        let path = dir.join("missing-subdir").join("audit.log");
        let audit = FileAudit::new(
            path.clone(),
            Arc::new(FixedWallClock::new(SystemTime::now())),
        );

        // One more than MAX_BUFFERED_RECORDS (1_024): the very first
        // record must have been dropped, and the buffer must never exceed
        // its cap.
        for index in 0..1_025u32 {
            audit
                .record(entry(&format!("runtime.health.{index}"), Outcome::Ok))
                .await;
        }

        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        audit.close();
        let lines = read_lines(&path);
        assert_eq!(lines.len(), 1_024, "the buffer must never exceed its cap");
        assert_eq!(
            lines[0]["method"], "runtime.health.1",
            "the oldest record (index 0) must have been the one dropped"
        );
    }
}
