//! MangoStudio's consumed agent operations. SDK objects never cross these ports.
//!
//! The supervisor owns authorization, scratch and session admission. A backend owns vendor
//! handles and their cleanup. Streams pull directly from the backend without a second queue.
use std::collections::BTreeMap;
use std::path::PathBuf;

use mango_protocol::error::RemoteError;
use tokio_util::sync::CancellationToken;

use super::failure::AgentFailure;
use super::interactions::{Answer, MappedEvent};
use super::wire;

pub(crate) type AgentResult<T> = Result<T, AgentFailure>;

/// A host-keyed account digest input. Its debug output never includes key material.
#[derive(Clone)]
pub(crate) struct AccountKey(Vec<u8>);
impl AccountKey {
    /// Takes a nonempty host key, retaining an owned buffer without another copy.
    ///
    /// ```ignore
    /// let key = AccountKey::new(b"host-local-key").expect("a host key");
    /// ```
    pub(crate) fn new(bytes: impl Into<Vec<u8>>) -> Option<Self> {
        let bytes = bytes.into();
        (!bytes.is_empty()).then_some(Self(bytes))
    }
    /// Supplies private key bytes only to the account adapter.
    ///
    /// ```ignore
    /// assert!(!key.bytes().is_empty());
    /// ```
    pub(crate) fn bytes(&self) -> &[u8] {
        &self.0
    }
}

/// Product-authorized launch facts, moved into a backend once per operation.
pub(crate) struct Host {
    pub cwd: PathBuf,
    pub scratch: Option<PathBuf>,
    pub environment: BTreeMap<String, String>,
    pub runtime_version: String,
    pub cancel: CancellationToken,
}

/// Only the history axes consumed by the product.
pub(crate) struct SessionQuery {
    pub cursor: Option<String>,
    pub limit: Option<usize>,
    pub workspace_path: Option<PathBuf>,
}

/// Builds sessions and probes without exposing harness or process-control objects.
///
/// ```ignore
/// let descriptor = backend.discover(target, executable, host, key.as_ref()).await?;
/// ```
#[async_trait::async_trait]
pub(crate) trait AgentBackend: Send + Sync {
    /// Native close budget, to which the supervisor adds its own cleanup grace.
    fn close_budget(&self) -> std::time::Duration;
    /// Discovers product-facing target and account facts under the supplied host key.
    async fn discover(
        &self,
        target: wire::TargetId,
        executable: Option<PathBuf>,
        host: Host,
        key: Option<&AccountKey>,
    ) -> AgentResult<wire::Descriptor>;
    /// Opens a session only after the supervisor has authorized its host and request.
    async fn open(
        &self,
        target: wire::TargetId,
        executable: PathBuf,
        host: Host,
        request: &wire::OpenParams,
    ) -> AgentResult<Box<dyn AgentSession>>;
    /// Lists vendor history within the authorized host and query.
    async fn list_sessions(
        &self,
        target: wire::TargetId,
        executable: Option<PathBuf>,
        host: Host,
        query: SessionQuery,
    ) -> AgentResult<wire::ListSessionsResult>;
}

/// Why product lifecycle policy asks a session to close.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CloseCause {
    Requested,
    ConsentRevoked,
    Shutdown,
}
/// Why product turn policy asks native work to stop.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CancelReason {
    Requested,
    Timeout,
}

/// Decoded attachment bytes, moved into the adapter without another encoding pass.
pub(crate) struct Attachment {
    pub id: String,
    pub name: String,
    pub mime_type: String,
    pub kind: wire::AttachmentKind,
    pub bytes: Vec<u8>,
}
/// The turn axes actually submitted by MangoStudio.
pub(crate) struct TurnRequest<'a> {
    pub turn_id: String,
    pub input: String,
    pub attachments: Vec<Attachment>,
    pub configuration: &'a wire::Configuration,
}
/// Additional text for the product's current native turn.
pub(crate) struct Steer {
    pub turn_id: String,
    pub native_turn_id: String,
    pub input: String,
}

/// One session with vendor handles retained solely by its implementation.
///
/// ```ignore
/// let stream = session.start_turn(request).await?;
/// session.cancel(CancelReason::Requested).await?;
/// session.close(CloseCause::Requested).await?;
/// ```
#[async_trait::async_trait]
pub(crate) trait AgentSession: Send + Sync {
    /// Maps accepted facts against the request's product defaults.
    fn open_result(&self, requested: &wire::Configuration) -> wire::OpenResult;
    /// The vendor thread the product must keep reviews on.
    fn native_session_id(&self) -> String;
    /// Product capabilities accepted by this session.
    fn capabilities(&self) -> wire::Capabilities;
    /// Watches commands on the existing vendor subscription, without a relay queue.
    fn subscribe(&self) -> Box<dyn SessionSubscription>;
    /// Starts native work and returns its owned observation stream.
    async fn start_turn(&self, request: TurnRequest<'_>) -> AgentResult<TurnStream>;
    /// Starts the product's uncommitted-changes review.
    async fn start_review(&self, turn_id: String) -> AgentResult<ReviewStream>;
    /// Answers an approval or a question through its distinct vendor operation.
    async fn respond(&self, answer: Answer) -> AgentResult<()>;
    /// Adds input to native work, preserving typed product refusal reasons.
    async fn steer(&self, steer: Steer) -> AgentResult<wire::SteerResult>;
    /// Requests cancellation; the supervisor drains the stream until it settles.
    async fn cancel(&self, reason: CancelReason) -> AgentResult<()>;
    /// Awaits vendor close and adapter-owned cleanup.
    async fn close(&self, reason: CloseCause) -> AgentResult<()>;
    /// Reads account limits over this session's connection.
    async fn refresh_account_usage(&self) -> AgentResult<wire::RefreshAccountUsageResult>;
}

/// Only command facts consumed during a product turn.
#[async_trait::async_trait]
pub(crate) trait SessionSubscription: Send {
    /// The catalog at the last subscription revision.
    fn current(&self) -> Vec<wire::Command>;
    /// The next coalesced catalog, or no further facts once its owner is gone.
    async fn changed(&mut self) -> Option<Vec<wire::Command>>;
}

/// Arrival certainty, independent of failure cause and retry advice.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Dispatch {
    NotSubmitted,
    Accepted,
    AcceptanceUnknown,
}
impl Dispatch {
    /// Only a proven absence of submission permits the product to replay.
    ///
    /// ```ignore
    /// assert!(Dispatch::NotSubmitted.is_safe_to_replay());
    /// ```
    pub(crate) fn is_safe_to_replay(self) -> bool {
        self == Self::NotSubmitted
    }
    /// The established product error-detail spelling.
    ///
    /// ```ignore
    /// assert_eq!(Dispatch::Accepted.name(), "accepted");
    /// ```
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::NotSubmitted => "not-submitted",
            Self::Accepted => "accepted",
            Self::AcceptanceUnknown => "acceptance-unknown",
        }
    }
}

/// One mapped event and the separate timeout fact product policy consumes.
pub(crate) struct TurnEvent {
    pub at_ms: Option<u64>,
    pub idle_timeout: bool,
    pub mapped: MappedEvent,
}
/// Pulls mapped events directly from native observation, preserving order and backpressure.
#[async_trait::async_trait]
pub(crate) trait EventStream: Send {
    /// Borrows the vendor handle from its native stream owner.
    fn native_turn_id(&self) -> &str;
    /// The next event, or completion once all native events are drained.
    async fn recv(&mut self) -> Option<TurnEvent>;
}
/// A native observation owner; dropping it abandons work through the adapter's stream owner.
pub(crate) struct TurnStream {
    pub dispatch: Dispatch,
    pub native_id: Result<String, RemoteError>,
    pub events: Box<dyn EventStream>,
}
impl TurnStream {
    /// Reads the exact vendor handle; product admission checks its bounded form separately.
    ///
    /// ```ignore
    /// let native = stream.native_turn_id();
    /// ```
    pub(crate) fn native_turn_id(&self) -> &str {
        self.events.native_turn_id()
    }
    /// Pulls one event without introducing a product queue.
    ///
    /// ```ignore
    /// while let Some(event) = stream.recv().await { relay.event(event).await; }
    /// ```
    pub(crate) async fn recv(&mut self) -> Option<TurnEvent> {
        self.events.recv().await
    }
}
/// A native review plus the thread required for the product's admission check.
pub(crate) struct ReviewStream {
    pub turn: TurnStream,
    pub review_thread_id: String,
}
