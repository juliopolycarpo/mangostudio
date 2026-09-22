//! Capture, hash, and reverse replay of filesystem checkpoint snapshots.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use mango_protocol::error::{RemoteError, codes};
use mango_protocol::session::CallContext;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::freshness::{ContentDigest, ReadObservation};
use super::io;
use super::params::{
    SnapshotCaptureParams, SnapshotExpectedPath, SnapshotHashParams, SnapshotRevertOperation,
    SnapshotRevertParams,
};
use super::policy::PathPolicy;
use super::service::{ResponseBudget, Service, before_json, lock_error, snapshot_limit};
use crate::blocking::run_blocking;
use crate::ports::audit::lock;
use crate::registry::Registry;

pub(super) const SNAPSHOT_MAX_BYTES: usize = 8 * 1024 * 1024;
const ABSENT_HASH: &str = "absent";

/// Registers the snapshot methods beside the filesystem methods that produce their data.
pub(super) fn register(registry: Registry, service: Arc<Service>) -> Registry {
    let capture = Arc::clone(&service);
    let hash = Arc::clone(&service);
    registry
        .implement("snapshot.capture", move |params, context: CallContext| {
            let response = ResponseBudget::from_context(&context);
            Arc::clone(&capture).capture_snapshot(params, response, context.cancel().clone())
        })
        .implement("snapshot.hash", move |params, context: CallContext| {
            Arc::clone(&hash).hash_snapshot(params, context.cancel().clone())
        })
        .implement("snapshot.revert", move |params, context: CallContext| {
            let response = ResponseBudget::from_context(&context);
            Arc::clone(&service).revert_snapshots(params, response, context.cancel().clone())
        })
}

impl Service {
    async fn capture_snapshot(
        self: Arc<Self>,
        params: SnapshotCaptureParams,
        response: ResponseBudget,
        cancel: CancellationToken,
    ) -> Result<Value, RemoteError> {
        let guards = self
            .state
            .locks
            .acquire(vec![params.path.clone()], &cancel)
            .await
            .map_err(lock_error)?;
        run_blocking(move || {
            let _guards = guards;
            let policy =
                self.compile_policy("snapshot.capture", &None, &[&params.path], false, &cancel)?;
            if !io::path_is_file(&policy, &params.path)? {
                let result = json!({"exists":false});
                let result = response.preflight_snapshot(result)?;
                return Ok(result);
            }
            let (size, _) = io::current_metadata(&policy, &params.path)?;
            snapshot_limit(&params.path, size)?;
            let observed = io::read(&policy, &params.path, SNAPSHOT_MAX_BYTES, &cancel)?;
            let result = before_json(Some(&observed.bytes));
            let result = response.preflight_snapshot(result)?;
            Ok(result)
        })
        .await
    }

    async fn hash_snapshot(
        self: Arc<Self>,
        params: SnapshotHashParams,
        cancel: CancellationToken,
    ) -> Result<Value, RemoteError> {
        let guards = self
            .state
            .locks
            .acquire(vec![params.path.clone()], &cancel)
            .await
            .map_err(lock_error)?;
        run_blocking(move || {
            let _guards = guards;
            let policy =
                self.compile_policy("snapshot.hash", &None, &[&params.path], false, &cancel)?;
            let hash = io::hash_file_if_present_cancellable(&policy, &params.path, &cancel)?;
            Ok(json!({"hash":hash}))
        })
        .await
    }

    async fn revert_snapshots(
        self: Arc<Self>,
        params: SnapshotRevertParams,
        response: ResponseBudget,
        cancel: CancellationToken,
    ) -> Result<Value, RemoteError> {
        self.revert_snapshots_with_hasher(params, response, cancel, NativeSnapshotHasher)
            .await
    }

    async fn revert_snapshots_with_hasher<H>(
        self: Arc<Self>,
        params: SnapshotRevertParams,
        response: ResponseBudget,
        cancel: CancellationToken,
        hasher: H,
    ) -> Result<Value, RemoteError>
    where
        H: SnapshotHasher + Send + 'static,
    {
        self.revert_snapshots_with_components(
            params,
            response,
            cancel,
            hasher,
            NativeSnapshotPolicyCompiler,
        )
        .await
    }

    async fn revert_snapshots_with_components<H, P>(
        self: Arc<Self>,
        mut params: SnapshotRevertParams,
        response: ResponseBudget,
        cancel: CancellationToken,
        mut hasher: H,
        mut compiler: P,
    ) -> Result<Value, RemoteError>
    where
        H: SnapshotHasher + Send + 'static,
        P: SnapshotPolicyCompiler + Send + 'static,
    {
        // The TypeScript entry point treats an empty optional root as absent.
        params.containment_root = params
            .containment_root
            .filter(|root| !root.as_os_str().is_empty());
        let paths = revert_paths(&params);
        let guards = self
            .state
            .locks
            .acquire(paths, &cancel)
            .await
            .map_err(lock_error)?;
        run_blocking(move || {
            let _guards = guards;
            let requested_policy = PathPolicy {
                containment_root: params.containment_root.clone(),
                ..PathPolicy::default()
            };
            let all_paths = revert_paths(&params);
            assert_initial_containment(params.containment_root.as_deref(), &all_paths)?;
            let checked_paths = all_paths.iter().map(PathBuf::as_path).collect::<Vec<_>>();
            let policy = compiler.compile(
                &self,
                "snapshot.revert",
                &Some(requested_policy.clone()),
                &checked_paths,
                false,
                &cancel,
            )?;
            let reverted = decide_revert(&policy, &params.expected, &cancel, &mut hasher)?;
            // The expected-state pass is the last safe cancellation point. The
            // replay below is one reverse transaction from the caller's point
            // of view, so a cancellation after the first mutation must not
            // leave a set that neither matches its after-state nor its restored
            // state on a retry.
            let reverted_files = params
                .operations
                .iter()
                .map(SnapshotRevertOperation::path)
                .collect::<std::collections::HashSet<_>>()
                .len();
            let result = json!({"revertedFiles":reverted_files});
            let result = response.preflight_snapshot(result)?;
            // Expected-state hashing can take long enough for permission or a
            // containment path to change. Repeat both checks immediately
            // before the first possible mutation while the whole path set is
            // still locked.
            let policy = compiler.compile(
                &self,
                "snapshot.revert",
                &Some(requested_policy),
                &checked_paths,
                false,
                &cancel,
            )?;
            // `compile` checks cancellation before its own authorization and
            // path work. Check again after that work so a cancellation that
            // lands while it runs cannot report an idempotent success or
            // begin replay.
            io::check_cancel(&cancel)?;
            if reverted {
                return Ok(result);
            }
            for operation in &params.operations {
                match operation {
                    SnapshotRevertOperation::Create { path } => {
                        remove_created_file(&policy, path)?;
                        lock(&self.state.ledger).forget(&params.chat_id, path);
                    }
                    SnapshotRevertOperation::Restore {
                        path,
                        content_base64,
                    } => restore_bytes(&self, &policy, &params.chat_id, path, content_base64)?,
                    SnapshotRevertOperation::Move {
                        path,
                        moved_to,
                        content_base64,
                    } => {
                        io::assert_regular(&policy, moved_to, "revert move")?;
                        io::move_no_overwrite(&policy, moved_to, path)?;
                        lock(&self.state.ledger).rekey(&params.chat_id, moved_to, path);
                        restore_bytes(&self, &policy, &params.chat_id, path, content_base64)?;
                    }
                }
            }
            Ok(result)
        })
        .await
    }
}

impl SnapshotRevertOperation {
    fn path(&self) -> &Path {
        match self {
            Self::Create { path } | Self::Restore { path, .. } | Self::Move { path, .. } => path,
        }
    }

    fn paths(&self) -> impl Iterator<Item = &Path> {
        let (first, second) = match self {
            Self::Create { path } | Self::Restore { path, .. } => (path.as_path(), None),
            Self::Move { path, moved_to, .. } => (path.as_path(), Some(moved_to.as_path())),
        };
        std::iter::once(first).chain(second)
    }
}

fn revert_paths(params: &SnapshotRevertParams) -> Vec<PathBuf> {
    params
        .expected
        .iter()
        .map(|entry| entry.path.clone())
        .chain(
            params
                .operations
                .iter()
                .flat_map(SnapshotRevertOperation::paths)
                .map(Path::to_path_buf),
        )
        .collect()
}

/// Mirrors the TypeScript snapshot entry point's user-facing containment
/// error. The compiled policy below repeats the decision under the same locks
/// and binds each actual filesystem operation to verified handles.
fn assert_initial_containment(root: Option<&Path>, paths: &[PathBuf]) -> Result<(), RemoteError> {
    let Some(root) = root else {
        return Ok(());
    };
    let policy = PathPolicy {
        containment_root: Some(root.to_path_buf()),
        ..PathPolicy::default()
    }
    .compile()
    .map_err(|error| {
        io::path_error(format!(
            "Cannot resolve the chat working directory \"{}\": {}",
            root.display(),
            error.message
        ))
    })?;
    for path in paths {
        if !policy.allows(path) {
            return Err(io::path_error(format!(
                "Path \"{}\" is outside the chat working directory. Use a path inside \"{}\".",
                path.display(),
                root.display()
            )));
        }
    }
    Ok(())
}

trait SnapshotHasher {
    fn hash_if_present(
        &mut self,
        policy: &super::policy::CompiledPolicy,
        path: &Path,
        cancel: &CancellationToken,
    ) -> Result<Option<String>, RemoteError>;
}

struct NativeSnapshotHasher;

impl SnapshotHasher for NativeSnapshotHasher {
    fn hash_if_present(
        &mut self,
        policy: &super::policy::CompiledPolicy,
        path: &Path,
        cancel: &CancellationToken,
    ) -> Result<Option<String>, RemoteError> {
        io::hash_file_if_present_cancellable(policy, path, cancel)
    }
}

trait SnapshotPolicyCompiler {
    fn compile(
        &mut self,
        service: &Service,
        method: &str,
        policy: &Option<PathPolicy>,
        paths: &[&Path],
        capture_snapshot: bool,
        cancel: &CancellationToken,
    ) -> Result<super::policy::CompiledPolicy, RemoteError>;
}

struct NativeSnapshotPolicyCompiler;

impl SnapshotPolicyCompiler for NativeSnapshotPolicyCompiler {
    fn compile(
        &mut self,
        service: &Service,
        method: &str,
        policy: &Option<PathPolicy>,
        paths: &[&Path],
        capture_snapshot: bool,
        cancel: &CancellationToken,
    ) -> Result<super::policy::CompiledPolicy, RemoteError> {
        service.compile_policy(method, policy, paths, capture_snapshot, cancel)
    }
}

fn decide_revert(
    policy: &super::policy::CompiledPolicy,
    expected: &[SnapshotExpectedPath],
    cancel: &CancellationToken,
    hasher: &mut impl SnapshotHasher,
) -> Result<bool, RemoteError> {
    let reverted = already_reverted(policy, expected, cancel, hasher)?;
    // This must be after the final expected-state hash, including idempotent
    // retries, and before replay starts.
    io::check_cancel(cancel)?;
    Ok(reverted)
}

fn already_reverted(
    policy: &super::policy::CompiledPolicy,
    expected: &[SnapshotExpectedPath],
    cancel: &CancellationToken,
    hasher: &mut impl SnapshotHasher,
) -> Result<bool, RemoteError> {
    let mut pending_path = None;
    let mut reverted_path = None;
    for entry in expected {
        let observed = hasher
            .hash_if_present(policy, &entry.path, cancel)?
            .unwrap_or_else(|| ABSENT_HASH.to_owned());
        let matches_after = observed == entry.after_hash;
        let matches_reverted = entry
            .reverted_hash
            .as_ref()
            .is_some_and(|hash| observed == *hash);
        if !matches_after && !matches_reverted {
            return Err(snapshot_conflict(&entry.path));
        }
        if matches_after && !matches_reverted {
            pending_path.get_or_insert(&entry.path);
        } else if matches_reverted && !matches_after {
            reverted_path.get_or_insert(&entry.path);
        }
    }
    if pending_path.is_some()
        && let Some(path) = reverted_path
    {
        return Err(snapshot_conflict(path));
    }
    Ok(reverted_path.is_some())
}

fn restore_bytes(
    service: &Service,
    policy: &super::policy::CompiledPolicy,
    chat_id: &str,
    path: &Path,
    content_base64: &str,
) -> Result<(), RemoteError> {
    let bytes = decode_node_base64(content_base64);
    let mtime = service.write_io.write_atomic(policy, path, &bytes)?;
    let digest = ContentDigest::of(&bytes);
    lock(&service.state.ledger).record_read_digest(
        chat_id,
        path,
        &digest,
        mtime,
        ReadObservation::WholeFile,
    );
    Ok(())
}

fn remove_created_file(
    policy: &super::policy::CompiledPolicy,
    path: &Path,
) -> Result<(), RemoteError> {
    match io::delete_file(policy, path) {
        Ok(()) => Ok(()),
        Err(error) if io::is_not_found(&error) => Ok(()),
        Err(error) => Err(error),
    }
}

fn snapshot_conflict(path: &Path) -> RemoteError {
    RemoteError::new(
        codes::INTERNAL,
        format!(
            "Cannot revert \"{}\": the file changed on disk since this assistant message completed.",
            path.display()
        ),
    )
    .with_detail("kind", "snapshot_conflict")
    .with_detail("resolvedPath", path.display().to_string())
}

/// Decodes the permissive `Buffer.from(value, "base64")` subset used by the
/// TypeScript runtime: each UTF-16 code unit is truncated to its low byte,
/// ASCII noise is ignored, both alphabets are accepted, and the first padding
/// marker ends the input.
fn decode_node_base64(content: &str) -> Vec<u8> {
    let mut sextets = Vec::with_capacity(content.len());
    for byte in content.encode_utf16().map(|unit| unit as u8) {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            _ => continue,
        };
        sextets.push(value);
    }
    let mut bytes = Vec::with_capacity(sextets.len() / 4 * 3 + 2);
    let (groups, remainder) = sextets.as_chunks::<4>();
    for group in groups {
        bytes.push(group[0] << 2 | group[1] >> 4);
        bytes.push(group[1] << 4 | group[2] >> 2);
        bytes.push(group[2] << 6 | group[3]);
    }
    match remainder {
        [first, second] => bytes.push(first << 2 | second >> 4),
        [first, second, third] => {
            bytes.push(first << 2 | second >> 4);
            bytes.push(second << 4 | third >> 2);
        }
        [] | [_] => {}
        _ => unreachable!("base64 remainder is at most three sextets"),
    }
    bytes
}

#[cfg(test)]
mod tests {
    use std::sync::{
        Arc, Mutex as StdMutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc,
    };
    use std::time::Duration;

    use serde_json::json;

    use super::*;
    use crate::consent::source::ConsentSource;
    use crate::filesystem::io::sha256_hex as hash_bytes;
    use crate::filesystem::service::{NativeMoveIo, NativeWriteIo, State, WriteIo};
    use crate::runtime_home::{RuntimeSlot, write_runtime_slot_config};
    use crate::test_support::{ScratchDir, scratch_dir};

    fn fixture() -> (ScratchDir, Arc<Service>) {
        fixture_with_write_io(Arc::new(NativeWriteIo))
    }

    fn fixture_with_write_io(write_io: Arc<dyn WriteIo>) -> (ScratchDir, Arc<Service>) {
        let home = scratch_dir("filesystem-snapshot");
        let service = Arc::new(Service {
            state: Arc::new(State::default()),
            consent: ConsentSource::new(RuntimeSlot::Host, home.to_path_buf()),
            move_io: Arc::new(NativeMoveIo),
            write_io,
        });
        (home, service)
    }

    struct CancellingLastHash {
        values: Vec<Option<String>>,
        cancel: CancellationToken,
    }

    impl SnapshotHasher for CancellingLastHash {
        fn hash_if_present(
            &mut self,
            _: &super::super::policy::CompiledPolicy,
            _: &Path,
            _: &CancellationToken,
        ) -> Result<Option<String>, RemoteError> {
            let value = self.values.remove(0);
            if self.values.is_empty() {
                self.cancel.cancel();
            }
            Ok(value)
        }
    }

    struct RevokingSnapshotHasher {
        home: PathBuf,
        revoked: bool,
    }

    impl SnapshotHasher for RevokingSnapshotHasher {
        fn hash_if_present(
            &mut self,
            policy: &super::super::policy::CompiledPolicy,
            path: &Path,
            cancel: &CancellationToken,
        ) -> Result<Option<String>, RemoteError> {
            let hash = io::hash_file_if_present_cancellable(policy, path, cancel)?;
            if !self.revoked {
                write_runtime_slot_config(
                    RuntimeSlot::Host,
                    &self.home,
                    &[("allow", Some(json!({"fsWrite":false})))],
                )
                .unwrap();
                self.revoked = true;
            }
            Ok(hash)
        }
    }

    struct CancellingFinalPolicyCompiler {
        cancel: CancellationToken,
        calls: usize,
    }

    impl SnapshotPolicyCompiler for CancellingFinalPolicyCompiler {
        fn compile(
            &mut self,
            service: &Service,
            method: &str,
            policy: &Option<PathPolicy>,
            paths: &[&Path],
            capture_snapshot: bool,
            cancel: &CancellationToken,
        ) -> Result<super::super::policy::CompiledPolicy, RemoteError> {
            let compiled =
                service.compile_policy(method, policy, paths, capture_snapshot, cancel)?;
            self.calls += 1;
            if self.calls == 2 {
                self.cancel.cancel();
            }
            Ok(compiled)
        }
    }

    struct CancellingReplayWriteIo {
        cancel: CancellationToken,
        writes: AtomicUsize,
    }

    impl WriteIo for CancellingReplayWriteIo {
        fn write_atomic_if_unchanged(
            &self,
            policy: &super::super::policy::CompiledPolicy,
            path: &Path,
            expected: &[u8],
            bytes: &[u8],
        ) -> Result<f64, RemoteError> {
            io::write_atomic_if_unchanged(policy, path, expected, bytes)
        }

        fn write_atomic(
            &self,
            policy: &super::super::policy::CompiledPolicy,
            path: &Path,
            bytes: &[u8],
        ) -> Result<f64, RemoteError> {
            let mtime = io::write_atomic(policy, path, bytes, false)?;
            if self.writes.fetch_add(1, Ordering::SeqCst) == 0 {
                self.cancel.cancel();
            }
            Ok(mtime)
        }
    }

    struct CountingReplayWriteIo {
        writes: AtomicUsize,
    }

    impl WriteIo for CountingReplayWriteIo {
        fn write_atomic_if_unchanged(
            &self,
            policy: &super::super::policy::CompiledPolicy,
            path: &Path,
            expected: &[u8],
            bytes: &[u8],
        ) -> Result<f64, RemoteError> {
            io::write_atomic_if_unchanged(policy, path, expected, bytes)
        }

        fn write_atomic(
            &self,
            policy: &super::super::policy::CompiledPolicy,
            path: &Path,
            bytes: &[u8],
        ) -> Result<f64, RemoteError> {
            self.writes.fetch_add(1, Ordering::SeqCst);
            io::write_atomic(policy, path, bytes, false)
        }
    }

    struct BlockingReplayWriteIo {
        started: AtomicBool,
        release: StdMutex<mpsc::Receiver<()>>,
    }

    impl WriteIo for BlockingReplayWriteIo {
        fn write_atomic_if_unchanged(
            &self,
            policy: &super::super::policy::CompiledPolicy,
            path: &Path,
            expected: &[u8],
            bytes: &[u8],
        ) -> Result<f64, RemoteError> {
            io::write_atomic_if_unchanged(policy, path, expected, bytes)
        }

        fn write_atomic(
            &self,
            policy: &super::super::policy::CompiledPolicy,
            path: &Path,
            bytes: &[u8],
        ) -> Result<f64, RemoteError> {
            self.started.store(true, Ordering::SeqCst);
            self.release
                .lock()
                .expect("test release mutex is not poisoned")
                .recv()
                .expect("test release sender remains alive");
            io::write_atomic(policy, path, bytes, false)
        }
    }

    #[cfg(unix)]
    struct ParentSwappingWriteIo {
        parent: PathBuf,
        outside: PathBuf,
        swapped: AtomicBool,
    }

    #[cfg(unix)]
    impl WriteIo for ParentSwappingWriteIo {
        fn write_atomic_if_unchanged(
            &self,
            policy: &super::super::policy::CompiledPolicy,
            path: &Path,
            expected: &[u8],
            bytes: &[u8],
        ) -> Result<f64, RemoteError> {
            io::write_atomic_if_unchanged(policy, path, expected, bytes)
        }

        fn write_atomic(
            &self,
            policy: &super::super::policy::CompiledPolicy,
            path: &Path,
            bytes: &[u8],
        ) -> Result<f64, RemoteError> {
            if !self.swapped.swap(true, Ordering::SeqCst) {
                std::fs::remove_dir_all(&self.parent).unwrap();
                std::os::unix::fs::symlink(&self.outside, &self.parent).unwrap();
            }
            io::write_atomic(policy, path, bytes, false)
        }
    }

    fn expected(path: PathBuf, after: &[u8], reverted: Option<&[u8]>) -> SnapshotExpectedPath {
        SnapshotExpectedPath {
            path,
            after_hash: hash_bytes(after),
            reverted_hash: reverted.map(hash_bytes),
        }
    }

    fn restore(path: PathBuf, content_base64: &str) -> SnapshotRevertOperation {
        SnapshotRevertOperation::Restore {
            path,
            content_base64: content_base64.to_owned(),
        }
    }

    async fn revert(
        service: &Arc<Service>,
        params: SnapshotRevertParams,
    ) -> Result<Value, RemoteError> {
        Arc::clone(service)
            .revert_snapshots(
                params,
                ResponseBudget::unbounded(),
                CancellationToken::new(),
            )
            .await
    }

    #[tokio::test]
    async fn capture_follows_regular_symlinks_and_treats_missing_or_directories_as_absent() {
        let (home, service) = fixture();
        let missing = home.join("missing");
        let directory = home.join("directory");
        std::fs::create_dir(&directory).unwrap();
        for path in [&missing, &directory] {
            let result = Arc::clone(&service)
                .capture_snapshot(
                    SnapshotCaptureParams { path: path.clone() },
                    ResponseBudget::unbounded(),
                    CancellationToken::new(),
                )
                .await
                .unwrap();
            assert_eq!(result, json!({"exists":false}));
        }

        #[cfg(unix)]
        {
            let target = home.join("target");
            let link = home.join("link");
            std::fs::write(&target, b"contents").unwrap();
            std::os::unix::fs::symlink(&target, &link).unwrap();
            let result = Arc::clone(&service)
                .capture_snapshot(
                    SnapshotCaptureParams { path: link },
                    ResponseBudget::unbounded(),
                    CancellationToken::new(),
                )
                .await
                .unwrap();
            assert_eq!(result["hash"], hash_bytes(b"contents"));
        }
    }

    #[tokio::test]
    async fn capture_enforces_the_eight_mebibyte_limit_and_preflights_its_frame() {
        let (home, service) = fixture();
        let oversized = home.join("oversized");
        std::fs::File::create(&oversized)
            .unwrap()
            .set_len((SNAPSHOT_MAX_BYTES + 1) as u64)
            .unwrap();
        let error = Arc::clone(&service)
            .capture_snapshot(
                SnapshotCaptureParams { path: oversized },
                ResponseBudget::unbounded(),
                CancellationToken::new(),
            )
            .await
            .unwrap_err();
        assert_eq!(error.details.unwrap()["kind"], "snapshot_too_large");

        let framed = home.join("framed");
        std::fs::write(&framed, vec![b'x'; 1024]).unwrap();
        let error = Arc::clone(&service)
            .capture_snapshot(
                SnapshotCaptureParams { path: framed },
                ResponseBudget::limited(128),
                CancellationToken::new(),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, codes::FRAME_TOO_LARGE);
    }

    #[tokio::test]
    async fn hash_uses_sha256_raw_bytes_and_returns_null_for_an_absent_path() {
        let (home, service) = fixture();
        let present = home.join("bytes");
        std::fs::write(&present, [0, 255, 1]).unwrap();
        let present = Arc::clone(&service)
            .hash_snapshot(
                SnapshotHashParams { path: present },
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(present["hash"], hash_bytes(&[0, 255, 1]));
        let absent = Arc::clone(&service)
            .hash_snapshot(
                SnapshotHashParams {
                    path: home.join("absent"),
                },
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert!(absent["hash"].is_null());
        std::fs::create_dir(home.join("directory")).unwrap();
        let directory = Arc::clone(&service)
            .hash_snapshot(
                SnapshotHashParams {
                    path: home.join("directory"),
                },
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert!(directory["hash"].is_null());
    }

    #[test]
    fn a_cancel_during_the_final_hash_refuses_an_already_reverted_retry() {
        let cancel = CancellationToken::new();
        let path = PathBuf::from("already-reverted");
        let expected = vec![expected(path, b"after", Some(b"before"))];
        let mut hasher = CancellingLastHash {
            values: vec![Some(hash_bytes(b"before"))],
            cancel: cancel.clone(),
        };
        let policy = PathPolicy::default().compile().unwrap();
        let error = decide_revert(&policy, &expected, &cancel, &mut hasher).unwrap_err();
        assert_eq!(error.code, codes::CANCELLED);
    }

    #[tokio::test]
    async fn replay_reverses_repeated_paths_and_refreshes_the_ledger() {
        let (home, service) = fixture();
        let path = home.join("file");
        std::fs::write(&path, b"after").unwrap();
        let result = revert(
            &service,
            SnapshotRevertParams {
                chat_id: "chat".to_owned(),
                containment_root: None,
                expected: vec![expected(path.clone(), b"after", Some(b"zero"))],
                operations: vec![
                    restore(path.clone(), "b25l"),
                    restore(path.clone(), "emVybw=="),
                ],
            },
        )
        .await
        .unwrap();
        assert_eq!(result, json!({"revertedFiles":1}));
        assert_eq!(std::fs::read(&path).unwrap(), b"zero");
        let entry = lock(&service.state.ledger)
            .complete_entry("chat", &path)
            .unwrap();
        assert_eq!(entry.sha256, hash_bytes(b"zero"));
    }

    #[tokio::test]
    async fn create_replay_tolerates_an_already_absent_file_with_a_missing_parent() {
        let (home, service) = fixture();
        let path = home.join("missing/created");
        let result = revert(
            &service,
            SnapshotRevertParams {
                chat_id: "chat".to_owned(),
                containment_root: None,
                expected: vec![SnapshotExpectedPath {
                    path: path.clone(),
                    after_hash: ABSENT_HASH.to_owned(),
                    reverted_hash: None,
                }],
                operations: vec![SnapshotRevertOperation::Create { path }],
            },
        )
        .await
        .unwrap();
        assert_eq!(result, json!({"revertedFiles":1}));
        assert!(!home.join("missing").exists());
    }

    #[tokio::test]
    async fn move_replay_restores_the_source_rekeys_then_refreshes_its_bytes() {
        let (home, service) = fixture();
        let source = home.join("source");
        let moved_to = home.join("moved");
        std::fs::write(&moved_to, b"after-move").unwrap();
        let result = revert(
            &service,
            SnapshotRevertParams {
                chat_id: "chat".to_owned(),
                containment_root: None,
                expected: vec![
                    SnapshotExpectedPath {
                        path: source.clone(),
                        after_hash: ABSENT_HASH.to_owned(),
                        reverted_hash: Some(hash_bytes(b"before-move")),
                    },
                    SnapshotExpectedPath {
                        path: moved_to.clone(),
                        after_hash: hash_bytes(b"after-move"),
                        reverted_hash: Some(ABSENT_HASH.to_owned()),
                    },
                ],
                operations: vec![SnapshotRevertOperation::Move {
                    path: source.clone(),
                    moved_to: moved_to.clone(),
                    content_base64: "YmVmb3JlLW1vdmU=".to_owned(),
                }],
            },
        )
        .await
        .unwrap();
        assert_eq!(result, json!({"revertedFiles":1}));
        assert_eq!(std::fs::read(&source).unwrap(), b"before-move");
        assert!(!moved_to.exists());
        let entry = lock(&service.state.ledger)
            .complete_entry("chat", &source)
            .unwrap();
        assert_eq!(entry.sha256, hash_bytes(b"before-move"));
    }

    #[tokio::test]
    async fn already_reverted_retries_are_noops_but_mixed_sets_conflict() {
        let (home, service) = fixture();
        let retry = home.join("retry");
        std::fs::write(&retry, b"before").unwrap();
        let result = revert(
            &service,
            SnapshotRevertParams {
                chat_id: "chat".to_owned(),
                containment_root: None,
                expected: vec![expected(retry.clone(), b"after", Some(b"before"))],
                operations: vec![restore(retry.clone(), "YmVmb3Jl")],
            },
        )
        .await
        .unwrap();
        assert_eq!(result, json!({"revertedFiles":1}));
        assert_eq!(std::fs::read(&retry).unwrap(), b"before");

        let pending = home.join("pending");
        let restored = home.join("restored");
        std::fs::write(&pending, b"after-one").unwrap();
        std::fs::write(&restored, b"before-two").unwrap();
        let error = revert(
            &service,
            SnapshotRevertParams {
                chat_id: "chat".to_owned(),
                containment_root: None,
                expected: vec![
                    expected(pending, b"after-one", Some(b"before-one")),
                    expected(restored.clone(), b"after-two", Some(b"before-two")),
                ],
                operations: vec![],
            },
        )
        .await
        .unwrap_err();
        assert_eq!(error.details.unwrap()["kind"], "snapshot_conflict");
        assert!(error.message.contains(&restored.display().to_string()));
    }

    #[tokio::test]
    async fn partial_replay_failure_returns_an_error_after_an_earlier_mutation() {
        let (home, service) = fixture();
        let first = home.join("first");
        let source = home.join("source");
        let destination = home.join("destination");
        std::fs::write(&first, b"after-first").unwrap();
        std::fs::write(&source, b"source").unwrap();
        std::fs::write(&destination, b"destination").unwrap();
        let error = revert(
            &service,
            SnapshotRevertParams {
                chat_id: "chat".to_owned(),
                containment_root: None,
                expected: vec![
                    expected(first.clone(), b"after-first", Some(b"before-first")),
                    expected(source.clone(), b"source", None),
                    expected(destination.clone(), b"destination", None),
                ],
                operations: vec![
                    restore(first.clone(), "YmVmb3JlLWZpcnN0"),
                    SnapshotRevertOperation::Move {
                        path: source,
                        moved_to: destination,
                        content_base64: "c291cmNl".to_owned(),
                    },
                ],
            },
        )
        .await
        .unwrap_err();
        assert_ne!(error.code, codes::CANCELLED);
        assert_eq!(std::fs::read(&first).unwrap(), b"before-first");
    }

    #[tokio::test]
    async fn cancellation_after_the_first_replay_operation_completes_the_replay() {
        let cancel = CancellationToken::new();
        let (home, service) = fixture_with_write_io(Arc::new(CancellingReplayWriteIo {
            cancel: cancel.clone(),
            writes: AtomicUsize::new(0),
        }));
        let first = home.join("first");
        let second = home.join("second");
        std::fs::write(&first, b"after-first").unwrap();
        std::fs::write(&second, b"after-second").unwrap();
        let result = Arc::clone(&service)
            .revert_snapshots(
                SnapshotRevertParams {
                    chat_id: "chat".to_owned(),
                    containment_root: None,
                    expected: vec![
                        expected(first.clone(), b"after-first", Some(b"before-first")),
                        expected(second.clone(), b"after-second", Some(b"before-second")),
                    ],
                    operations: vec![
                        restore(first.clone(), "YmVmb3JlLWZpcnN0"),
                        restore(second.clone(), "YmVmb3JlLXNlY29uZA=="),
                    ],
                },
                ResponseBudget::unbounded(),
                cancel.clone(),
            )
            .await
            .unwrap();
        assert_eq!(result, json!({"revertedFiles":2}));
        assert!(cancel.is_cancelled());
        assert_eq!(std::fs::read(first).unwrap(), b"before-first");
        assert_eq!(std::fs::read(second).unwrap(), b"before-second");
    }

    #[tokio::test]
    async fn consent_revoked_after_hashing_refuses_before_any_replay_write() {
        let writes = Arc::new(CountingReplayWriteIo {
            writes: AtomicUsize::new(0),
        });
        let (home, service) = fixture_with_write_io(Arc::clone(&writes) as Arc<dyn WriteIo>);
        let path = home.join("after");
        std::fs::write(&path, b"after").unwrap();
        let error = Arc::clone(&service)
            .revert_snapshots_with_hasher(
                SnapshotRevertParams {
                    chat_id: "chat".to_owned(),
                    containment_root: None,
                    expected: vec![expected(path.clone(), b"after", Some(b"before"))],
                    operations: vec![restore(path.clone(), "YmVmb3Jl")],
                },
                ResponseBudget::unbounded(),
                CancellationToken::new(),
                RevokingSnapshotHasher {
                    home: home.to_path_buf(),
                    revoked: false,
                },
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, codes::DENIED);
        assert_eq!(writes.writes.load(Ordering::SeqCst), 0);
        assert_eq!(std::fs::read(path).unwrap(), b"after");
    }

    #[tokio::test]
    async fn cancellation_during_the_final_policy_check_refuses_before_replay_writes() {
        let cancel = CancellationToken::new();
        let writes = Arc::new(CountingReplayWriteIo {
            writes: AtomicUsize::new(0),
        });
        let (home, service) = fixture_with_write_io(Arc::clone(&writes) as Arc<dyn WriteIo>);
        let path = home.join("after");
        std::fs::write(&path, b"after").unwrap();
        let error = Arc::clone(&service)
            .revert_snapshots_with_components(
                SnapshotRevertParams {
                    chat_id: "chat".to_owned(),
                    containment_root: None,
                    expected: vec![expected(path.clone(), b"after", Some(b"before"))],
                    operations: vec![restore(path.clone(), "YmVmb3Jl")],
                },
                ResponseBudget::unbounded(),
                cancel.clone(),
                NativeSnapshotHasher,
                CancellingFinalPolicyCompiler {
                    cancel: cancel.clone(),
                    calls: 0,
                },
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, codes::CANCELLED);
        assert_eq!(writes.writes.load(Ordering::SeqCst), 0);
        assert_eq!(std::fs::read(path).unwrap(), b"after");
    }

    #[tokio::test]
    async fn cancellation_during_the_final_policy_check_refuses_an_already_reverted_retry() {
        let (home, service) = fixture();
        let path = home.join("already-reverted");
        std::fs::write(&path, b"before").unwrap();
        let cancel = CancellationToken::new();
        let error = Arc::clone(&service)
            .revert_snapshots_with_components(
                SnapshotRevertParams {
                    chat_id: "chat".to_owned(),
                    containment_root: None,
                    expected: vec![expected(path.clone(), b"after", Some(b"before"))],
                    operations: vec![restore(path.clone(), "YmVmb3Jl")],
                },
                ResponseBudget::unbounded(),
                cancel.clone(),
                NativeSnapshotHasher,
                CancellingFinalPolicyCompiler { cancel, calls: 0 },
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, codes::CANCELLED);
        assert_eq!(std::fs::read(path).unwrap(), b"before");
    }

    #[tokio::test]
    async fn a_dropped_revert_call_keeps_its_path_lock_until_replay_finishes() {
        let (release_tx, release_rx) = mpsc::channel();
        let write_io = Arc::new(BlockingReplayWriteIo {
            started: AtomicBool::new(false),
            release: StdMutex::new(release_rx),
        });
        let (home, service) = fixture_with_write_io(Arc::clone(&write_io) as Arc<dyn WriteIo>);
        let path = home.join("held");
        std::fs::write(&path, b"after").unwrap();
        let task_service = Arc::clone(&service);
        let task_path = path.clone();
        let task = tokio::spawn(async move {
            task_service
                .revert_snapshots(
                    SnapshotRevertParams {
                        chat_id: "chat".to_owned(),
                        containment_root: None,
                        expected: vec![expected(task_path.clone(), b"after", Some(b"before"))],
                        operations: vec![restore(task_path, "YmVmb3Jl")],
                    },
                    ResponseBudget::unbounded(),
                    CancellationToken::new(),
                )
                .await
        });
        tokio::time::timeout(Duration::from_secs(2), async {
            while !write_io.started.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the replay must reach the blocking write");
        task.abort();
        let error = task.await.unwrap_err();
        assert!(error.is_cancelled());
        assert_eq!(service.state.locks.active_paths(), 1);
        release_tx.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            while service.state.locks.active_paths() != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the blocking replay releases its lock after completion");
        assert_eq!(std::fs::read(path).unwrap(), b"before");
    }

    #[tokio::test]
    async fn a_capture_waiting_for_a_path_lock_rechecks_revoked_consent() {
        let (home, service) = fixture();
        let path = home.join("private");
        std::fs::write(&path, b"private").unwrap();
        let cancel = CancellationToken::new();
        let held = service
            .state
            .locks
            .acquire(vec![path.clone()], &cancel)
            .await
            .unwrap();
        let pending = Arc::clone(&service).capture_snapshot(
            SnapshotCaptureParams { path },
            ResponseBudget::unbounded(),
            cancel,
        );
        tokio::pin!(pending);
        assert!(
            std::future::poll_fn(|context| std::task::Poll::Ready(
                pending.as_mut().poll(context).is_pending()
            ))
            .await
        );
        write_runtime_slot_config(
            RuntimeSlot::Host,
            &home,
            &[("allow", Some(json!({"fsRead":false})))],
        )
        .unwrap();
        drop(held);
        let error = pending.await.unwrap_err();
        assert_eq!(error.code, codes::DENIED);
        assert_eq!(service.state.locks.active_paths(), 0);
    }

    #[tokio::test]
    async fn concurrent_capture_and_revert_serialize_on_the_same_path() {
        let (home, service) = fixture();
        let path = home.join("contended");
        std::fs::write(&path, b"after").unwrap();
        let held = service
            .state
            .locks
            .acquire(vec![path.clone()], &CancellationToken::new())
            .await
            .unwrap();
        let capture_service = Arc::clone(&service);
        let capture_path = path.clone();
        let capture = tokio::spawn(async move {
            capture_service
                .capture_snapshot(
                    SnapshotCaptureParams { path: capture_path },
                    ResponseBudget::unbounded(),
                    CancellationToken::new(),
                )
                .await
        });
        tokio::task::yield_now().await;
        let revert_service = Arc::clone(&service);
        let revert_path = path.clone();
        let replay = tokio::spawn(async move {
            revert(
                &revert_service,
                SnapshotRevertParams {
                    chat_id: "chat".to_owned(),
                    containment_root: None,
                    expected: vec![expected(revert_path.clone(), b"after", Some(b"before"))],
                    operations: vec![restore(revert_path, "YmVmb3Jl")],
                },
            )
            .await
        });
        tokio::task::yield_now().await;
        drop(held);
        let captured = tokio::time::timeout(Duration::from_secs(2), capture)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let reverted = tokio::time::timeout(Duration::from_secs(2), replay)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(captured["hash"], hash_bytes(b"after"));
        assert_eq!(reverted, json!({"revertedFiles":1}));
        assert_eq!(std::fs::read(&path).unwrap(), b"before");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn revert_uses_the_typescript_containment_error_for_a_symlink_escape() {
        let (home, service) = fixture();
        let root = home.join("root");
        let outside = scratch_dir("snapshot-outside");
        std::fs::create_dir(&root).unwrap();
        let link = root.join("escape");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        let escaped = link.join("file");
        let error = revert(
            &service,
            SnapshotRevertParams {
                chat_id: "chat".to_owned(),
                containment_root: Some(root.clone()),
                expected: vec![SnapshotExpectedPath {
                    path: escaped.clone(),
                    after_hash: ABSENT_HASH.to_owned(),
                    reverted_hash: None,
                }],
                operations: vec![SnapshotRevertOperation::Create {
                    path: escaped.clone(),
                }],
            },
        )
        .await
        .unwrap_err();
        assert_eq!(
            error.message,
            format!(
                "Path \"{}\" is outside the chat working directory. Use a path inside \"{}\".",
                escaped.display(),
                root.display()
            )
        );
        assert_eq!(error.details.unwrap()["kind"], "path_access");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_parent_swap_after_initial_containment_cannot_escape_the_snapshot_root() {
        let home = scratch_dir("snapshot-parent-swap");
        let root = home.join("root");
        let parent = root.join("inside");
        let outside = scratch_dir("snapshot-parent-swap-outside");
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(&parent).unwrap();
        let path = parent.join("file");
        std::fs::write(&path, b"after").unwrap();
        let service = Arc::new(Service {
            state: Arc::new(State::default()),
            consent: ConsentSource::new(RuntimeSlot::Host, home.to_path_buf()),
            move_io: Arc::new(NativeMoveIo),
            write_io: Arc::new(ParentSwappingWriteIo {
                parent,
                outside: outside.to_path_buf(),
                swapped: AtomicBool::new(false),
            }),
        });
        let error = revert(
            &service,
            SnapshotRevertParams {
                chat_id: "chat".to_owned(),
                containment_root: Some(root),
                expected: vec![expected(path.clone(), b"after", Some(b"before"))],
                operations: vec![restore(path, "YmVmb3Jl")],
            },
        )
        .await
        .unwrap_err();
        assert_eq!(error.details.unwrap()["kind"], "path_access");
        assert!(!outside.join("file").exists());
    }

    #[test]
    fn base64_restore_matches_nodes_permissive_utf16_buffer_decoding() {
        for (encoded, decoded) in [
            ("TQ", b"M".as_slice()),
            ("TWE===", b"Ma".as_slice()),
            ("T!W@E#", b"Ma".as_slice()),
            ("-_8", &[251, 255][..]),
            ("A===", b"".as_slice()),
            ("AA=A", &[0][..]),
            ("\u{0154}Q==", b"M".as_slice()),
            ("\u{ff34}Q==", &[225][..]),
            ("💖TQ==", b"".as_slice()),
            ("T\u{013d}Q==", b"".as_slice()),
        ] {
            assert_eq!(decode_node_base64(encoded), decoded, "{encoded}");
        }
    }
}
