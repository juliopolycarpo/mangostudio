//! One live binary-update session, from bounded receipt through slot activation.
//!
//! All methods here perform filesystem I/O and must run through the crate's
//! bounded blocking pool when reached from an async protocol handler.

use std::collections::HashMap;
use std::io;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, Weak};
use std::time::{Duration, Instant};

use base64::Engine as _;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use mango_protocol::error::{RemoteError, codes};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::runtime::Handle;
use tokio_util::sync::CancellationToken;

use crate::blocking::run_blocking;
use crate::ports::exclusivity::{
    CallExclusivity, EffectClaim, ProcessBlockingEffects, UpdateActivity, UpdateExclusivityTracker,
};
use crate::registry::Registry;
use crate::runtime_home::{
    RuntimeSlot, slot_dir, slot_version_binary_path, write_runtime_slot_config,
};
use crate::slot_publish::{
    activate_slot_current, prune_slot_versions, publish_slot_binary, restore_slot_current,
    sweep_abandoned_stages,
};
use crate::slot_update_lock::SlotUpdateLock;
use crate::update_transfer::{
    BeginParams, MAX_CHUNK_BYTES, StagedTransfer, TransferError, ValidatedBegin, refusal,
};

const SESSION_TIMEOUT: Duration = Duration::from_secs(120);
static NEXT_OWNER: AtomicU64 = AtomicU64::new(0);

/// The update state and owner token belonging to one protocol connection.
pub(crate) struct UpdateBinding {
    service: Arc<UpdateService>,
    owner: String,
    supervised: bool,
    restart: CancellationToken,
}

impl UpdateBinding {
    /// Enables a restart only for a stdio binary reached through `current`.
    pub fn new_with_restart(slot: RuntimeSlot, mango_home: PathBuf, supervised: bool) -> Self {
        Self {
            service: UpdateService::process(slot, mango_home),
            owner: format!(
                "{}-{}",
                std::process::id(),
                NEXT_OWNER.fetch_add(1, Ordering::Relaxed)
            ),
            supervised,
            restart: CancellationToken::new(),
        }
    }

    /// Fires after a committed supervised update has had time to send its response.
    pub fn restart_token(&self) -> CancellationToken {
        self.restart.clone()
    }

    pub async fn close(self) {
        run_blocking(move || self.service.close_owner(&self.owner)).await;
    }

    /// Returns the one slot gate through a connection-specific claim namespace.
    pub fn exclusivity(&self) -> Arc<dyn CallExclusivity> {
        let inner = self
            .service
            .exclusivity
            .get_or_init(|| {
                Arc::new(UpdateExclusivityTracker::with_effects(
                    Arc::new(WeakUpdateActivity(Arc::downgrade(&self.service))),
                    Arc::new(ProcessBlockingEffects),
                ))
            })
            .clone();
        Arc::new(NamespacedExclusivity {
            owner: self.owner.clone(),
            inner,
        })
    }
}

/// Registers the three catalog methods against the same service the
/// production exclusivity gate queries. The effect owns its claim while a
/// blocking write continues after a request future is abandoned.
pub(crate) fn register(
    registry: Registry,
    binding: &UpdateBinding,
    exclusivity: Arc<dyn CallExclusivity>,
) -> Registry {
    let service = Arc::clone(&binding.service);
    let owner = binding.owner.clone();
    let begin_exclusivity = Arc::clone(&exclusivity);
    let registry = registry.implement(
        "runtime.update.begin",
        move |params: BeginParams, context| {
            let service = Arc::clone(&service);
            let owner = owner.clone();
            let claim = EffectClaim::new(Arc::clone(&begin_exclusivity), context.id());
            let handle = Handle::current();
            async move {
                run_blocking(move || {
                    let _claim = claim;
                    let result = service.begin(&owner, params);
                    if let Ok(value) = &result
                        && let Some(id) = value["sessionId"].as_str()
                    {
                        schedule_expiration(&handle, &service, id.to_owned());
                    }
                    result
                })
                .await
            }
        },
    );
    let service = Arc::clone(&binding.service);
    let owner = binding.owner.clone();
    let chunk_exclusivity = Arc::clone(&exclusivity);
    let registry = registry.implement(
        "runtime.update.chunk",
        move |params: ChunkParams, context| {
            let service = Arc::clone(&service);
            let owner = owner.clone();
            let claim = EffectClaim::new(Arc::clone(&chunk_exclusivity), context.id());
            async move {
                run_blocking(move || {
                    let _claim = claim;
                    service.chunk(&owner, params)
                })
                .await
            }
        },
    );
    let service = Arc::clone(&binding.service);
    let owner = binding.owner.clone();
    let supervised = binding.supervised;
    let restart = binding.restart.clone();
    registry.implement(
        "runtime.update.commit",
        move |params: CommitParams, context| {
            let service = Arc::clone(&service);
            let owner = owner.clone();
            let claim = EffectClaim::new(Arc::clone(&exclusivity), context.id());
            let restart = restart.clone();
            let handle = Handle::current();
            async move {
                run_blocking(move || {
                    let _claim = claim;
                    let result = service.commit(&owner, params, supervised);
                    if result.is_ok() && supervised {
                        handle.spawn(async move {
                            tokio::time::sleep(Duration::from_millis(50)).await;
                            restart.cancel();
                        });
                    }
                    result
                })
                .await
            }
        },
    )
}

fn schedule_expiration(handle: &Handle, service: &Arc<UpdateService>, id: String) {
    let weak = Arc::downgrade(service);
    handle.spawn(async move {
        let mut delay = SESSION_TIMEOUT;
        loop {
            tokio::time::sleep(delay).await;
            let Some(service) = weak.upgrade() else {
                return;
            };
            let id_for_check = id.clone();
            match run_blocking(move || service.expire_session(&id_for_check)).await {
                Some(next) => delay = next,
                None => return,
            }
        }
    });
}

struct Session {
    id: String,
    owner: String,
    transfer: StagedTransfer,
    _lock: SlotUpdateLock,
    touched: Instant,
}

/// Filesystem-backed update state for one runtime slot. A session keeps the
/// cross-process slot claim until it commits, expires, or is closed.
pub(crate) struct UpdateService {
    slot: RuntimeSlot,
    mango_home: PathBuf,
    session: Mutex<Option<Session>>,
    exclusivity: OnceLock<Arc<dyn CallExclusivity>>,
    restart_pending: std::sync::atomic::AtomicBool,
}

/// Reads session activity without making the process gate keep its service alive.
struct WeakUpdateActivity(Weak<UpdateService>);

/// Request ids are unique within a session, while the slot gate covers all sessions.
struct NamespacedExclusivity {
    owner: String,
    inner: Arc<dyn CallExclusivity>,
}

impl NamespacedExclusivity {
    fn key(&self, call_id: &str) -> String {
        format!("{}:{call_id}", self.owner)
    }
}

impl CallExclusivity for NamespacedExclusivity {
    fn begin(&self, method: &str, call_id: &str) -> Result<(), RemoteError> {
        self.inner.begin(method, &self.key(call_id))
    }

    fn end(&self, call_id: &str) {
        self.inner.end(&self.key(call_id));
    }

    fn transfer_to_effect(&self, call_id: &str) {
        self.inner.transfer_to_effect(&self.key(call_id));
    }

    fn end_effect(&self, call_id: &str) {
        self.inner.end_effect(&self.key(call_id));
    }
}

impl UpdateActivity for WeakUpdateActivity {
    fn is_active(&self) -> bool {
        self.0.upgrade().is_some_and(|service| service.is_active())
    }
}

impl UpdateService {
    /// Builds an idle service for a slot under the same home that owns consent.
    pub fn new(slot: RuntimeSlot, mango_home: PathBuf) -> Self {
        Self {
            slot,
            mango_home,
            session: Mutex::new(None),
            exclusivity: OnceLock::new(),
            restart_pending: std::sync::atomic::AtomicBool::new(false),
        }
    }

    /// Shares update activity across reconnecting sessions for this process
    /// and slot. A weak entry does not keep an idle service alive forever.
    pub fn process(slot: RuntimeSlot, mango_home: PathBuf) -> Arc<Self> {
        static SERVICES: OnceLock<Mutex<HashMap<PathBuf, Weak<UpdateService>>>> = OnceLock::new();
        let services = SERVICES.get_or_init(|| Mutex::new(HashMap::new()));
        let key = slot_dir(slot, &mango_home);
        let mut services = services
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(existing) = services.get(&key).and_then(Weak::upgrade) {
            return existing;
        }
        let service = Arc::new(Self::new(slot, mango_home));
        services.insert(key, Arc::downgrade(&service));
        service
    }

    /// Opens one bounded transfer and returns its opaque session id.
    pub fn begin(&self, owner: &str, params: BeginParams) -> Result<Value, RemoteError> {
        if !cfg!(unix) {
            return Err(refusal(
                "unsupported_platform",
                "Runtime binary publication requires Unix symlinks on this platform.".into(),
            ));
        }
        let begin = ValidatedBegin::try_from(params)?;
        let mut session = self.lock();
        if let Some(active) = session.as_ref() {
            return Err(refusal(
                "session_active",
                format!(
                    "Another runtime update session {:?} is already active.",
                    active.id
                ),
            ));
        }
        let id = session_id().map_err(|error| io_error("create update session id", error))?;
        let slot_dir = slot_dir(self.slot, &self.mango_home);
        let claim =
            SlotUpdateLock::acquire(&slot_dir, id.clone(), SESSION_TIMEOUT).map_err(|error| {
                if error.kind() == io::ErrorKind::WouldBlock {
                    refusal(
                        "slot_update_active",
                        format!(
                            "Runtime update slot {} is busy: {error}",
                            slot_dir.display()
                        ),
                    )
                } else {
                    io_error("claim runtime update slot", error)
                }
            })?;
        sweep_abandoned_stages(&slot_dir)
            .map_err(|error| io_error("sweep abandoned update stages", error))?;
        let transfer = StagedTransfer::begin(&slot_dir, &id, begin)
            .map_err(|error| io_error("stage runtime update", error))?;
        *session = Some(Session {
            id: id.clone(),
            owner: owner.to_owned(),
            transfer,
            _lock: claim,
            touched: Instant::now(),
        });
        Ok(json!({ "sessionId": id, "maxChunkBytes": MAX_CHUNK_BYTES }))
    }

    /// Writes one strictly ordered, canonical-base64 chunk.
    pub fn chunk(&self, owner: &str, params: ChunkParams) -> Result<Value, RemoteError> {
        let bytes = decode_chunk(&params.bytes_base64)?;
        let mut session = self.lock();
        let active = require_session(&mut session, owner, &params.session_id)?;
        let seq = safe_seq(params.seq)?;
        let received = match active.transfer.chunk(seq, &bytes) {
            Ok(received) => received,
            Err(TransferError::Refused(error)) => return Err(error),
            Err(TransferError::Io(error)) => {
                *session = None;
                return Err(io_error("write runtime update chunk", error));
            }
        };
        active.touched = Instant::now();
        Ok(json!({ "acceptedBytes": bytes.len(), "receivedBytes": received }))
    }

    /// Verifies, publishes and activates a version. A failed config write
    /// restores the prior pointer while retaining both immutable versions.
    pub fn commit(
        &self,
        owner: &str,
        params: CommitParams,
        supervised: bool,
    ) -> Result<Value, RemoteError> {
        let mut session = self.lock();
        let active = require_session(&mut session, owner, &params.session_id)?;
        let id = active.id.clone();
        let active = session
            .take()
            .expect("require_session confirmed an active session");
        let verified = active.transfer.verify().map_err(transfer_error)?;
        let begin = verified.begin();
        let slot_dir = slot_dir(self.slot, &self.mango_home);
        publish_slot_binary(&slot_dir, &begin.version, verified.path())
            .map_err(|error| io_error("publish runtime update binary", error))?;
        let previous = activate_slot_current(&slot_dir, &begin.version)
            .map_err(|error| io_error("activate runtime update version", error))?;
        let binary = slot_version_binary_path(self.slot, &begin.version, &self.mango_home);
        let updates = [
            ("version", Some(Value::String(begin.version.clone()))),
            (
                "binaryPath",
                Some(Value::String(binary.to_string_lossy().into_owned())),
            ),
            ("digest", Some(Value::String(begin.digest.clone()))),
            ("sourceSha", begin.source_sha.clone().map(Value::String)),
        ];
        if let Err(error) = write_runtime_slot_config(self.slot, &self.mango_home, &updates) {
            if let Err(restore_error) = restore_slot_current(&slot_dir, previous.as_deref()) {
                return Err(RemoteError::new(
                    codes::INTERNAL,
                    format!(
                        "Runtime update {id} could not write runtime.json ({error}) and could not restore current ({restore_error}); inspect {} before retrying.",
                        slot_dir.display()
                    ),
                ));
            }
            return Err(RemoteError::new(
                codes::INTERNAL,
                format!(
                    "Runtime update {id} could not write runtime.json ({error}); restored the previous current pointer."
                ),
            ));
        }
        let _ = prune_slot_versions(&slot_dir, &begin.version, previous.as_deref());
        if supervised {
            self.restart_pending.store(true, Ordering::SeqCst);
        }
        Ok(json!({
            "version": begin.version,
            "digest": begin.digest,
            "restart": if supervised { "scheduled" } else { "manual" },
        }))
    }

    /// Discards a stage only when the closed connection still owns it.
    pub fn close_owner(&self, owner: &str) {
        let mut session = self.lock();
        if session.as_ref().is_some_and(|active| active.owner == owner) {
            *session = None;
        }
    }

    /// Discards an expired stage, or returns the remaining wait for its next
    /// inactivity deadline. `None` also means a newer session replaced it.
    pub fn expire_session(&self, id: &str) -> Option<Duration> {
        let mut session = self.lock();
        let active = session.as_ref().filter(|active| active.id == id)?;
        let elapsed = active.touched.elapsed();
        if elapsed >= SESSION_TIMEOUT {
            session.take();
            None
        } else {
            Some(SESSION_TIMEOUT - elapsed)
        }
    }

    fn lock(&self) -> MutexGuard<'_, Option<Session>> {
        self.session
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

impl UpdateActivity for UpdateService {
    fn is_active(&self) -> bool {
        if self.restart_pending.load(Ordering::SeqCst) {
            return true;
        }
        match self.session.try_lock() {
            Ok(session) => session.is_some(),
            Err(std::sync::TryLockError::Poisoned(poison)) => poison.into_inner().is_some(),
            Err(std::sync::TryLockError::WouldBlock) => true,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChunkParams {
    pub session_id: String,
    pub seq: f64,
    pub bytes_base64: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CommitParams {
    pub session_id: String,
}

fn require_session<'a>(
    session: &'a mut Option<Session>,
    owner: &str,
    id: &str,
) -> Result<&'a mut Session, RemoteError> {
    session
        .as_mut()
        .filter(|active| active.id == id && active.owner == owner)
        .ok_or_else(|| {
            refusal(
                "session_missing",
                format!("Runtime update session {id:?} is absent or no longer active."),
            )
        })
}

fn safe_seq(seq: f64) -> Result<u64, RemoteError> {
    if !seq.is_finite() || seq.fract() != 0.0 || !(0.0..=9_007_199_254_740_991.0).contains(&seq) {
        return Err(refusal(
            "sequence_mismatch",
            format!("Runtime update chunk sequence {seq} must be a nonnegative safe integer."),
        ));
    }
    Ok(seq as u64)
}

fn decode_chunk(encoded: &str) -> Result<Vec<u8>, RemoteError> {
    if encoded.is_empty() || encoded.len() > MAX_CHUNK_BYTES.div_ceil(3) * 4 {
        return Err(refusal(
            "invalid_base64",
            format!(
                "Runtime update chunk has {} encoded bytes; expected bounded canonical base64.",
                encoded.len()
            ),
        ));
    }
    let bytes = STANDARD.decode(encoded).map_err(|_| {
        refusal(
            "invalid_base64",
            format!(
                "Runtime update chunk of {} encoded bytes is not canonical base64.",
                encoded.len()
            ),
        )
    })?;
    if STANDARD.encode(&bytes) != encoded {
        return Err(refusal(
            "invalid_base64",
            format!(
                "Runtime update chunk of {} encoded bytes is not canonical base64.",
                encoded.len()
            ),
        ));
    }
    Ok(bytes)
}

fn session_id() -> io::Result<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|error| io::Error::other(error.to_string()))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn io_error(action: &str, error: io::Error) -> RemoteError {
    RemoteError::new(codes::INTERNAL, format!("Could not {action}: {error}"))
}

fn transfer_error(error: TransferError) -> RemoteError {
    match error {
        TransferError::Refused(error) => error,
        TransferError::Io(error) => io_error("verify runtime update", error),
    }
}

#[cfg(test)]
mod tests {
    use std::future::Future;
    use std::pin::Pin;

    #[cfg(unix)]
    use mango_protocol::contract::Contract;
    use mango_protocol::frame::PeerInfo;
    #[cfg(unix)]
    use mango_protocol::port::port_pair;
    #[cfg(unix)]
    use mango_protocol::session::{Session as ProtocolSession, SessionOptions};
    use sha2::{Digest, Sha256};

    use super::*;
    #[cfg(unix)]
    use crate::ports::audit::NoopAudit;
    use crate::ports::authorization::Authorization;
    #[cfg(unix)]
    use crate::ports::clock::SystemClock;
    #[cfg(unix)]
    use crate::slot_publish::read_slot_current;

    struct GrantsUpdate;

    impl Authorization for GrantsUpdate {
        fn missing_capabilities<'a>(
            &'a self,
            _method: &'a str,
            _capabilities: &'a [String],
        ) -> Pin<Box<dyn Future<Output = Vec<String>> + Send + 'a>> {
            Box::pin(async { Vec::new() })
        }
    }

    fn peer(role: &str) -> PeerInfo {
        PeerInfo {
            name: format!("update-test-{role}"),
            version: "0.0.0".into(),
            role: role.into(),
        }
    }

    fn scratch(name: &str) -> PathBuf {
        let home = std::env::temp_dir().join(format!(
            "mango-update-service-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        home
    }

    fn begin_params(bytes: &[u8]) -> BeginParams {
        let digest: String = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        BeginParams {
            version: "1.2.3".into(),
            digest: format!("sha256:{digest}"),
            total_bytes: bytes.len() as f64,
            source_sha: Some("abcdef0".into()),
        }
    }

    #[test]
    fn connections_share_slot_exclusivity_without_colliding_request_ids() {
        let home = scratch("shared-gate");
        let first = UpdateBinding::new_with_restart(RuntimeSlot::Remote, home.clone(), false);
        let second = UpdateBinding::new_with_restart(RuntimeSlot::Remote, home.clone(), false);
        first.exclusivity();
        second.exclusivity();
        assert!(Arc::ptr_eq(&first.service, &second.service));

        // Isolate this gate from other tests' process-wide blocking effects.
        let shared: Arc<dyn CallExclusivity> =
            Arc::new(UpdateExclusivityTracker::new(first.service.clone()));
        let first_gate = NamespacedExclusivity {
            owner: first.owner.clone(),
            inner: shared.clone(),
        };
        let second_gate = NamespacedExclusivity {
            owner: second.owner.clone(),
            inner: shared,
        };

        first_gate.begin("shell.run", "1").unwrap();
        assert!(second_gate.begin("runtime.update.begin", "1").is_err());
        second_gate.end("1");
        assert!(second_gate.begin("runtime.update.begin", "1").is_err());
        first_gate.end("1");

        second_gate.begin("runtime.update.begin", "1").unwrap();
        assert!(first_gate.begin("shell.run", "1").is_err());
        second_gate.end("1");

        let begun = second
            .service
            .begin(&second.owner, begin_params(b"binary"))
            .unwrap();
        let id = begun["sessionId"].as_str().unwrap();
        assert!(first_gate.begin("shell.run", "1").is_err());
        let wrong_owner = first
            .service
            .chunk(
                &first.owner,
                ChunkParams {
                    session_id: id.into(),
                    seq: 0.0,
                    bytes_base64: STANDARD.encode(b"binary"),
                },
            )
            .unwrap_err();
        assert_eq!(wrong_owner.details.unwrap()["reason"], "session_missing");
        let wrong_owner = first
            .service
            .commit(
                &first.owner,
                CommitParams {
                    session_id: id.into(),
                },
                false,
            )
            .unwrap_err();
        assert_eq!(wrong_owner.details.unwrap()["reason"], "session_missing");
        assert!(second.service.is_active());
        second.service.close_owner(&second.owner);
        assert!(!second.service.is_active());
        assert!(begun["sessionId"].is_string());
        first_gate.begin("shell.run", "1").unwrap();
        first_gate.end("1");
        std::fs::remove_dir_all(home).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn registered_update_round_trips_over_the_runtime_contract() {
        let home = scratch("wire");
        let binding = UpdateBinding::new_with_restart(RuntimeSlot::Remote, home.clone(), false);
        let exclusivity: Arc<dyn CallExclusivity> =
            Arc::new(UpdateExclusivityTracker::new(binding.service.clone()));
        let registry = register(
            Registry::with_ports_and_exclusivity(
                Arc::new(NoopAudit),
                Arc::new(SystemClock),
                exclusivity.clone(),
            ),
            &binding,
            exclusivity,
        );
        let (hub_port, runtime_port) = port_pair();
        let (hub, _hub_driver) = ProtocolSession::spawn(hub_port, SessionOptions::new(peer("hub")));
        let (runtime, _runtime_driver) =
            ProtocolSession::spawn(runtime_port, SessionOptions::new(peer("runtime")));
        hub.ready().await.unwrap();
        runtime.ready().await.unwrap();
        let contract =
            Contract::from_catalog(mangostudio_runtime_contract::catalog::catalog().clone())
                .unwrap();
        crate::serve::serve(
            &contract,
            &runtime,
            registry,
            Arc::new(GrantsUpdate),
            "remote",
        )
        .unwrap()
        .persist();

        let bytes = b"binary";
        let params = begin_params(bytes);
        let begun = hub
            .request(
                "runtime.update.begin",
                json!({
                    "version": params.version,
                    "digest": params.digest,
                    "totalBytes": params.total_bytes,
                    "sourceSha": params.source_sha,
                }),
            )
            .await
            .unwrap();
        let id = begun["sessionId"].as_str().unwrap();
        assert_eq!(begun["maxChunkBytes"], MAX_CHUNK_BYTES);
        let chunked = hub
            .request(
                "runtime.update.chunk",
                json!({ "sessionId": id, "seq": 0, "bytesBase64": STANDARD.encode(bytes) }),
            )
            .await
            .unwrap();
        assert_eq!(chunked["receivedBytes"], bytes.len());
        let committed = hub
            .request("runtime.update.commit", json!({ "sessionId": id }))
            .await
            .unwrap();
        assert_eq!(committed["restart"], "manual");
        assert_eq!(
            std::fs::read(
                slot_dir(RuntimeSlot::Remote, &home)
                    .join("current")
                    .join("mangostudio-runtime")
            )
            .unwrap(),
            bytes
        );
        runtime.close_now(4000, None);
        std::fs::remove_dir_all(home).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn commits_verified_bytes_without_touching_pairing() {
        let home = scratch("commit");
        let service = UpdateService::new(RuntimeSlot::Remote, home.clone());
        let slot = slot_dir(RuntimeSlot::Remote, &home);
        std::fs::create_dir_all(&slot).unwrap();
        std::fs::write(slot.join("credentials.json"), b"pairing bytes").unwrap();
        let begun = service.begin("owner", begin_params(b"binary")).unwrap();
        let id = begun["sessionId"].as_str().unwrap();
        assert!(service.is_active());
        service
            .chunk(
                "owner",
                ChunkParams {
                    session_id: id.into(),
                    seq: 0.0,
                    bytes_base64: STANDARD.encode(b"binary"),
                },
            )
            .unwrap();
        let committed = service
            .commit(
                "owner",
                CommitParams {
                    session_id: id.into(),
                },
                false,
            )
            .unwrap();
        assert_eq!(committed["restart"], "manual");
        assert_eq!(
            std::fs::read(slot.join("current").join("mangostudio-runtime")).unwrap(),
            b"binary"
        );
        assert_eq!(
            std::fs::read(slot.join("credentials.json")).unwrap(),
            b"pairing bytes"
        );
        assert!(!service.is_active());
        std::fs::remove_dir_all(home).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn wrong_digest_and_reordered_chunk_preserve_current_and_release_lock() {
        let home = scratch("bad");
        let service = UpdateService::new(RuntimeSlot::Remote, home.clone());
        let slot = slot_dir(RuntimeSlot::Remote, &home);
        std::fs::create_dir_all(&slot).unwrap();
        let mut params = begin_params(b"binary");
        params.digest = format!("sha256:{}", "0".repeat(64));
        let begun = service.begin("owner", params).unwrap();
        let id = begun["sessionId"].as_str().unwrap();
        let error = service
            .chunk(
                "owner",
                ChunkParams {
                    session_id: id.into(),
                    seq: 1.0,
                    bytes_base64: STANDARD.encode(b"binary"),
                },
            )
            .unwrap_err();
        assert_eq!(error.details.unwrap()["reason"], "sequence_mismatch");
        service
            .chunk(
                "owner",
                ChunkParams {
                    session_id: id.into(),
                    seq: 0.0,
                    bytes_base64: STANDARD.encode(b"binary"),
                },
            )
            .unwrap();
        let error = service
            .commit(
                "owner",
                CommitParams {
                    session_id: id.into(),
                },
                false,
            )
            .unwrap_err();
        assert_eq!(error.details.unwrap()["reason"], "digest_mismatch");
        assert!(!slot.join("current").exists());
        assert!(!slot.join("runtime-update.lock").exists());
        std::fs::remove_dir_all(home).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn config_publication_failure_restores_the_previous_current_pointer() {
        let home = scratch("config-rollback");
        let service = UpdateService::new(RuntimeSlot::Remote, home.clone());
        let slot = slot_dir(RuntimeSlot::Remote, &home);
        std::fs::create_dir_all(&slot).unwrap();
        let old_source = slot.join("old-source");
        std::fs::write(&old_source, b"old binary").unwrap();
        publish_slot_binary(&slot, "1.0.0", &old_source).unwrap();
        activate_slot_current(&slot, "1.0.0").unwrap();

        // A directory at the config path makes the post-activation atomic
        // replacement fail, after the new immutable binary was published.
        std::fs::create_dir(slot.join("runtime.json")).unwrap();
        let begun = service.begin("owner", begin_params(b"new binary")).unwrap();
        let id = begun["sessionId"].as_str().unwrap();
        service
            .chunk(
                "owner",
                ChunkParams {
                    session_id: id.into(),
                    seq: 0.0,
                    bytes_base64: STANDARD.encode(b"new binary"),
                },
            )
            .unwrap();
        let error = service
            .commit(
                "owner",
                CommitParams {
                    session_id: id.into(),
                },
                false,
            )
            .unwrap_err();
        assert_eq!(error.code, codes::INTERNAL);
        assert!(
            error
                .message
                .contains("restored the previous current pointer")
        );
        assert_eq!(read_slot_current(&slot).unwrap().as_deref(), Some("1.0.0"));
        assert_eq!(
            std::fs::read(slot.join("current").join("mangostudio-runtime")).unwrap(),
            b"old binary"
        );
        assert!(!slot.join("runtime-update.lock").exists());
        std::fs::remove_dir_all(home).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn beginning_a_new_transfer_sweeps_abandoned_stages() {
        let home = scratch("sweep-stages");
        let service = UpdateService::new(RuntimeSlot::Remote, home.clone());
        let slot = slot_dir(RuntimeSlot::Remote, &home);
        std::fs::create_dir_all(&slot).unwrap();
        let abandoned = slot.join(".mangostudio-runtime.incoming-abandoned");
        std::fs::write(&abandoned, b"orphaned bytes").unwrap();
        let pointer = slot.join(".current.abandoned");
        std::os::unix::fs::symlink("1.0.0", &pointer).unwrap();
        let version = slot.join("1.0.0");
        std::fs::create_dir(&version).unwrap();
        let binary_stage = version.join(".mangostudio-runtime.42.7");
        std::fs::write(&binary_stage, b"orphaned copy").unwrap();

        service.begin("owner", begin_params(b"new binary")).unwrap();

        assert!(!abandoned.exists());
        assert!(!pointer.exists());
        assert!(!binary_stage.exists());
        service.close_owner("owner");
        std::fs::remove_dir_all(home).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn supervised_commit_schedules_restart_and_keeps_other_calls_closed() {
        let home = scratch("supervised");
        let binding = UpdateBinding::new_with_restart(RuntimeSlot::Remote, home.clone(), true);
        let begun = binding
            .service
            .begin(&binding.owner, begin_params(b"binary"))
            .unwrap();
        let id = begun["sessionId"].as_str().unwrap();
        binding
            .service
            .chunk(
                &binding.owner,
                ChunkParams {
                    session_id: id.into(),
                    seq: 0.0,
                    bytes_base64: STANDARD.encode(b"binary"),
                },
            )
            .unwrap();
        let committed = binding
            .service
            .commit(
                &binding.owner,
                CommitParams {
                    session_id: id.into(),
                },
                true,
            )
            .unwrap();
        assert_eq!(committed["restart"], "scheduled");
        assert!(binding.service.is_active());
        assert!(binding.exclusivity().begin("shell.run", "1").is_err());
        std::fs::remove_dir_all(home).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn update_begin_refuses_before_staging_on_windows() {
        let home = scratch("windows-unsupported");
        let service = UpdateService::new(RuntimeSlot::Remote, home.clone());
        let error = service.begin("owner", begin_params(b"binary")).unwrap_err();
        assert_eq!(error.details.unwrap()["reason"], "unsupported_platform");
        assert!(!slot_dir(RuntimeSlot::Remote, &home).exists());
        std::fs::remove_dir_all(home).unwrap();
    }
}
