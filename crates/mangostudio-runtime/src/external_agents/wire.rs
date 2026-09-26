//! The `external-agent.*` product wire, as typed Rust.
//!
//! Mirrors `apps/shared/src/external-agents/schemas.ts`, which stays the single
//! source of truth: the dispatcher validates every param against the embedded
//! catalog before a handler runs, and every result against it before it leaves
//! (`crate::result_check`). These types exist so the mapper and the supervisor
//! agree on one shape rather than on hand-built JSON. They carry no bounds of
//! their own: a bound lives in the schema, and a value the mapper produces past
//! it is refused at the result gate rather than silently truncated here.
//!
//! Params deserialize with `deny_unknown_fields`, matching the schemas'
//! `additionalProperties: false`. Results serialize optional members only when
//! present, because absence and an explicit `null` mean different things on
//! this wire.

use serde::{Deserialize, Serialize};

use crate::commands::toolchain::Selection as ToolchainSelection;

/// A product target. The wire has exactly these three; other SDK profiles are
/// inert until the product adds vendor metadata for them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum TargetId {
    /// OpenAI Codex, over its app-server dialect.
    Codex,
    /// Cursor, over the ACP harness's `cursor` profile.
    Cursor,
    /// Claude Code, over its stream-json dialect.
    Claude,
}

impl TargetId {
    /// Every target, in the wire's declaration order.
    pub(crate) const ALL: [Self; 3] = [Self::Codex, Self::Cursor, Self::Claude];

    /// The wire spelling.
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Cursor => "cursor",
            Self::Claude => "claude",
        }
    }
}

/// `ExternalAgentCapabilities`: twelve flags, all required.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(
    clippy::struct_excessive_bools,
    reason = "mirrors the wire's twelve flags"
)]
pub(crate) struct Capabilities {
    pub structured_streaming: bool,
    pub reasoning_stream: bool,
    pub interactive_approvals: bool,
    pub resume: bool,
    pub model_catalog: bool,
    pub images: bool,
    pub usage_reporting: bool,
    pub cancellation: bool,
    pub steering: bool,
    pub session_listing: bool,
    pub native_review: bool,
    pub account_usage: bool,
}

/// `ExternalPermissionLevel`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum PermissionLevel {
    ReadOnly,
    Default,
    FullAccess,
}

/// `ExternalApprovalRouting`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ApprovalRouting {
    User,
    AutoReview,
}

/// One `ExternalSupportedConfiguration` cell.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SupportedConfiguration {
    pub level: PermissionLevel,
    pub routing: ApprovalRouting,
    pub supported: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unsupported_reason_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vendor_id: Option<String>,
    pub unattended: bool,
}

/// `ExternalAgentReasoningEffort`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReasoningEffort {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// `ExternalAgentModel`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Model {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_default: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hidden: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_modalities: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supported_reasoning_efforts: Option<Vec<ReasoningEffort>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_reasoning_effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service_tiers: Option<Vec<String>>,
}

/// `ExternalAgentConfiguration`: what a hub asks for, and what an open accepted.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Configuration {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    pub level: PermissionLevel,
    pub routing: ApprovalRouting,
    pub workspace_roots: Vec<String>,
}

/// `ExternalAgentAuthState`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum AuthState {
    SignedIn,
    SignedOut,
    Unknown,
}

/// `ExternalAgentUnavailableReason`, restricted to what a runtime can observe.
/// The hub adds its own reasons (`runtime-denied`, `isolation-unproven`, …).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum UnavailableReason {
    NotInstalled,
    SignedOut,
    VersionUnsupported,
}

/// `ExternalAgentRemedyKind`, restricted likewise.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum RemedyKind {
    Install,
    Update,
    SignIn,
}

/// `ExternalAgentRemedy`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Remedy {
    pub kind: RemedyKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
}

/// `ExternalAgentAccount`. `fingerprint` is a host-keyed digest, never a raw
/// identity: see `isolation::host_local_digest_key`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Account {
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fingerprint: Option<String>,
}

/// `ExternalAgentDiscoveryReport`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiscoveryReport {
    pub source: DiscoverySource,
    pub probed_at_ms: u64,
    pub attempts: u8,
}

/// Where a descriptor's facts came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum DiscoverySource {
    /// Measured by this call. The runtime keeps no discovery cache.
    Live,
}

/// `ExternalAgentRuntimeDescriptor` (the hub adds `environmentId`).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Descriptor {
    pub target_id: TargetId,
    pub installed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub required_version: Option<String>,
    pub auth_state: AuthState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub login_command: Option<String>,
    pub capabilities: Capabilities,
    pub supported_configurations: Vec<SupportedConfiguration>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub models: Option<Vec<Model>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<Account>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<UnavailableReason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remedy: Option<Remedy>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub discovery: Option<DiscoveryReport>,
}

/// `ExternalRateLimitWindow`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RateLimitWindow {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub used_percent: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_duration_mins: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resets_at_ms: Option<u64>,
}

/// `ExternalCredits`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Credits {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_credits: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unlimited: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub balance: Option<String>,
}

/// `ExternalSpendControl`.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpendControl {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub used: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remaining_percent: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resets_at_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reached: Option<bool>,
}

/// `ExternalResetCredit`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResetCredit {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reset_type: Option<String>,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub granted_at_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// `ExternalResetCredits`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResetCredits {
    pub available_count: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credits: Option<Vec<ResetCredit>>,
}

/// `ExternalRateLimitBucket`.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RateLimitBucket {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub primary: Option<RateLimitWindow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secondary: Option<RateLimitWindow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credits: Option<Credits>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spend_control: Option<SpendControl>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reached_type: Option<String>,
}

/// `ExternalRateLimitById`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RateLimitById {
    pub limit_id: String,
    pub snapshot: RateLimitBucket,
}

/// `ExternalAccountLimits`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AccountLimits {
    pub target_id: TargetId,
    pub windows: Vec<RateLimitWindow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub by_limit_id: Option<Vec<RateLimitById>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credits: Option<Credits>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spend_control: Option<SpendControl>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reset_credits: Option<ResetCredits>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reached_type: Option<String>,
    pub observed_at_ms: u64,
}

/// `ExternalNativeSession`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeSession {
    pub target_id: TargetId,
    pub native_session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at_ms: Option<u64>,
}

/// `external-agent.discover` params.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DiscoverParams {
    pub target_ids: Vec<TargetId>,
    pub timeout_ms: u64,
}

/// `external-agent.discover` result.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiscoverResult {
    pub descriptors: Vec<Descriptor>,
}

/// `ExternalAgentResumeMode`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ResumeMode {
    /// Resume that exact conversation, or fail.
    Strict,
    /// Resume it, or start fresh and say why.
    Fallback,
}

/// `external-agent.open` params.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OpenParams {
    pub session_id: String,
    pub target_id: TargetId,
    pub workspace_path: String,
    pub configuration: Configuration,
    #[serde(default)]
    pub resume_ref: Option<String>,
    pub resume_mode: ResumeMode,
    pub timeout_ms: u64,
    #[serde(default)]
    pub toolchain: Option<ToolchainSelection>,
}

/// `external-agent.open` result.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenResult {
    pub native_session_id: String,
    pub resumed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback_reason: Option<String>,
    pub effective_configuration: Configuration,
    pub capabilities: Capabilities,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_limits: Option<AccountLimits>,
}

/// `external-agent.close` params.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CloseParams {
    pub session_id: String,
}

/// `ExternalAgentAckResult`: `{ "ok": true }`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct AckResult {
    ok: bool,
}

impl AckResult {
    /// The only value the wire allows.
    pub(crate) const OK: Self = Self { ok: true };
}

/// `external-agent.refresh-account-usage` params.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RefreshAccountUsageParams {
    pub target_id: TargetId,
    #[serde(default)]
    pub session_id: Option<String>,
    pub timeout_ms: u64,
}

/// `external-agent.refresh-account-usage` result. `{}` means "nothing to
/// report", never "no limits".
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RefreshAccountUsageResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limits: Option<AccountLimits>,
}

/// `external-agent.list-sessions` params.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ListSessionsParams {
    pub target_id: TargetId,
    #[serde(default)]
    pub workspace_path: Option<String>,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub session_id: Option<String>,
    pub timeout_ms: u64,
}

/// `external-agent.list-sessions` result.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ListSessionsResult {
    pub sessions: Vec<NativeSession>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

/// `ExternalAgentAttachment`: bytes the hub already bounded, as base64.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Attachment {
    pub id: String,
    pub original_name: String,
    pub mime_type: String,
    pub size_bytes: u64,
    pub kind: AttachmentKind,
    pub bytes_base64: String,
}

/// `ExternalAgentAttachment.kind`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum AttachmentKind {
    Image,
    Text,
    Pdf,
    Data,
    Unknown,
}

/// `external-agent.turn` params.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TurnParams {
    pub session_id: String,
    pub client_message_id: String,
    pub input: String,
    pub configuration: Configuration,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<Attachment>>,
}

/// `external-agent.turn` result.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TurnResult {
    pub native_turn_id: String,
}

/// `external-agent.respond` params: an answer to one approval.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RespondParams {
    pub session_id: String,
    pub native_turn_id: String,
    pub request_id: String,
    pub option_id: String,
}

/// `external-agent.steer` params.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SteerParams {
    pub session_id: String,
    pub native_turn_id: String,
    pub client_message_id: String,
    pub input: String,
}

/// `ExternalSteerRejectionReason`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum SteerRejection {
    TurnAlreadyCompleted,
    NotSupported,
    TurnNotSteerable,
    IdReused,
}

/// `external-agent.steer` result.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub(crate) enum SteerResult {
    /// `{ "accepted": true }`.
    Accepted {
        /// Always `true`.
        accepted: bool,
    },
    /// `{ "accepted": false, "reasonCode": … }`.
    Rejected {
        /// Always `false`.
        accepted: bool,
        /// Why the steer did not land.
        #[serde(rename = "reasonCode")]
        reason_code: SteerRejection,
    },
}

impl SteerResult {
    /// The steer reached the running turn.
    pub(crate) const ACCEPTED: Self = Self::Accepted { accepted: true };

    /// The steer was refused for `reason`.
    pub(crate) fn rejected(reason: SteerRejection) -> Self {
        Self::Rejected {
            accepted: false,
            reason_code: reason,
        }
    }
}

/// `ExternalReviewTarget`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
pub(crate) enum ReviewTarget {
    /// The working tree's uncommitted changes.
    #[serde(rename = "uncommittedChanges")]
    UncommittedChanges,
}

/// `external-agent.start-review` params.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StartReviewParams {
    pub session_id: String,
    pub client_message_id: String,
    pub target: ReviewTarget,
}

/// `external-agent.start-review` result.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StartReviewResult {
    pub native_turn_id: String,
    pub review_thread_id: String,
}

/// `external-agent.cancel` params.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CancelParams {
    pub session_id: String,
    #[serde(default)]
    pub native_turn_id: Option<String>,
}

/// `ExternalActivityKind`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ActivityKind {
    Command,
    FileChange,
    Mcp,
    Subagent,
    WebSearch,
    Image,
    Plan,
    Review,
    Compaction,
    Other,
}

/// `ExternalActivityView`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ActivityView {
    pub name: String,
    pub kind: ActivityKind,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
}

/// `ExternalActivityUpdate`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ActivityUpdate {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
}

/// `ExternalActivityStatus`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ActivityStatus {
    Completed,
    Failed,
    Cancelled,
}

/// `ExternalActivityResult`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ActivityResult {
    pub status: ActivityStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
}

/// `ExternalApprovalOption`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ApprovalOption {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_label: Option<String>,
    pub is_destructive: bool,
}

/// `ExternalApprovalRequest`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ApprovalRequest {
    pub request_id: String,
    pub kind: ActivityKind,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub options: Vec<ApprovalOption>,
    pub expires_at_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
}

/// `ExternalApprovalDecision.source`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum DecisionSource {
    User,
    AutoReview,
    Expired,
    Cancelled,
}

/// `ExternalApprovalDecision`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ApprovalDecision {
    pub option_id: String,
    pub source: DecisionSource,
}

/// `ExternalUsage`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Usage {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_read_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_write_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_tokens: Option<u64>,
}

/// `ExternalThreadUsage`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ThreadUsage {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last: Option<Usage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<Usage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window_tokens: Option<u64>,
}

/// `ExternalAgentError`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retryable: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vendor_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
}

/// `ExternalAgentCommand`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Command {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// `ExternalAgentEvent`: one event on the `external-agent.event` topic.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum Event {
    /// The slash-command catalog, a session fact.
    CommandsAvailable {
        commands: Vec<Command>,
    },
    TextDelta {
        text: String,
    },
    ReasoningDelta {
        text: String,
    },
    ReasoningStarted,
    ReasoningEnded,
    ActivityStarted {
        #[serde(rename = "callId")]
        call_id: String,
        activity: ActivityView,
    },
    ActivityUpdated {
        #[serde(rename = "callId")]
        call_id: String,
        update: ActivityUpdate,
    },
    ActivityCompleted {
        #[serde(rename = "callId")]
        call_id: String,
        result: ActivityResult,
    },
    ApprovalRequested {
        request: ApprovalRequest,
    },
    ApprovalResolved {
        #[serde(rename = "requestId")]
        request_id: String,
        decision: ApprovalDecision,
    },
    Usage {
        usage: Usage,
    },
    ThreadUsage {
        usage: ThreadUsage,
    },
    AccountLimits {
        limits: AccountLimits,
    },
    Cancelled,
    Completed,
    Error {
        error: AgentError,
    },
}

/// `ExternalAgentEventEnvelope`: what the topic carries.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EventEnvelope {
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_turn_id: Option<String>,
    pub sequence: u64,
    pub emitted_at_ms: u64,
    pub event: Event,
}
