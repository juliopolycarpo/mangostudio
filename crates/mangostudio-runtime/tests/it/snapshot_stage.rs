//! Checkpoints of files too large for one frame, through a real `stdio` runtime.
//!
//! The in-crate tests prove each method; this proves the whole path over real
//! pipes: a 20 MiB file captures, pulls in bounded chunks, uploads back, and
//! restores byte-identical, a file past the limit is refused with its size,
//! and (on Linux) the runtime's anonymous memory stays far below the file size.

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
/// Chunks in the memory test's warm-up transfer. Enough round trips for the
/// runtime's allocator arenas and worker threads to reach the working set
/// they keep for any file size (measured: 3 chunks leave 11-14 MiB of that
/// still to be paid inside the measured transfer; 16 leave at most 4.3 MB).
#[cfg(target_os = "linux")]
const WARM_UP_CHUNKS: usize = 16;

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

    /// The child's resident-memory counters right now.
    #[cfg(target_os = "linux")]
    fn resident_sample(&self) -> ResidentSample {
        read_resident_sample(self.pid)
            .unwrap_or_else(|error| panic!("(runtime /proc status): {error}"))
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

/// One reading of a process's resident memory, in bytes, split the way the
/// kernel splits it.
#[cfg(target_os = "linux")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ResidentSample {
    /// `VmHWM`: the kernel's high-water mark of total RSS (anon + file + shmem).
    peak_total: u64,
    /// `VmRSS`: total RSS now.
    total: u64,
    /// `RssAnon`: heap, stacks and copy-on-written pages. This is the part a
    /// program that buffers a file grows.
    anon: u64,
    /// `RssFile`: mapped file pages (the binary's code and data), which the
    /// kernel faults in and drops by its own readahead and pressure rules, not
    /// by anything the program allocates. Total RSS includes it; the test's
    /// bound does not.
    file: u64,
    shmem: u64,
}

/// Parses the `VmHWM`, `VmRSS`, `RssAnon`, `RssFile` and `RssShmem` lines of a
/// `/proc/<pid>/status` text; each is reported in kB.
#[cfg(target_os = "linux")]
fn parse_resident_sample(status: &str) -> Result<ResidentSample, String> {
    let field = |name: &str| -> Result<u64, String> {
        let prefix = format!("{name}:");
        let kib = status
            .lines()
            .find_map(|line| line.strip_prefix(prefix.as_str()))
            .and_then(|rest| rest.trim().trim_end_matches("kB").trim().parse::<u64>().ok())
            .ok_or_else(|| {
                format!("expected a `{name}: <n> kB` line in the /proc status text | received: {status:?}")
            })?;
        Ok(kib * 1024)
    };
    Ok(ResidentSample {
        peak_total: field("VmHWM")?,
        total: field("VmRSS")?,
        anon: field("RssAnon")?,
        file: field("RssFile")?,
        shmem: field("RssShmem")?,
    })
}

#[cfg(target_os = "linux")]
fn read_resident_sample(pid: u32) -> Result<ResidentSample, String> {
    let status = std::fs::read_to_string(format!("/proc/{pid}/status"))
        .map_err(|error| format!("cannot read /proc/{pid}/status: {error}"))?;
    parse_resident_sample(&status)
}

/// Tracks the highest `RssAnon` a process reaches while it works. The kernel
/// keeps a high-water mark for total RSS only, so anonymous memory is polled
/// from a plain thread (independent of the test's async runtime). A buffer the
/// size of the file lives for the whole copy, many polls long; the one-chunk
/// buffers that come and go are what the bound allows for.
#[cfg(target_os = "linux")]
struct AnonPeakSampler {
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
    /// Highest `RssAnon` seen, and how many reads succeeded.
    seen: std::sync::Arc<(std::sync::atomic::AtomicU64, std::sync::atomic::AtomicU64)>,
    thread: std::thread::JoinHandle<()>,
}

#[cfg(target_os = "linux")]
impl AnonPeakSampler {
    fn start(pid: u32) -> Self {
        use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
        let stop = std::sync::Arc::new(AtomicBool::new(false));
        let seen = std::sync::Arc::new((AtomicU64::new(0), AtomicU64::new(0)));
        let thread = std::thread::spawn({
            let (stop, seen) = (stop.clone(), seen.clone());
            move || {
                while !stop.load(Ordering::Relaxed) {
                    if let Ok(sample) = read_resident_sample(pid) {
                        seen.0.fetch_max(sample.anon, Ordering::Relaxed);
                        seen.1.fetch_add(1, Ordering::Relaxed);
                    }
                    std::thread::sleep(Duration::from_millis(1));
                }
            }
        });
        Self { stop, seen, thread }
    }

    /// The highest `RssAnon` observed. Panics when no read succeeded: a
    /// sampler that saw nothing would report zero growth and pass any bound.
    fn finish(self) -> u64 {
        use std::sync::atomic::Ordering;
        self.stop.store(true, Ordering::Relaxed);
        self.thread
            .join()
            .expect("the sampler thread does not panic");
        let (peak, reads) = (
            self.seen.0.load(Ordering::Relaxed),
            self.seen.1.load(Ordering::Relaxed),
        );
        assert!(
            reads > 0,
            "(runtime anonymous memory sampler): expected at least one successful /proc status read during the transfer | received: {reads} reads"
        );
        peak
    }
}

#[cfg(target_os = "linux")]
#[test]
fn a_proc_status_text_parses_into_its_resident_counters() {
    let status = "Name:\tmangostudio-run\nVmHWM:\t   78008 kB\nVmRSS:\t   70000 kB\nRssAnon:\t   20000 kB\nRssFile:\t   49000 kB\nRssShmem:\t       8 kB\nThreads:\t4\n";
    assert_eq!(
        parse_resident_sample(status),
        Ok(ResidentSample {
            peak_total: 78008 * 1024,
            total: 70000 * 1024,
            anon: 20000 * 1024,
            file: 49000 * 1024,
            shmem: 8 * 1024,
        }),
        "(parse_resident_sample): expected every counter converted from kB to bytes"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn a_proc_status_text_without_an_anon_counter_names_the_missing_line() {
    let error = parse_resident_sample("VmHWM:\t1 kB\nVmRSS:\t1 kB\n")
        .expect_err("a status text without RssAnon cannot be sampled");
    assert!(
        error.contains("`RssAnon: <n> kB`"),
        "(parse_resident_sample): expected the error to name the missing RssAnon line | received: {error}"
    );
}

/// The point of staging: a large file's capture and restore never hold the
/// file in memory. After a warm-up transfer of [`WARM_UP_CHUNKS`] chunks, the
/// runtime's anonymous memory (`RssAnon`, polled during the transfer) may grow
/// by chunk buffers only, never by anything near the file's size.
///
/// Why this metric and this warm-up: the test used to compare the runtime's
/// total `VmHWM` before and after, with a 3-chunk warm-up. The runtime's
/// allocator arenas and blocking-pool threads had not reached their working
/// set yet, so 11-13 MiB of first-use anonymous memory landed in the measured
/// transfer when idle and up to 20 MiB under CPU load, past the 16 MiB bound
/// (the flake in #2695). That growth was a constant, not a function of file
/// size: anonymous memory settled near 37 MiB for 16, 32, 64 and 192 MiB
/// files alike, so the runtime does not buffer the file. After the 16-chunk
/// warm-up the growth measured 0.04-4.3 MB over 16 runs, idle and with 24
/// busy loops, so the bound has a 3.9x margin above the worst run and sits
/// at a quarter of the file. A regression that buffers the file grows by the
/// file's size (66.8 MiB observed with `copy_hashing` reading it whole).
/// `RssFile` is left out because the kernel's readahead and memory pressure
/// move it, not the program. Not yet measured under `cargo llvm-cov`: do not
/// tighten the bound before that.
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
    write_pattern_file(&warm, WARM_UP_CHUNKS * CHUNK_BYTES);
    capture_pull_push_restore(
        &runtime,
        &home,
        &warm,
        "hub-upload-warm",
        WARM_UP_CHUNKS * CHUNK_BYTES,
    )
    .await;
    let big = home.join("big.bin");
    write_pattern_file(&big, file_bytes);
    let before = runtime.resident_sample();

    let sampler = AnonPeakSampler::start(runtime.pid);
    capture_pull_push_restore(&runtime, &home, &big, "hub-upload-mem", file_bytes).await;
    let after = runtime.resident_sample();
    let anon_peak = sampler.finish().max(after.anon);

    let anon_growth = anon_peak.saturating_sub(before.anon);
    eprintln!(
        "snapshot stage memory: file {file_bytes} B, before {before:?}, after {after:?}, anon peak {anon_peak} B, anon growth {anon_growth} B, old metric (VmHWM growth) {} B",
        after.peak_total.saturating_sub(before.peak_total)
    );
    assert!(
        anon_growth < allowed_growth_bytes,
        "(runtime anonymous memory): expected growth under {allowed_growth_bytes} bytes for a {file_bytes}-byte file | received: baseline {}, peak {anon_peak}, growth {anon_growth}",
        before.anon
    );
    runtime.finish().await;
}
