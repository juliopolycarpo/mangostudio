//! Recording every call's outcome to `audit.log`, for real.
//!
//! Mirrors `apps/runtime/src/audit-log.ts`: one JSON line per call, size-
//! bounded rotation, a bounded in-memory buffer for a line a write could
//! not yet land, and a sidecar `.error` file naming the last write failure.
//!
//! # Why `AuditEntry` still carries no `params`
//!
//! [`crate::ports::audit`]'s own module docs already give the reason for
//! leaving `params` off [`crate::ports::audit::AuditEntry`]. The
//! filesystem and command method groups now exist, but the params
//! whitelist has not been designed against them yet, so the field stays
//! off. [`redact::redact_credential_shapes`] is built and tested here
//! ahead of that because TypeScript's `summarizeAuditArgs` is two things,
//! not one — a fixed whitelist of known-safe parameter keys (`path`,
//! `command`, `cols`, …), which is genuinely params-shape-aware and still
//! has no real caller in this crate, and the credential-shape redaction
//! pass applied to whatever survives that whitelist, which is not
//! params-shape-aware at all. Building the whitelist blind, with no real
//! method params to check it against, would risk exactly the leak this
//! crate's other seams (`panic::catch_panics`, `result_check`) exist to
//! prevent; the redaction pass has no such dependency and is mirrored in
//! full. The change that designs that whitelist against the implemented
//! filesystem and command params also adds `params` to `AuditEntry`.

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
use crate::runtime_home::atomic::{Rename, RenameRetryPolicy, StdRename, rename_with_retry};

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
    error_maybe_present: bool,
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
#[derive(Clone)]
pub struct FileAudit {
    path: PathBuf,
    error_path: PathBuf,
    max_bytes: u64,
    max_files: u32,
    wall_clock: Arc<dyn WallClock>,
    state: Arc<Mutex<State>>,
    /// Serialises `append_line_locked`'s read-size, maybe-rotate, then-write
    /// sequence, kept separate from `state`: two `record` calls dispatched
    /// as concurrent tasks (mango_protocol's `JoinSet`, not TypeScript's
    /// single-threaded event loop) can both read the file's current length
    /// near the rotation threshold and both decide to rotate, racing each
    /// other's rename of `audit.log` to `audit.log.1` — one generation is
    /// lost, and lines can land in whichever file wins. A dedicated lock
    /// for just this sequence means a hub-label update (`set_hub`) never
    /// has to wait on that I/O, which sharing `state`'s own lock would
    /// force.
    write_lock: Arc<Mutex<()>>,
    /// Only one drain from this sink may occupy the process-wide blocking
    /// pool. The guard moves into the blocking closure, so cancellation of
    /// a waiter cannot free the gate while that drain is still running.
    drain_gate: Arc<tokio::sync::Mutex<()>>,
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
            state: Arc::new(Mutex::new(State {
                hub_label: UNIDENTIFIED_HUB.to_string(),
                buffered: VecDeque::new(),
                dropped: 0,
                // A previous process may have left a sidecar. The first
                // successful drain checks once without doing I/O in `new`.
                error_maybe_present: true,
            })),
            write_lock: Arc::new(Mutex::new(())),
            drain_gate: Arc::new(tokio::sync::Mutex::new(())),
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
    ///
    /// # Example
    ///
    /// ```
    /// use mangostudio_runtime::audit::FileAudit;
    /// use mangostudio_runtime::ports::wall_clock::SystemWallClock;
    /// use std::sync::Arc;
    ///
    /// # #[tokio::main(flavor = "current_thread")]
    /// # async fn main() {
    /// let audit = FileAudit::new(std::env::temp_dir().join("mango-audit-close.log"), Arc::new(SystemWallClock));
    /// audit.close().await;
    /// # }
    /// ```
    pub async fn close(&self) {
        self.drain().await;
    }

    async fn drain(&self) {
        let gate = Arc::clone(&self.drain_gate).lock_owned().await;
        let writer = self.clone();
        crate::blocking::run_blocking(move || {
            let _gate = gate;
            writer.drain_buffer();
        })
        .await;
    }

    fn generation_path(&self, index: u32) -> PathBuf {
        let mut name = self.path.clone().into_os_string();
        name.push(format!(".{index}"));
        PathBuf::from(name)
    }

    fn rotate(&self) -> std::io::Result<()> {
        self.rotate_with(&StdRename)
    }

    fn rotate_with(&self, rename: &impl Rename) -> std::io::Result<()> {
        let retry = RenameRetryPolicy::default();
        let oldest = self.generation_path(self.max_files);
        let _ = std::fs::remove_file(&oldest);
        for index in (1..self.max_files).rev() {
            let from = self.generation_path(index);
            if from.exists() {
                rename_with_retry(rename, &from, &self.generation_path(index + 1), &retry)?;
            }
        }
        if self.path.exists() {
            rename_with_retry(rename, &self.path, &self.generation_path(1), &retry)?;
        }
        Ok(())
    }

    /// The read-size, maybe-rotate, then-write sequence itself, assuming
    /// `write_lock` is already held — [`FileAudit::drain_buffer`] is the
    /// sole caller, and takes `write_lock` itself before calling in;
    /// nothing here takes it again, or draining a batch would deadlock
    /// against its own outer lock. See `write_lock`'s own doc comment for
    /// why a partial hold (or none at all) lets two concurrent callers both
    /// decide to rotate from the same stale length.
    fn append_line_locked(&self, line: &str) -> std::io::Result<()> {
        // Mirrors `writeBatch`'s own `mkdir(dirname(path), { recursive:
        // true })`: a slot whose runtime-home directory does not exist yet
        // would otherwise fail every write with `ENOENT`, buffer forever,
        // hit the `MAX_BUFFERED_RECORDS` cap, and never manage to write
        // even the sidecar `.error` file explaining why — a silent no-op
        // audit log instead of a directory that gets created on demand.
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
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
        // Even a failed write may have created a partial sidecar.
        lock(&self.state).error_maybe_present = true;
        let _ = std::fs::write(&self.error_path, format!("{message}\n"));
    }

    fn clear_error(&self) {
        if !lock(&self.state).error_maybe_present {
            return;
        }
        match std::fs::remove_file(&self.error_path) {
            Ok(()) => lock(&self.state).error_maybe_present = false,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                lock(&self.state).error_maybe_present = false;
            }
            Err(_) => {}
        }
    }

    /// Buffers `line` (dropping the oldest buffered line past
    /// [`MAX_BUFFERED_RECORDS`]) and attempts to drain the whole buffer,
    /// oldest first. `line` always goes through the buffer, even when it
    /// could be written immediately: writing it straight to disk first and
    /// only *then* draining whatever was already buffered — the previous
    /// shape here — let a brand-new line land ahead of an older one still
    /// waiting its turn, reordering the file `drain_buffer`'s own doc
    /// promises never happens.
    fn enqueue(&self, line: String) {
        let mut state = lock(&self.state);
        state.buffered.push_back(line);
        if state.buffered.len() > MAX_BUFFERED_RECORDS {
            state.buffered.pop_front();
            state.dropped += 1;
        }
    }

    #[cfg(test)]
    fn write_or_buffer(&self, line: String) {
        self.enqueue(line);
        self.drain_buffer();
    }

    /// Retries every currently buffered line, oldest first, stopping at the
    /// first one that still fails and putting it back so ordering is
    /// preserved for the next attempt. Holds `write_lock` for the whole
    /// drain rather than re-acquiring it one line at a time: two `record`
    /// calls each buffering their own line and then racing to drain used
    /// to let each drain snapshot a different, disjoint slice of
    /// `state.buffered` and then interleave their writes in whatever order
    /// the two drains happened to acquire the per-line lock, not the order
    /// the lines were buffered in. Popping from the front of the shared
    /// queue one at a time — instead of collecting a snapshot first — means
    /// a line another thread buffers while this drain is already running
    /// still gets picked up by this same drain; that thread's own call to
    /// `drain_buffer` then simply finds an empty queue once it gets its
    /// turn at `write_lock`, and returns immediately.
    fn drain_buffer(&self) {
        let _write_guard = lock(&self.write_lock);
        loop {
            let Some(line) = lock(&self.state).buffered.pop_front() else {
                self.clear_error();
                return;
            };
            if let Err(error) = self.append_line_locked(&line) {
                let dropped = {
                    let mut state = lock(&self.state);
                    state.buffered.push_front(line);
                    state.dropped
                };
                let suffix = if dropped > 0 {
                    format!(" ({dropped} record(s) dropped)")
                } else {
                    String::new()
                };
                self.set_error(&format!("{error}{suffix}"));
                return;
            }
        }
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
            self.enqueue(line);
            self.drain().await;
        })
    }
}

#[cfg(test)]
mod tests {
    use std::io;
    use std::path::Path;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Barrier};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    use serde_json::Value;

    use super::{FileAudit, HubIdentity};
    use crate::ports::audit::{Audit, AuditEntry, Outcome, lock};
    use crate::ports::wall_clock::FixedWallClock;
    use crate::runtime_home::atomic::Rename;
    use crate::test_support::scratch_dir;

    struct SharingViolationOnce {
        attempts: AtomicUsize,
    }

    impl Rename for SharingViolationOnce {
        fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
            if self.attempts.fetch_add(1, Ordering::SeqCst) == 0 {
                return Err(io::Error::from_raw_os_error(32));
            }
            std::fs::rename(from, to)
        }
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

    #[tokio::test(flavor = "current_thread")]
    async fn a_blocked_audit_write_does_not_block_the_executor() {
        let dir = scratch_dir("off-executor");
        let audit = Arc::new(FileAudit::new(
            dir.join("audit.log"),
            Arc::new(FixedWallClock::new(SystemTime::now())),
        ));
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let held = {
            let audit = Arc::clone(&audit);
            std::thread::spawn(move || {
                let _write_guard = lock(&audit.write_lock);
                ready_tx.send(()).unwrap();
                std::thread::sleep(Duration::from_millis(250));
            })
        };
        ready_rx.recv().unwrap();
        let pending = tokio::spawn({
            let audit = Arc::clone(&audit);
            async move { audit.record(entry("runtime.health", Outcome::Ok)).await }
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(
            !pending.is_finished(),
            "the executor must advance before the blocked audit write finishes"
        );
        pending.await.unwrap();
        held.join().unwrap();
    }

    #[tokio::test]
    async fn close_flushes_a_record_whose_waiter_was_cancelled() {
        let dir = scratch_dir("cancelled-waiter");
        let path = dir.join("audit.log");
        let audit = Arc::new(FileAudit::new(
            path.clone(),
            Arc::new(FixedWallClock::new(SystemTime::now())),
        ));
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let held = {
            let audit = Arc::clone(&audit);
            std::thread::spawn(move || {
                let _write_guard = lock(&audit.write_lock);
                ready_tx.send(()).unwrap();
                release_rx.recv().unwrap();
            })
        };
        ready_rx.recv().unwrap();
        let pending = tokio::spawn({
            let audit = Arc::clone(&audit);
            async move { audit.record(entry("CANCELLED_WAITER", Outcome::Ok)).await }
        });
        for _ in 0..100 {
            if !lock(&audit.state).buffered.is_empty() {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert_eq!(lock(&audit.state).buffered.len(), 1);
        pending.abort();
        let _ = pending.await;
        release_tx.send(()).unwrap();
        held.join().unwrap();

        audit.close().await;

        let lines = read_lines(&path);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0]["method"], "CANCELLED_WAITER");
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

    #[test]
    fn rotation_retries_a_windows_sharing_violation() {
        let dir = scratch_dir("rotate-sharing-violation");
        let path = dir.join("audit.log");
        std::fs::write(&path, "old line\n").unwrap();
        let audit = FileAudit::new(
            path.clone(),
            Arc::new(FixedWallClock::new(SystemTime::now())),
        );
        let rename = SharingViolationOnce {
            attempts: AtomicUsize::new(0),
        };

        audit.rotate_with(&rename).unwrap();

        assert_eq!(rename.attempts.load(Ordering::SeqCst), 2);
        assert!(!path.exists());
        assert_eq!(
            std::fs::read_to_string(dir.join("audit.log.1")).unwrap(),
            "old line\n"
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

    /// Reads every line in `path` as JSON, or an empty `Vec` when `path`
    /// does not exist — a rotated generation a race never actually created
    /// is exactly as valid an outcome as one that did, as long as no line
    /// went missing entirely.
    fn count_lines(path: &std::path::Path) -> usize {
        std::fs::read_to_string(path)
            .map(|contents| contents.lines().count())
            .unwrap_or(0)
    }

    #[test]
    fn concurrent_writers_at_the_rotation_boundary_lose_no_lines() {
        // The regression this guards: `append_line_locked`'s read-size,
        // maybe-rotate, then-write sequence used to run under no lock at
        // all. Two `record` calls dispatched as concurrent tasks (this
        // crate's real shape — `mango_protocol`'s `JoinSet`, not
        // TypeScript's single-threaded event loop) could both read the
        // same stale file length near the threshold, both decide to
        // rotate, and race each other's rename of `audit.log` to
        // `audit.log.1` — one generation lost, lines landing in whichever
        // file won. A `Barrier`, not a sleep: it makes both threads call
        // `write_or_buffer` at essentially the same instant, and running
        // many iterations is what turns "usually passes" into "never
        // passes while the bug exists".
        for attempt in 0..200 {
            let dir = scratch_dir(&format!("rotate-race-{attempt}"));
            let audit = Arc::new(
                FileAudit::new(
                    dir.join("audit.log"),
                    Arc::new(FixedWallClock::new(SystemTime::now())),
                )
                // Any existing content at all exceeds this threshold, so
                // both racing writers are certain to see a nonempty file
                // and both decide a rotation is needed.
                .with_rotation(1, 3),
            );
            // Seeds real content to rotate away, synchronously — no race
            // on this first write, by construction (nothing else is
            // running yet).
            audit.write_or_buffer("SEED".to_string());

            let barrier = Arc::new(Barrier::new(2));
            let threads: Vec<_> = ["RACER-B", "RACER-C"]
                .into_iter()
                .map(|label| {
                    let audit = Arc::clone(&audit);
                    let barrier = Arc::clone(&barrier);
                    std::thread::spawn(move || {
                        barrier.wait();
                        audit.write_or_buffer(label.to_string());
                    })
                })
                .collect();
            for thread in threads {
                thread.join().unwrap();
            }

            let mut total = count_lines(&dir.join("audit.log"));
            for index in 1..=3u32 {
                total += count_lines(&dir.join(format!("audit.log.{index}")));
            }
            assert_eq!(
                total, 3,
                "attempt {attempt}: seed plus two concurrent writers must total 3 lines across \
                 every generation combined — a lost or duplicated generation means fewer or more"
            );
        }
    }

    #[test]
    fn a_line_queued_before_a_race_begins_is_never_written_after_one_queued_during_it() {
        // The regression this guards: `drain_buffer` used to snapshot the
        // whole buffer into a local `Vec` under `state`'s lock, then
        // release that lock before writing anything. Two independent
        // drains racing this way could each grab a disjoint slice of the
        // queue and then compete for the per-line write lock on their own,
        // with no guarantee the drain holding the earlier slice won it
        // first — a line queued later could land on disk before one
        // queued earlier. FIRST is queued here before the race starts, so
        // its position ahead of every racer is established independently
        // of which thread the barrier happens to schedule first; the only
        // correct outcome is FIRST written before all of them, however the
        // race lands. Racing many concurrent writers rather than one
        // widens the window the bug needs: any single racer landing its
        // own disjoint slice ahead of FIRST's is enough to fail.
        //
        // 200 attempts, not 500 like the exclusivity races: measured
        // against this file's pre-fix `drain_buffer` (snapshot-collect,
        // then write outside the lock), 8 racers land roughly 2-2.5% of
        // 200 attempts as a hit — consistently, across five repeated runs
        // — for well over 95% confidence of at least one hit per run.
        const RACERS: usize = 8;
        for attempt in 0..200 {
            let dir = scratch_dir(&format!("drain-order-{attempt}"));
            let audit = Arc::new(FileAudit::new(
                dir.join("audit.log"),
                Arc::new(FixedWallClock::new(SystemTime::now())),
            ));
            lock(&audit.state).buffered.push_back("FIRST".to_string());

            let barrier = Arc::new(Barrier::new(RACERS));
            let threads: Vec<_> = (0..RACERS)
                .map(|racer| {
                    let audit = Arc::clone(&audit);
                    let barrier = Arc::clone(&barrier);
                    std::thread::spawn(move || {
                        barrier.wait();
                        audit.write_or_buffer(format!("RACER-{racer}"));
                    })
                })
                .collect();
            for thread in threads {
                thread.join().unwrap();
            }

            let contents = std::fs::read_to_string(dir.join("audit.log")).unwrap_or_default();
            let lines: Vec<&str> = contents.lines().collect();
            assert_eq!(
                lines.first().copied(),
                Some("FIRST"),
                "attempt {attempt}: FIRST was queued before any racer could even exist and must \
                 never be written after one — got {lines:?}"
            );
        }
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
    async fn a_successful_write_clears_a_sidecar_left_by_an_earlier_process() {
        let dir = scratch_dir("stale-error");
        let error_path = dir.join("audit.log.error");
        std::fs::write(&error_path, "old failure\n").unwrap();
        let audit = FileAudit::new(
            dir.join("audit.log"),
            Arc::new(FixedWallClock::new(SystemTime::now())),
        );

        audit.record(entry("runtime.health", Outcome::Ok)).await;

        assert!(!error_path.exists());
    }

    #[tokio::test]
    async fn close_drains_a_buffered_line_once_the_destination_becomes_writable() {
        let dir = scratch_dir("drain-on-close");
        let path = dir.join("audit.log");
        // A directory sitting where the log file belongs blocks every
        // write with EISDIR, deterministically — the same trick the
        // sidecar-error test above uses. A merely *missing* parent
        // directory no longer buffers anything: `append_line_locked` creates it
        // on demand, mirroring `writeBatch`'s own `mkdir(..., { recursive:
        // true })`.
        std::fs::create_dir(&path).unwrap();
        let audit = FileAudit::new(
            path.clone(),
            Arc::new(FixedWallClock::new(SystemTime::now())),
        );
        audit.record(entry("runtime.health", Outcome::Ok)).await;

        let mut error_path = path.clone().into_os_string();
        error_path.push(".error");
        let error_path = std::path::PathBuf::from(error_path);
        assert!(
            error_path.exists(),
            "buffered and reported, not yet written"
        );

        std::fs::remove_dir(&path).unwrap();
        audit.close().await;

        let lines = read_lines(&path);
        assert_eq!(lines.len(), 1, "the buffered line must have been drained");
        assert!(
            !error_path.exists(),
            "a successful drain must clear the sidecar error file"
        );
    }

    #[tokio::test]
    async fn the_buffer_drops_the_oldest_record_past_its_cap() {
        let dir = scratch_dir("buffer-cap");
        let path = dir.join("audit.log");
        // Blocks every write with EISDIR — see the comment on the drain
        // test above for why a missing parent directory can no longer be
        // used to force buffering.
        std::fs::create_dir(&path).unwrap();
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

        std::fs::remove_dir(&path).unwrap();
        audit.close().await;
        let lines = read_lines(&path);
        assert_eq!(lines.len(), 1_024, "the buffer must never exceed its cap");
        assert_eq!(
            lines[0]["method"], "runtime.health.1",
            "the oldest record (index 0) must have been the one dropped"
        );
    }

    #[tokio::test]
    async fn a_new_record_never_lands_ahead_of_an_older_buffered_one() {
        // The regression this guards: `write_or_buffer` used to try
        // writing the new line straight to disk first, and only *then*
        // drain whatever was already buffered — so a line that landed
        // immediately could get ahead of an older one still waiting its
        // turn. `record("FIRST")` while blocked, then `record("SECOND")`
        // once unblocked, must read back `["FIRST", "SECOND"]`, never the
        // reverse.
        let dir = scratch_dir("order-preserved");
        let path = dir.join("audit.log");
        std::fs::create_dir(&path).unwrap();
        let audit = FileAudit::new(
            path.clone(),
            Arc::new(FixedWallClock::new(SystemTime::now())),
        );

        audit.record(entry("FIRST", Outcome::Ok)).await;
        std::fs::remove_dir(&path).unwrap();
        audit.record(entry("SECOND", Outcome::Ok)).await;

        let lines = read_lines(&path);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0]["method"], "FIRST");
        assert_eq!(lines[1]["method"], "SECOND");
    }

    #[tokio::test]
    async fn append_line_creates_a_missing_parent_directory() {
        // The regression this guards: TypeScript's `writeBatch` does
        // `mkdir(dirname(path), { recursive: true })` before every write.
        // Without the Rust equivalent, a slot whose runtime-home directory
        // does not exist yet would buffer every record, drop them past
        // `MAX_BUFFERED_RECORDS`, and never manage to write even the
        // sidecar `.error` file explaining why — a silent no-op audit log.
        let dir = scratch_dir("missing-parent");
        let path = dir.join("does-not-exist-yet").join("audit.log");
        let audit = FileAudit::new(
            path.clone(),
            Arc::new(FixedWallClock::new(SystemTime::now())),
        );

        audit.record(entry("runtime.health", Outcome::Ok)).await;

        let lines = read_lines(&path);
        assert_eq!(
            lines.len(),
            1,
            "a missing parent directory must be created on demand, not buffered against"
        );
    }
}
