//! Checkpoints of files too large for one frame, through a real `stdio` runtime.
//!
//! The in-crate tests prove each method; this proves the whole path over real
//! pipes: a 20 MiB file captures, pulls in bounded chunks, uploads back, and
//! restores byte-identical, a file past the limit is refused with its size,
//! and (on Linux) the runtime's peak memory stays far below the file size.

use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use mango_protocol::close::close_codes;
use mango_protocol::session::{Session, SessionOptions};
use mango_protocol::transports::spawn::{SpawnOptions, sanitized_env, spawn_port};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::support::scratch::{ScratchDir, scratch_dir};

const CHUNK_BYTES: usize = 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

fn binary_path() -> String {
    env!("CARGO_BIN_EXE_mangostudio-runtime").to_string()
}

fn scratch_home(name: &str) -> ScratchDir {
    scratch_dir(&format!("snapshot-stage-test-{name}"))
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes.iter().fold(String::new(), |mut text, byte| {
        let _ = write!(text, "{byte:02x}");
        text
    })
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

/// Deterministic non-repeating-enough content, so a dropped or reordered
/// chunk changes the digest.
fn pattern_bytes(len: usize) -> Vec<u8> {
    (0..len)
        .map(|index| ((index.wrapping_mul(2_654_435_761)) >> 13) as u8)
        .collect()
}

struct StdioRuntime {
    session: Session,
    driver: tokio::task::JoinHandle<()>,
    /// Read only by the Linux memory measurement.
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pid: u32,
}

impl StdioRuntime {
    async fn start(home: &ScratchDir) -> Self {
        let env = sanitized_env([(
            "MANGO_HOME".to_string(),
            home.to_string_lossy().into_owned(),
        )]);
        let options = SpawnOptions::new([binary_path(), "stdio".to_string()]).with_env(env);
        let (port, launched) = spawn_port(options).expect("the argv names a real binary");
        let (session, driver) =
            Session::spawn(port, SessionOptions::new(crate::support::peer("hub")));
        tokio::time::timeout(Duration::from_secs(10), session.ready())
            .await
            .expect("the child must say hello within the timeout")
            .expect("the handshake succeeds");
        Self {
            session,
            driver: tokio::spawn(async move {
                let _ = driver.await;
            }),
            pid: launched.pid().expect("a spawned child has a pid"),
        }
    }

    async fn call(
        &self,
        method: &str,
        params: Value,
    ) -> Result<Value, mango_protocol::RemoteError> {
        tokio::time::timeout(REQUEST_TIMEOUT, self.session.request(method, params))
            .await
            .unwrap_or_else(|_| panic!("({method}): expected an answer within {REQUEST_TIMEOUT:?}"))
    }

    async fn pull_staged(&self, staged_id: &str, size: u64) -> Vec<u8> {
        let mut downloaded = Vec::with_capacity(size as usize);
        loop {
            let chunk = self
                .call(
                    "snapshot.read-chunk",
                    json!({"stagedId": staged_id, "offset": downloaded.len(), "length": CHUNK_BYTES}),
                )
                .await
                .expect("a staged capture can be read");
            let chunk = STANDARD
                .decode(chunk["contentBase64"].as_str().unwrap())
                .unwrap();
            if chunk.is_empty() {
                return downloaded;
            }
            downloaded.extend_from_slice(&chunk);
        }
    }

    async fn push_staged(&self, staged_id: &str, bytes: &[u8]) {
        let mut offset = 0;
        for chunk in bytes.chunks(CHUNK_BYTES) {
            let staged = self
                .call(
                    "snapshot.stage-chunk",
                    json!({"stagedId": staged_id, "offset": offset, "contentBase64": STANDARD.encode(chunk)}),
                )
                .await
                .expect("a chunk can be staged in order");
            offset += chunk.len();
            assert_eq!(staged["stagedBytes"], offset);
        }
    }

    /// The child's peak resident set in bytes, from the kernel's high-water mark.
    #[cfg(target_os = "linux")]
    fn peak_resident_bytes(&self) -> u64 {
        let status = std::fs::read_to_string(format!("/proc/{}/status", self.pid))
            .expect("the child is alive while the session is open");
        let kib: u64 = status
            .lines()
            .find_map(|line| line.strip_prefix("VmHWM:"))
            .and_then(|rest| rest.trim().trim_end_matches("kB").trim().parse().ok())
            .expect("a Linux /proc status file reports VmHWM");
        kib * 1024
    }

    async fn finish(self) {
        self.session
            .close(close_codes::RELEASED, Some("test done"))
            .await;
        let _ = self.driver.await;
    }
}

#[tokio::test]
async fn a_twenty_mebibyte_file_captures_in_chunks_and_restores_byte_identical() {
    let home = scratch_home("roundtrip");
    let runtime = StdioRuntime::start(&home).await;
    let original = home.join("original.bin");
    let bytes = pattern_bytes(20 * 1024 * 1024 + 7);
    std::fs::write(&original, &bytes).unwrap();

    let captured = runtime
        .call("snapshot.capture", json!({"path": original}))
        .await
        .expect("a 20 MiB file is within the default checkpoint limit");
    assert_eq!(captured["exists"], true);
    assert_eq!(
        captured.get("contentBase64"),
        None,
        "(snapshot.capture): a 20 MiB capture must stage, not inline | received keys: {:?}",
        captured
            .as_object()
            .map(|object| object.keys().collect::<Vec<_>>())
    );
    assert_eq!(captured["hash"], sha256_hex(&bytes));
    let staged_id = captured["stagedId"].as_str().unwrap().to_owned();
    let size = captured["sizeBytes"].as_u64().unwrap();

    let pulled = runtime.pull_staged(&staged_id, size).await;
    assert_eq!(
        (pulled.len(), sha256_hex(&pulled)),
        (bytes.len(), sha256_hex(&bytes)),
        "(snapshot.read-chunk): the reassembled capture must match the file"
    );
    runtime
        .call("snapshot.release", json!({"stagedId": staged_id}))
        .await
        .expect("a staged capture can be released");
    let after_release = runtime
        .call(
            "snapshot.read-chunk",
            json!({"stagedId": staged_id, "offset": 0, "length": 1}),
        )
        .await
        .expect_err("a released capture must be gone");
    assert_eq!(
        after_release.details.as_ref().unwrap()["kind"],
        "snapshot_stage_missing"
    );

    // Revert: the hub uploads the bytes it kept and names them in a restore.
    let restored = home.join("restored.bin");
    std::fs::write(&restored, b"after the mutation").unwrap();
    runtime.push_staged("hub-upload-1", &pulled).await;
    let reverted = runtime
        .call(
            "snapshot.revert",
            json!({
                "chatId": "chat",
                "expected": [{"path": restored, "afterHash": sha256_hex(b"after the mutation")}],
                "operations": [{
                    "type": "restore",
                    "path": restored,
                    "stagedId": "hub-upload-1",
                    "hash": sha256_hex(&bytes),
                }],
            }),
        )
        .await
        .expect("a staged upload restores");
    assert_eq!(reverted["revertedFiles"], 1);
    let on_disk = std::fs::read(&restored).unwrap();
    assert_eq!(
        (on_disk.len(), sha256_hex(&on_disk)),
        (bytes.len(), sha256_hex(&bytes)),
        "(snapshot.revert): the restored file must be byte-identical to the original"
    );

    runtime.finish().await;
}

#[tokio::test]
async fn a_file_past_the_requested_limit_is_refused_with_its_size_and_the_limit() {
    let home = scratch_home("limit");
    let runtime = StdioRuntime::start(&home).await;
    let big = home.join("big.bin");
    std::fs::write(&big, pattern_bytes(3 * 1024 * 1024)).unwrap();

    let error = runtime
        .call(
            "snapshot.capture",
            json!({"path": big, "snapshotMaxBytes": 1024 * 1024}),
        )
        .await
        .expect_err("a 3 MiB file is past a 1 MiB limit");

    let details = error.details.as_ref().unwrap();
    assert_eq!(
        (
            details["kind"].as_str(),
            details["sizeBytes"].as_u64(),
            details["limitBytes"].as_u64()
        ),
        (
            Some("snapshot_too_large"),
            Some(3 * 1024 * 1024),
            Some(1024 * 1024)
        ),
        "(snapshot.capture): expected snapshot_too_large naming size and limit | received: {error:?}"
    );
    runtime.finish().await;
}

/// Writes `file_bytes` of repeating pattern in slices, so the test process
/// itself never holds the file.
#[cfg(target_os = "linux")]
fn write_pattern_file(path: &std::path::Path, file_bytes: usize) {
    use std::io::Write as _;
    let slice = pattern_bytes(CHUNK_BYTES);
    let mut file = std::fs::File::create(path).unwrap();
    for _ in 0..file_bytes / CHUNK_BYTES {
        file.write_all(&slice).unwrap();
    }
}

/// Captures `big`, pulls the capture and pushes it back as an upload in
/// bounded slices (hashing as it goes so this side stays bounded too), then
/// restores the upload over a stand-in file.
#[cfg(target_os = "linux")]
async fn capture_pull_push_restore(
    runtime: &StdioRuntime,
    home: &ScratchDir,
    big: &std::path::Path,
    upload_id: &str,
    file_bytes: usize,
) {
    let captured = runtime
        .call(
            "snapshot.capture",
            json!({"path": big, "snapshotMaxBytes": file_bytes * 2}),
        )
        .await
        .expect("the file is within the requested limit");
    let staged_id = captured["stagedId"].as_str().unwrap().to_owned();
    let size = captured["sizeBytes"].as_u64().unwrap();
    assert_eq!(size, file_bytes as u64);

    let mut hasher = Sha256::new();
    let mut offset = 0_u64;
    while offset < size {
        let chunk = runtime
            .call(
                "snapshot.read-chunk",
                json!({"stagedId": staged_id, "offset": offset, "length": CHUNK_BYTES}),
            )
            .await
            .unwrap();
        let chunk = STANDARD
            .decode(chunk["contentBase64"].as_str().unwrap())
            .unwrap();
        hasher.update(&chunk);
        runtime
            .call(
                "snapshot.stage-chunk",
                json!({"stagedId": upload_id, "offset": offset, "contentBase64": STANDARD.encode(&chunk)}),
            )
            .await
            .unwrap();
        offset += chunk.len() as u64;
    }
    let digest = hex(&hasher.finalize());
    assert_eq!(captured["hash"], digest);

    let restored = home.join(format!("restored-{upload_id}.bin"));
    std::fs::write(&restored, b"after").unwrap();
    runtime
        .call(
            "snapshot.revert",
            json!({
                "chatId": "chat",
                "expected": [{"path": restored, "afterHash": sha256_hex(b"after")}],
                "operations": [{
                    "type": "restore", "path": restored,
                    "stagedId": upload_id, "hash": digest,
                }],
            }),
        )
        .await
        .expect("a large staged upload restores");
    assert_eq!(
        std::fs::metadata(&restored).unwrap().len(),
        file_bytes as u64
    );
}

/// The point of staging: a large file's capture and restore never hold the
/// file in memory. After a small warm-up transfer (which loads the schemas
/// and buffers the first request pays for), the runtime's peak resident set
/// may grow by chunk buffers only, never by anything near the file's size.
///
/// The file is 64 MiB so the debug build finishes in about a minute; set
/// `SNAPSHOT_STAGE_MEMORY_FILE_MIB` (for example 200) to measure a larger one.
/// The allowed growth is a quarter of the file, so a regression that buffers
/// the whole file fails at any size.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn capturing_and_restoring_a_large_file_keeps_runtime_memory_bounded() {
    let file_mib: usize = std::env::var("SNAPSHOT_STAGE_MEMORY_FILE_MIB")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(64);
    let file_bytes = file_mib * 1024 * 1024;
    let allowed_growth_bytes = (file_bytes / 4) as u64;

    let home = scratch_home("memory");
    let runtime = StdioRuntime::start(&home).await;
    let warm = home.join("warm.bin");
    write_pattern_file(&warm, 3 * CHUNK_BYTES);
    capture_pull_push_restore(&runtime, &home, &warm, "hub-upload-warm", 3 * CHUNK_BYTES).await;
    let big = home.join("big.bin");
    write_pattern_file(&big, file_bytes);
    let baseline = runtime.peak_resident_bytes();

    capture_pull_push_restore(&runtime, &home, &big, "hub-upload-mem", file_bytes).await;

    let peak = runtime.peak_resident_bytes();
    assert!(
        peak.saturating_sub(baseline) < allowed_growth_bytes,
        "(runtime peak RSS): expected growth under {allowed_growth_bytes} bytes for a {file_bytes}-byte file | received: baseline {baseline}, peak {peak}, growth {}",
        peak.saturating_sub(baseline)
    );
    eprintln!(
        "snapshot stage memory: file {file_bytes} B, baseline {baseline} B, peak {peak} B, growth {} B",
        peak.saturating_sub(baseline)
    );
    runtime.finish().await;
}
