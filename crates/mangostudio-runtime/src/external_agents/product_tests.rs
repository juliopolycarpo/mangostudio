//! Product tests use owned ports and wire contracts only.
use super::{Ports, Supervisor};
use crate::external_agents::failure::{
    AgentFailure, CleanupOutcome, FailureCause, FailureContext, RetryAdvice, SessionUsability,
};
use crate::external_agents::interactions::{self, Answer, PendingInteraction};
use crate::external_agents::port::*;
use crate::external_agents::wire;
use std::sync::{Arc, Mutex};

#[test]
fn product_answers_keep_questions_separate_from_authority() {
    let permission = PendingInteraction::Approval {
        request_id: "approval".into(),
        option_ids: vec!["allow".into()],
        expires_at_ms: 0,
    };
    assert_eq!(
        interactions::answer(&permission, "allow").unwrap(),
        Answer::Permission {
            request_id: "approval".into(),
            option_id: "allow".into()
        }
    );
    let question = PendingInteraction::Question {
        request_id: "question".into(),
        question_id: "branch".into(),
        choices: vec![("develop".into(), "choice-develop".into())],
        expires_at_ms: 0,
    };
    assert_eq!(
        interactions::answer(&question, "develop").unwrap(),
        Answer::Question {
            request_id: "question".into(),
            question_id: "branch".into(),
            choice_id: "choice-develop".into()
        }
    );
    let refused = interactions::answer(&question, "unknown").unwrap_err();
    assert!(refused.message.contains("unknown") && refused.message.contains("develop"));
}

#[derive(Default)]
struct OwnedBackend {
    hosts: Mutex<Vec<Host>>,
    discovery_state: Option<wire::DiscoveryState>,
}
#[async_trait::async_trait]
impl AgentBackend for OwnedBackend {
    fn close_budget(&self) -> std::time::Duration {
        std::time::Duration::ZERO
    }
    async fn discover(
        &self,
        target: wire::TargetId,
        _executable: Option<std::path::PathBuf>,
        host: Host,
        _key: Option<&AccountKey>,
    ) -> AgentResult<wire::Descriptor> {
        self.hosts.lock().unwrap().push(host);
        // The fake can return owned product facts without an SDK discovery, harness or launcher.
        Ok(wire::Descriptor {
            target_id: target,
            installed: self.discovery_state.is_some(),
            discovery_state: self
                .discovery_state
                .unwrap_or(wire::DiscoveryState::Determined),
            version: self
                .discovery_state
                .filter(|state| *state == wire::DiscoveryState::Determined)
                .map(|_| "fixture-build-1".into()),
            required_version: None,
            auth_state: wire::AuthState::Unknown,
            login_command: None,
            capabilities: wire::Capabilities {
                structured_streaming: false,
                reasoning_stream: false,
                interactive_approvals: false,
                resume: false,
                model_catalog: false,
                images: false,
                usage_reporting: false,
                cancellation: false,
                steering: false,
                session_listing: false,
                native_review: false,
                account_usage: false,
            },
            supported_configurations: Vec::new(),
            models: None,
            account: None,
            unavailable_reason: None,
            remedy: None,
            discovery: None,
        })
    }
    async fn open(
        &self,
        _target: wire::TargetId,
        _executable: std::path::PathBuf,
        _host: Host,
        _request: &wire::OpenParams,
    ) -> AgentResult<Box<dyn AgentSession>> {
        unreachable!("discovery never opens a session")
    }
    async fn list_sessions(
        &self,
        _target: wire::TargetId,
        _executable: Option<std::path::PathBuf>,
        _host: Host,
        _query: SessionQuery,
    ) -> AgentResult<wire::ListSessionsResult> {
        unreachable!("discovery never lists sessions")
    }
}
struct MissingExecutable;
impl super::ExecutableResolver for MissingExecutable {
    fn resolve<'a>(
        &'a self,
        _target: wire::TargetId,
        _cancel: &'a tokio_util::sync::CancellationToken,
    ) -> super::PortFuture<'a, Option<std::path::PathBuf>> {
        Box::pin(async { None })
    }
}

#[tokio::test]
async fn product_discovery_needs_only_an_owned_backend() {
    let backend = Arc::new(OwnedBackend::default());
    let scratch = crate::test_support::ScratchDir::created("owned-agent-discovery");
    let supervisor = Supervisor::new(Ports {
        harnesses: Arc::clone(&backend) as Arc<dyn AgentBackend>,
        workspaces: Arc::new(super::DenyEveryWorkspace),
        executables: Arc::new(MissingExecutable),
        environment: Arc::new(crate::probing::detection::path_env::PathEnv::default),
        consent: Arc::new(|| true),
        private_root: scratch.path().to_path_buf(),
        runtime_version: "owned-test".into(),
        account_key: Arc::new(|| None),
        session_cap: 1,
        consent_poll: super::CONSENT_POLL,
        consent_read_timeout: std::time::Duration::from_secs(1),
        cleanup_timeout: super::CLEANUP_TIMEOUT,
        hard_turn_timeout: super::HARD_TURN_TIMEOUT,
    });
    let result = supervisor
        .discover(
            wire::DiscoverParams {
                target_ids: vec![wire::TargetId::Claude],
                timeout_ms: 5_000,
            },
            &tokio_util::sync::CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(result.descriptors.len(), 1);
    assert_eq!(result.descriptors[0].target_id, wire::TargetId::Claude);
    assert_eq!(
        backend.hosts.lock().unwrap()[0].runtime_version,
        "owned-test"
    );
}

/// Grants only the discovery capability needed by the registered-method compatibility tests.
struct DiscoveryAuthorization;
impl crate::ports::authorization::Authorization for DiscoveryAuthorization {
    fn missing_capabilities<'a>(
        &'a self,
        method: &'a str,
        capabilities: &'a [String],
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Vec<String>> + Send + 'a>> {
        assert_eq!(method, "external-agent.discover");
        assert_eq!(capabilities, ["externalAgents"]);
        Box::pin(async { Vec::new() })
    }
}

/// Calls the actual service handler over a handshaken session with a named owned backend.
async fn discovery_from_calling_hub(state: wire::DiscoveryState) -> serde_json::Value {
    use mango_protocol::contract::Contract;
    use mango_protocol::frame::PeerInfo;
    use mango_protocol::session::{Session, SessionOptions};
    let peer = |role: &str| PeerInfo {
        name: "discovery-compatibility".into(),
        version: "0.0.0".into(),
        role: role.into(),
    };
    let capabilities = serde_json::Map::new();
    let (hub_port, runtime_port) = mango_protocol::port::port_pair();
    let (hub, _) = Session::spawn(
        hub_port,
        SessionOptions::new(peer("hub")).with_capabilities(capabilities),
    );
    let (runtime, _) = Session::spawn(runtime_port, SessionOptions::new(peer("runtime")));
    let (hub_ready, runtime_ready) = tokio::join!(hub.ready(), runtime.ready());
    hub_ready.unwrap();
    runtime_ready.unwrap();
    let scratch = crate::test_support::ScratchDir::created("discovery-compatibility");
    let supervisor = Supervisor::new(Ports {
        harnesses: Arc::new(OwnedBackend {
            discovery_state: Some(state),
            ..OwnedBackend::default()
        }),
        workspaces: Arc::new(super::DenyEveryWorkspace),
        executables: Arc::new(MissingExecutable),
        environment: Arc::new(crate::probing::detection::path_env::PathEnv::default),
        consent: Arc::new(|| true),
        private_root: scratch.path().to_path_buf(),
        runtime_version: "owned-test".into(),
        account_key: Arc::new(|| None),
        session_cap: 1,
        consent_poll: super::CONSENT_POLL,
        consent_read_timeout: std::time::Duration::from_secs(1),
        cleanup_timeout: super::CLEANUP_TIMEOUT,
        hard_turn_timeout: super::HARD_TURN_TIMEOUT,
    });
    let registry =
        crate::external_agents::service::register(crate::registry::Registry::new(), supervisor);
    let contract =
        Contract::from_catalog(mangostudio_runtime_contract::catalog::catalog().clone()).unwrap();
    let _served = crate::serve::serve(
        &contract,
        &runtime,
        registry,
        Arc::new(DiscoveryAuthorization),
        "host",
    )
    .unwrap();
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        hub.request(
            "external-agent.discover",
            serde_json::json!({"targetIds":["claude"],"timeoutMs":1000}),
        ),
    )
    .await
    .unwrap()
    .unwrap();
    let _ = tokio::join!(
        hub.close(1000, Some("test finished")),
        runtime.close(1000, Some("test finished"))
    );
    result
}

/// The actual pre-feature catalog accepts descriptor additions through its open runtime projection.
#[tokio::test]
async fn a_new_runtime_answers_the_released_hubs_discovery_contract() {
    let schema: serde_json::Value = serde_json::from_str(include_str!(
        "../../tests/fixtures/external-agents/discover-result-before-state.json"
    ))
    .unwrap();
    let validator = jsonschema::validator_for(&schema).unwrap();
    for state in [
        wire::DiscoveryState::Determined,
        wire::DiscoveryState::Undetermined,
    ] {
        let result = discovery_from_calling_hub(state).await;
        let errors: Vec<_> = validator
            .iter_errors(&result)
            .map(|error| error.to_string())
            .collect();
        assert!(
            errors.is_empty(),
            "expected the older result schema to accept the actual method reply; received {errors:?}"
        );
        assert!(result["descriptors"][0].get("discoveryState").is_some());
    }
}

/// The registered service forwards both new facts through the current result contract.
#[tokio::test]
async fn a_new_runtime_emits_both_states_through_the_current_contract() {
    for (state, expected) in [
        (wire::DiscoveryState::Determined, "determined"),
        (wire::DiscoveryState::Undetermined, "undetermined"),
    ] {
        let result = discovery_from_calling_hub(state).await;
        assert_eq!(result["descriptors"][0]["discoveryState"], expected);
    }
}

#[derive(Default)]
struct OwnedSessionLog {
    inputs: Mutex<Vec<(String, Vec<u8>)>>,
    reviews: Mutex<Vec<String>>,
    start_failure: Mutex<Option<AgentFailure>>,
    native_review: bool,
    closes: Mutex<Vec<CloseCause>>,
}
struct OwnedSession(Arc<OwnedSessionLog>);
struct FinishedEvents {
    native: String,
    sent: bool,
}
#[async_trait::async_trait]
impl EventStream for FinishedEvents {
    fn native_turn_id(&self) -> &str {
        &self.native
    }
    async fn recv(&mut self) -> Option<TurnEvent> {
        if self.sent {
            return None;
        }
        self.sent = true;
        Some(TurnEvent {
            at_ms: Some(1),
            idle_timeout: false,
            mapped: crate::external_agents::interactions::MappedEvent {
                wire: Some(wire::Event::Completed),
                ..Default::default()
            },
        })
    }
}
struct NoCommands;
#[async_trait::async_trait]
impl SessionSubscription for NoCommands {
    fn current(&self) -> Vec<wire::Command> {
        Vec::new()
    }
    async fn changed(&mut self) -> Option<Vec<wire::Command>> {
        None
    }
}
fn owned_capabilities() -> wire::Capabilities {
    wire::Capabilities {
        structured_streaming: true,
        reasoning_stream: false,
        interactive_approvals: false,
        resume: false,
        model_catalog: false,
        images: false,
        usage_reporting: false,
        cancellation: true,
        steering: false,
        session_listing: false,
        native_review: false,
        account_usage: false,
    }
}
#[async_trait::async_trait]
impl AgentSession for OwnedSession {
    fn open_result(&self, requested: &wire::Configuration) -> wire::OpenResult {
        wire::OpenResult {
            native_session_id: "owned-native-session".into(),
            resumed: false,
            fallback_reason: None,
            effective_configuration: requested.clone(),
            capabilities: self.capabilities(),
            account_limits: None,
        }
    }
    fn native_session_id(&self) -> String {
        "owned-native-session".into()
    }
    fn capabilities(&self) -> wire::Capabilities {
        let mut capabilities = owned_capabilities();
        capabilities.native_review = self.0.native_review;
        capabilities
    }
    fn subscribe(&self) -> Box<dyn SessionSubscription> {
        Box::new(NoCommands)
    }
    async fn start_turn(&self, request: TurnRequest<'_>) -> AgentResult<TurnStream> {
        let bytes = request
            .attachments
            .into_iter()
            .flat_map(|attachment| attachment.bytes)
            .collect();
        self.0.inputs.lock().unwrap().push((request.input, bytes));
        if let Some(failure) = self.0.start_failure.lock().unwrap().take() {
            return Err(failure);
        }
        Ok(TurnStream {
            dispatch: Dispatch::Accepted,
            native_id: Ok(request.turn_id.clone()),
            events: Box::new(FinishedEvents {
                native: request.turn_id,
                sent: false,
            }),
        })
    }
    async fn start_review(&self, turn_id: String) -> AgentResult<ReviewStream> {
        self.0.reviews.lock().unwrap().push(turn_id.clone());
        if let Some(failure) = self.0.start_failure.lock().unwrap().take() {
            return Err(failure);
        }
        Ok(ReviewStream {
            review_thread_id: self.native_session_id(),
            turn: TurnStream {
                dispatch: Dispatch::Accepted,
                native_id: Ok(turn_id.clone()),
                events: Box::new(FinishedEvents {
                    native: turn_id,
                    sent: false,
                }),
            },
        })
    }
    async fn respond(&self, _answer: Answer) -> AgentResult<()> {
        Ok(())
    }
    async fn steer(&self, _steer: Steer) -> AgentResult<wire::SteerResult> {
        Ok(wire::SteerResult::rejected(
            wire::SteerRejection::NotSupported,
        ))
    }
    async fn cancel(&self, _reason: CancelReason) -> AgentResult<()> {
        Ok(())
    }
    async fn close(&self, reason: CloseCause) -> AgentResult<()> {
        self.0.closes.lock().unwrap().push(reason);
        Ok(())
    }
    async fn refresh_account_usage(&self) -> AgentResult<wire::RefreshAccountUsageResult> {
        Ok(wire::RefreshAccountUsageResult::default())
    }
}
struct OwnedSessions(Arc<OwnedSessionLog>);
#[async_trait::async_trait]
impl AgentBackend for OwnedSessions {
    fn close_budget(&self) -> std::time::Duration {
        std::time::Duration::ZERO
    }
    async fn discover(
        &self,
        _target: wire::TargetId,
        _executable: Option<std::path::PathBuf>,
        _host: Host,
        _key: Option<&AccountKey>,
    ) -> AgentResult<wire::Descriptor> {
        unreachable!("open does not discover")
    }
    async fn open(
        &self,
        _target: wire::TargetId,
        _executable: std::path::PathBuf,
        _host: Host,
        _request: &wire::OpenParams,
    ) -> AgentResult<Box<dyn AgentSession>> {
        Ok(Box::new(OwnedSession(Arc::clone(&self.0))))
    }
    async fn list_sessions(
        &self,
        _target: wire::TargetId,
        _executable: Option<std::path::PathBuf>,
        _host: Host,
        _query: SessionQuery,
    ) -> AgentResult<wire::ListSessionsResult> {
        Ok(wire::ListSessionsResult {
            sessions: Vec::new(),
            next_cursor: None,
        })
    }
}
struct OwnedWorkspace(std::path::PathBuf);
impl super::WorkspaceAuthority for OwnedWorkspace {
    fn authorize<'a>(
        &'a self,
        _hub: &'a mango_protocol::session::Session,
        canonical: &'a std::path::Path,
    ) -> super::PortFuture<'a, bool> {
        Box::pin(async move { canonical == self.0 })
    }
}
struct OwnedExecutable;
impl super::ExecutableResolver for OwnedExecutable {
    fn resolve<'a>(
        &'a self,
        _target: wire::TargetId,
        _cancel: &'a tokio_util::sync::CancellationToken,
    ) -> super::PortFuture<'a, Option<std::path::PathBuf>> {
        Box::pin(async { Some("/owned/fake-agent".into()) })
    }
}

struct OwnedRig {
    supervisor: Arc<Supervisor>,
    configuration: wire::Configuration,
    log: Arc<OwnedSessionLog>,
    hub: mango_protocol::session::Session,
    _runtime: mango_protocol::session::Session,
    _workspace: crate::test_support::ScratchDir,
    scratch: crate::test_support::ScratchDir,
}

/// Opens one owned fake against the actual product admission and protocol event boundary.
async fn owned_rig(log: Arc<OwnedSessionLog>) -> OwnedRig {
    use mango_protocol::frame::PeerInfo;
    use mango_protocol::session::{Session, SessionOptions};
    let (port, peer) = mango_protocol::port::port_pair();
    let info = |role: &str| PeerInfo {
        name: "owned-agent-test".into(),
        version: "0.0.0".into(),
        role: role.into(),
    };
    let (runtime, _) = Session::spawn(port, SessionOptions::new(info("runtime")));
    let (hub, _) = Session::spawn(peer, SessionOptions::new(info("hub")));
    let (runtime_ready, hub_ready) = tokio::join!(runtime.ready(), hub.ready());
    runtime_ready.unwrap();
    hub_ready.unwrap();
    let workspace = crate::test_support::ScratchDir::created("owned-agent-workspace");
    let canonical = crate::workspace_path::canonical_directory(workspace.path()).unwrap();
    let scratch = crate::test_support::ScratchDir::created("owned-agent-session");
    let supervisor = Supervisor::new(Ports {
        harnesses: Arc::new(OwnedSessions(Arc::clone(&log))),
        workspaces: Arc::new(OwnedWorkspace(canonical.clone())),
        executables: Arc::new(OwnedExecutable),
        environment: Arc::new(crate::probing::detection::path_env::PathEnv::default),
        consent: Arc::new(|| true),
        private_root: scratch.path().to_path_buf(),
        runtime_version: "owned-test".into(),
        account_key: Arc::new(|| None),
        session_cap: 1,
        consent_poll: super::CONSENT_POLL,
        consent_read_timeout: std::time::Duration::from_secs(1),
        cleanup_timeout: super::CLEANUP_TIMEOUT,
        hard_turn_timeout: super::HARD_TURN_TIMEOUT,
    });
    let configuration = super::lifecycle_product_tests::configuration();
    let cancel = tokio_util::sync::CancellationToken::new();
    let opened = supervisor
        .open(
            wire::OpenParams {
                session_id: "owned".into(),
                target_id: wire::TargetId::Claude,
                workspace_path: canonical.to_string_lossy().into_owned(),
                configuration: configuration.clone(),
                resume_ref: None,
                resume_mode: wire::ResumeMode::Fallback,
                timeout_ms: 5_000,
                toolchain: None,
            },
            &runtime,
            &cancel,
        )
        .await
        .unwrap();
    assert_eq!(opened.native_session_id, "owned-native-session");
    OwnedRig {
        supervisor,
        configuration,
        log,
        hub,
        _runtime: runtime,
        _workspace: workspace,
        scratch,
    }
}

#[tokio::test]
async fn owned_session_fake_qualifies_product_admission_receipts_and_cleanup() {
    let rig = owned_rig(Arc::new(OwnedSessionLog::default())).await;
    let supervisor = &rig.supervisor;
    let log = &rig.log;
    let configuration = rig.configuration.clone();
    let cancel = tokio_util::sync::CancellationToken::new();
    let mut events = rig.hub.events();
    let request = wire::TurnParams {
        session_id: "owned".into(),
        client_message_id: "message".into(),
        input: "hello".into(),
        configuration,
        attachments: None,
    };
    let first = supervisor.turn(request.clone(), &cancel).await.unwrap();
    let replay = supervisor.turn(request, &cancel).await.unwrap();
    assert_eq!(first, replay);
    let mut completed = false;
    for _ in 0..2 {
        let event = tokio::time::timeout(std::time::Duration::from_secs(1), events.recv())
            .await
            .unwrap()
            .unwrap();
        if event.payload["event"]["type"] == "completed" {
            completed = true;
            break;
        }
    }
    assert!(
        completed,
        "expected the owned stream's terminal on the product event topic"
    );
    assert_eq!(
        log.inputs.lock().unwrap().len(),
        1,
        "a replay must never start native work twice"
    );
    let refusal = supervisor
        .start_review(
            wire::StartReviewParams {
                session_id: "owned".into(),
                client_message_id: "review".into(),
                target: wire::ReviewTarget::UncommittedChanges,
            },
            &cancel,
        )
        .await
        .unwrap_err();
    assert!(refusal.message.contains("native review"));
    supervisor
        .close_session(
            wire::CloseParams {
                session_id: "owned".into(),
            },
            CloseCause::Requested,
        )
        .await
        .unwrap();
    assert_eq!(*log.closes.lock().unwrap(), [CloseCause::Requested]);
    assert_eq!(supervisor.live_sessions().0, 0);
    let scratch_root = rig.scratch.path().join("scratch");
    assert_eq!(std::fs::read_dir(scratch_root).unwrap().count(), 0);
    supervisor.close_all(CloseCause::Shutdown).await;
}

/// Supplies recovery facts through the product's owned port, with no SDK error dependency.
fn owned_refusal(cause: FailureCause) -> AgentFailure {
    AgentFailure {
        remote: Box::new(
            mango_protocol::error::RemoteError::new(
                mango_protocol::error::codes::INTERNAL,
                "Invalid input \"empty\"; expected a nonempty attachment.",
            )
            .with_detail("kind", "tool_argument")
            .with_detail("dispatch", "not-submitted")
            .with_detail("fixture", "preserved"),
        ),
        cause,
        context: FailureContext::Operation,
        retry: RetryAdvice::DoNotRetry,
        dispatch: Some(Dispatch::NotSubmitted),
        session: SessionUsability::Unknown,
        cleanup: CleanupOutcome::NotRequired,
        busy_refusal: false,
    }
}

#[tokio::test]
async fn owned_turn_and_review_refusals_keep_the_session_and_forget_proven_absence() {
    for review in [false, true] {
        for cause in [FailureCause::InvalidRequest, FailureCause::Unsupported] {
            let log = Arc::new(OwnedSessionLog {
                native_review: true,
                ..Default::default()
            });
            *log.start_failure.lock().unwrap() = Some(owned_refusal(cause));
            let rig = owned_rig(Arc::clone(&log)).await;
            let cancel = tokio_util::sync::CancellationToken::new();
            let start = |input: &str| wire::TurnParams {
                session_id: "owned".into(),
                client_message_id: "message".into(),
                input: input.into(),
                configuration: rig.configuration.clone(),
                attachments: None,
            };
            let review_params = wire::StartReviewParams {
                session_id: "owned".into(),
                client_message_id: "message".into(),
                target: wire::ReviewTarget::UncommittedChanges,
            };
            let error = if review {
                rig.supervisor
                    .start_review(review_params.clone(), &cancel)
                    .await
                    .unwrap_err()
            } else {
                rig.supervisor
                    .turn(start("empty"), &cancel)
                    .await
                    .unwrap_err()
            };
            assert_eq!(error.code, mango_protocol::error::codes::INTERNAL);
            assert_eq!(
                error.message,
                "Invalid input \"empty\"; expected a nonempty attachment."
            );
            let details = error.details.as_ref().unwrap();
            assert_eq!(details["kind"], "external_agent_turn_refused");
            assert_eq!(details["retryable"], false);
            assert_eq!(details["dispatch"], "not-submitted");
            assert_eq!(details["fixture"], "preserved");
            assert_eq!(rig.supervisor.live_sessions().0, 1);
            assert!(log.closes.lock().unwrap().is_empty());
            if review {
                let accepted = rig
                    .supervisor
                    .start_review(review_params.clone(), &cancel)
                    .await
                    .unwrap();
                assert_eq!(
                    rig.supervisor
                        .start_review(review_params, &cancel)
                        .await
                        .unwrap(),
                    accepted
                );
                assert_eq!(log.reviews.lock().unwrap().len(), 2);
            } else {
                let accepted = rig.supervisor.turn(start("valid"), &cancel).await.unwrap();
                assert_eq!(
                    rig.supervisor.turn(start("valid"), &cancel).await.unwrap(),
                    accepted
                );
                assert_eq!(log.inputs.lock().unwrap().len(), 2);
            }
            assert!(log.closes.lock().unwrap().is_empty());
            rig.supervisor.close_all(CloseCause::Shutdown).await;
            assert_eq!(*log.closes.lock().unwrap(), [CloseCause::Shutdown]);
        }
    }
}
