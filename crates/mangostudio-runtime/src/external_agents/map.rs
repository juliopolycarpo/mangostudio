//! The one mapping between SDK types and the `external-agent.*` product wire.
//!
//! Everything here is pure, synchronous and deterministic: the supervisor
//! calls the SDK, then hands the SDK's answer to one of these functions and
//! returns what comes back. No function reads the clock, the environment or
//! the disk; a time the wire needs is a parameter.
//!
//! Two rules the SDK does not apply for us, and which this module owns:
//!
//! - **Product policy is narrower than the SDK.** The ACP harness offers
//!   auto-review routing for Cursor, because to ACP who answers an approval is
//!   the host's arrangement. The product never answers a vendor's approval on
//!   its own authority, so those cells are refused here, with the key the
//!   TypeScript adapter used. The supervisor must refuse the same pairs at
//!   open time: the SDK itself would accept them.
//! - **Reason keys are the product's copy.** The SDK reports a closed
//!   [`UnsupportedReason`](sdk::UnsupportedReason) per cell and deliberately no
//!   i18n key. [`unsupported_reason_key`] is the explicit table from
//!   `(target, level, routing, reason)` to the keys the frontend already ships;
//!   a cell the table cannot place carries no key rather than an invented one.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use mango_agent_acp::AcpHarness;
use mango_agent_claude::ClaudeHarness;
use mango_agent_codex::CodexHarness;
use mango_external_agents as sdk;
use mango_protocol::error::{RemoteError, codes};

use super::wire::{self, TargetId};

/// The only ACP profile the product drives.
const CURSOR_PROFILE: &str = "cursor";

/// Cursor's own login command, as the TypeScript adapter always offered it.
const CURSOR_LOGIN_COMMAND: &str = "cursor-agent login";

/// `EXTERNAL_NATIVE_SESSION_PAGE_LIMIT` in `apps/shared/src/external-agents/schemas.ts`.
const NATIVE_SESSION_PAGE_LIMIT: usize = 50;

/// The i18n keys a supported-configuration cell may carry. Every value here
/// exists in the frontend's `externalAgents.unsupported.*` catalog.
mod keys {
    pub(super) const CLAUDE_AUTO_DISABLED_BY_POLICY: &str =
        "externalAgents.unsupported.claudeAutoDisabledByPolicy";
    pub(super) const CLAUDE_AUTO_NEEDS_SUBSCRIPTION: &str =
        "externalAgents.unsupported.claudeAutoNeedsSubscription";
    pub(super) const CLAUDE_AUTO_UNVERIFIED: &str =
        "externalAgents.unsupported.claudeAutoUnverified";
    pub(super) const CLAUDE_FULL_ACCESS_HAS_NO_REVIEWER: &str =
        "externalAgents.unsupported.claudeFullAccessHasNoReviewer";
    pub(super) const CLAUDE_MODE_MISSING: &str = "externalAgents.unsupported.claudeModeMissing";
    pub(super) const CLAUDE_READ_ONLY_HAS_NO_REVIEWER: &str =
        "externalAgents.unsupported.claudeReadOnlyHasNoReviewer";
    pub(super) const CLAUDE_VERSION_TOO_OLD: &str =
        "externalAgents.unsupported.claudeVersionTooOld";
    pub(super) const CODEX_VERSION_TOO_OLD: &str = "externalAgents.unsupported.codexVersionTooOld";
    pub(super) const CURSOR_ACP_UNAVAILABLE: &str =
        "externalAgents.unsupported.cursorAcpUnavailable";
    pub(super) const CURSOR_NO_AUTO_REVIEW: &str = "externalAgents.unsupported.cursorNoAutoReview";
    pub(super) const CURSOR_NO_FULL_ACCESS: &str = "externalAgents.unsupported.cursorNoFullAccess";
    pub(super) const CURSOR_VERSION_TOO_OLD: &str =
        "externalAgents.unsupported.cursorVersionTooOld";
}

// ---------------------------------------------------------------------------
// Harnesses
// ---------------------------------------------------------------------------

/// The SDK harness that drives `target`, using `executable` when the host
/// resolved one and the harness's own program name otherwise.
///
/// Cursor is the ACP harness's built-in `cursor` profile, which launches
/// `cursor-agent acp` (never the `agent` alias Grok also installs). No other
/// ACP profile is reachable from here.
///
/// # Panics
///
/// Never in practice: the `cursor` profile ships with the pinned
/// `mango-agent-acp`, and `tests::cursor_launches_cursor_agent` pins it.
///
/// # Example
///
/// ```ignore
/// let harness = harness_for(TargetId::Cursor, Some(PathBuf::from("/opt/cursor-agent")));
/// assert_eq!(harness.descriptor().id().as_str(), "acp:cursor");
/// ```
pub(crate) fn harness_for(target: TargetId, executable: Option<PathBuf>) -> Arc<dyn sdk::Harness> {
    match target {
        TargetId::Claude => {
            let harness = ClaudeHarness::new();
            Arc::new(match executable {
                Some(path) => harness.with_executable(path),
                None => harness,
            })
        }
        TargetId::Codex => {
            let harness = CodexHarness::new();
            Arc::new(match executable {
                Some(path) => harness.with_executable(sdk::ExecutablePath::resolved(path)),
                None => harness,
            })
        }
        TargetId::Cursor => {
            let harness = AcpHarness::builtin(CURSOR_PROFILE)
                .expect("mango-agent-acp ships the cursor profile");
            Arc::new(match executable {
                Some(path) => harness.with_executable(sdk::ExecutablePath::resolved(path)),
                None => harness,
            })
        }
    }
}

/// The registry of exactly the three product targets, each with its default
/// executable. Grok and every other ACP profile are absent, so a lookup by
/// any other id fails.
///
/// # Errors
///
/// A [`RemoteError`] when the SDK refuses the registration, which only a
/// duplicate id could cause.
///
/// # Example
///
/// ```ignore
/// let registry = product_harnesses()?;
/// assert!(registry.get(&harness_id(TargetId::Codex)).is_some());
/// ```
#[cfg(test)]
pub(crate) fn product_harnesses() -> Result<sdk::HarnessRegistry, RemoteError> {
    let harnesses = TargetId::ALL
        .into_iter()
        .map(|target| harness_for(target, None))
        .collect();
    sdk::HarnessRegistry::new(harnesses).map_err(|error| remote_error(&error))
}

/// The SDK harness id a product target registers under: `claude`, `codex`,
/// `acp:cursor`.
///
/// # Example
///
/// ```ignore
/// assert_eq!(harness_id(TargetId::Cursor).as_str(), "acp:cursor");
/// ```
#[cfg(test)]
pub(crate) fn harness_id(target: TargetId) -> sdk::HarnessId {
    match target {
        TargetId::Claude => sdk::HarnessId::claude(),
        TargetId::Codex => sdk::HarnessId::codex(),
        TargetId::Cursor => harness_for(target, None).descriptor().id().clone(),
    }
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/// Why a gate refused an installed build, as the product words it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum GateRefusal {
    /// Older than the floor, or missing a surface every turn needs.
    VersionUnsupported,
    /// Cursor's handshake surface is missing on a build the version does not
    /// explain: an upgrade is not the fix, so the row must not claim it is.
    CursorAcpUnavailable,
}

/// The descriptor for one target from one SDK probe, reproducing what the
/// TypeScript adapter's `discover` returned for the same facts.
///
/// Never carries an account email or other raw identity: the SDK has none to
/// give, and `account.fingerprint` stays absent (see the module report).
///
/// # Example
///
/// ```ignore
/// let descriptor = descriptor(TargetId::Codex, &sdk::Discovery::not_installed(), 1_000);
/// assert!(!descriptor.installed);
/// ```
pub(crate) fn descriptor(
    target: TargetId,
    discovery: &sdk::Discovery,
    probed_at_ms: u64,
) -> wire::Descriptor {
    let report = Some(wire::DiscoveryReport {
        source: wire::DiscoverySource::Live,
        probed_at_ms,
        attempts: 1,
    });
    match &discovery.gate {
        sdk::GateVerdict::NotInstalled => not_installed(target, report),
        sdk::GateVerdict::VersionTooOld { minimum, .. } => {
            refused(target, discovery, Some(minimum.clone()), report)
        }
        sdk::GateVerdict::MissingRequiredSurface { .. } => {
            refused(target, discovery, surface_floor(target), report)
        }
        _ => usable(target, discovery, report),
    }
}

/// A target with nothing installed: an empty matrix, the vendor's login
/// command, and the install remedy.
fn not_installed(target: TargetId, report: Option<wire::DiscoveryReport>) -> wire::Descriptor {
    wire::Descriptor {
        target_id: target,
        installed: false,
        version: None,
        required_version: None,
        auth_state: wire::AuthState::Unknown,
        login_command: Some(login_command(target).to_owned()),
        capabilities: wire::Capabilities::default(),
        supported_configurations: Vec::new(),
        models: None,
        account: None,
        unavailable_reason: Some(wire::UnavailableReason::NotInstalled),
        remedy: Some(remedy(wire::RemedyKind::Install, None)),
        discovery: report,
    }
}

/// An installed build the gate refused: every cell refused for the gate's
/// reason, no capability claimed.
fn refused(
    target: TargetId,
    discovery: &sdk::Discovery,
    floor: Option<String>,
    report: Option<wire::DiscoveryReport>,
) -> wire::Descriptor {
    let refusal = gate_refusal(target, &discovery.gate);
    let unavailable = (refusal == GateRefusal::VersionUnsupported)
        .then_some(wire::UnavailableReason::VersionUnsupported);
    // Claude and Codex never reached an auth surface on a refused build, and
    // said so; Cursor read its status before the handshake, and kept it.
    let (auth_state, login, account) = match target {
        TargetId::Cursor => auth_facts(target, &discovery.auth),
        TargetId::Claude | TargetId::Codex => (wire::AuthState::Unknown, None, None),
    };
    wire::Descriptor {
        target_id: target,
        installed: true,
        version: discovery.version.clone(),
        required_version: unavailable.and(floor),
        auth_state,
        login_command: login,
        capabilities: wire::Capabilities::default(),
        supported_configurations: refused_cells(target, &discovery.permission_matrix, refusal),
        models: None,
        account,
        unavailable_reason: unavailable,
        remedy: unavailable.map(|_| remedy(wire::RemedyKind::Update, None)),
        discovery: report,
    }
}

/// A build the gate let through, or one it could not judge.
fn usable(
    target: TargetId,
    discovery: &sdk::Discovery,
    report: Option<wire::DiscoveryReport>,
) -> wire::Descriptor {
    let (auth_state, login, account) = auth_facts(target, &discovery.auth);
    let signed_out = auth_state == wire::AuthState::SignedOut;
    let models: Vec<wire::Model> = discovery
        .models
        .iter()
        .map(|model| wire_model(target, model))
        .collect();
    wire::Descriptor {
        target_id: target,
        installed: true,
        version: discovery.version.clone(),
        required_version: None,
        auth_state,
        remedy: signed_out.then(|| remedy(wire::RemedyKind::SignIn, login.clone())),
        login_command: login,
        capabilities: capabilities(discovery.capabilities.capabilities()),
        supported_configurations: discovery
            .permission_matrix
            .cells()
            .iter()
            .map(|cell| supported_configuration(target, cell))
            .collect(),
        models: (!models.is_empty()).then_some(models),
        account,
        unavailable_reason: signed_out.then_some(wire::UnavailableReason::SignedOut),
        discovery: report,
    }
}

/// Which refusal a non-usable gate means for this target.
fn gate_refusal(target: TargetId, gate: &sdk::GateVerdict) -> GateRefusal {
    match (target, gate) {
        (TargetId::Cursor, sdk::GateVerdict::MissingRequiredSurface { .. }) => {
            GateRefusal::CursorAcpUnavailable
        }
        _ => GateRefusal::VersionUnsupported,
    }
}

/// The version a missing-surface refusal names, where the vendor has a floor.
fn surface_floor(target: TargetId) -> Option<String> {
    match target {
        TargetId::Claude => Some(mango_agent_claude::pinned::MINIMUM_VERSION.to_owned()),
        TargetId::Codex => Some(mango_agent_codex::MINIMUM_CODEX_VERSION.to_owned()),
        TargetId::Cursor => None,
    }
}

/// The key every cell of a gate-refused matrix carries.
fn gate_refusal_key(target: TargetId, refusal: GateRefusal) -> &'static str {
    match (target, refusal) {
        (TargetId::Claude, _) => keys::CLAUDE_VERSION_TOO_OLD,
        (TargetId::Codex, _) => keys::CODEX_VERSION_TOO_OLD,
        (TargetId::Cursor, GateRefusal::VersionUnsupported) => keys::CURSOR_VERSION_TOO_OLD,
        (TargetId::Cursor, GateRefusal::CursorAcpUnavailable) => keys::CURSOR_ACP_UNAVAILABLE,
    }
}

/// Every cell refused for one gate reason. Claude's TypeScript matrix named no
/// vendor id on a refused build; Codex's and Cursor's kept theirs.
fn refused_cells(
    target: TargetId,
    matrix: &sdk::PermissionMatrix,
    refusal: GateRefusal,
) -> Vec<wire::SupportedConfiguration> {
    let key = gate_refusal_key(target, refusal);
    matrix
        .cells()
        .iter()
        .map(|cell| wire::SupportedConfiguration {
            level: level_to_wire(cell.level),
            routing: routing_to_wire(cell.routing),
            supported: false,
            unsupported_reason_key: Some(key.to_owned()),
            vendor_id: match target {
                TargetId::Claude => None,
                TargetId::Codex | TargetId::Cursor => cell.vendor_id.clone(),
            },
            unattended: cell.unattended,
        })
        .collect()
}

/// One SDK cell as the product offers it.
///
/// Cursor's auto-review cells are refused whatever the SDK says: ACP would
/// let the host answer the agent's approvals, which is the product granting a
/// permission on a vendor's behalf.
fn supported_configuration(
    target: TargetId,
    cell: &sdk::SupportedConfiguration,
) -> wire::SupportedConfiguration {
    let product_refusal = target == TargetId::Cursor
        && cell.routing == sdk::ApprovalRouting::AutoReview
        && cell.supported;
    let supported = cell.supported && !product_refusal;
    let key = if product_refusal {
        Some(keys::CURSOR_NO_AUTO_REVIEW)
    } else {
        cell.unsupported_reason
            .as_ref()
            .filter(|_| !cell.supported)
            .and_then(|reason| unsupported_reason_key(target, cell.level, cell.routing, reason))
    };
    wire::SupportedConfiguration {
        level: level_to_wire(cell.level),
        routing: routing_to_wire(cell.routing),
        supported,
        unsupported_reason_key: key.map(str::to_owned),
        vendor_id: cell.vendor_id.clone(),
        unattended: cell.unattended,
    }
}

/// The i18n key for one refused cell, or `None` when the TypeScript adapter
/// had no key for this combination of facts.
///
/// Derived cell by cell from `claude/permissions.ts` and
/// `cursor/permissions.ts` against `mango_agent_claude::permissions::matrix`
/// and `mango_agent_acp::profile::matrix`. Codex's SDK matrix refuses nothing
/// per cell, so Codex has no row here; its only keys come from the gate.
///
/// # Example
///
/// ```ignore
/// let key = unsupported_reason_key(
///     TargetId::Claude,
///     sdk::PermissionLevel::Default,
///     sdk::ApprovalRouting::AutoReview,
///     &sdk::UnsupportedReason::RequiresAccountUpgrade,
/// );
/// assert_eq!(key, Some("externalAgents.unsupported.claudeAutoNeedsSubscription"));
/// ```
pub(crate) fn unsupported_reason_key(
    target: TargetId,
    level: sdk::PermissionLevel,
    routing: sdk::ApprovalRouting,
    reason: &sdk::UnsupportedReason,
) -> Option<&'static str> {
    use sdk::ApprovalRouting::{AutoReview, User};
    use sdk::PermissionLevel::{Default, FullAccess, ReadOnly};
    use sdk::UnsupportedReason as Reason;
    match (target, level, routing, reason) {
        (TargetId::Claude, _, _, Reason::RequiresNewerVersion) => Some(keys::CLAUDE_MODE_MISSING),
        (TargetId::Claude, ReadOnly, AutoReview, Reason::NotOfferedByVendor) => {
            Some(keys::CLAUDE_READ_ONLY_HAS_NO_REVIEWER)
        }
        (TargetId::Claude, FullAccess, AutoReview, Reason::NotOfferedByVendor) => {
            Some(keys::CLAUDE_FULL_ACCESS_HAS_NO_REVIEWER)
        }
        (TargetId::Claude, Default, AutoReview, Reason::UnattendedNotPermitted) => {
            Some(keys::CLAUDE_AUTO_DISABLED_BY_POLICY)
        }
        (TargetId::Claude, Default, AutoReview, Reason::RequiresAccountUpgrade) => {
            Some(keys::CLAUDE_AUTO_NEEDS_SUBSCRIPTION)
        }
        (TargetId::Claude, Default, AutoReview, Reason::Other(_) | Reason::NotOfferedByVendor) => {
            Some(keys::CLAUDE_AUTO_UNVERIFIED)
        }
        (TargetId::Cursor, _, AutoReview, _) => Some(keys::CURSOR_NO_AUTO_REVIEW),
        (TargetId::Cursor, FullAccess, User, Reason::NotOfferedByVendor) => {
            Some(keys::CURSOR_NO_FULL_ACCESS)
        }
        _ => None,
    }
}

/// `(authState, loginCommand, account)` for one SDK auth reading.
///
/// The login command follows TypeScript: the vendor's own hint when signed
/// out, the vendor constant when unknown, nothing when signed in.
fn auth_facts(
    target: TargetId,
    auth: &sdk::AuthState,
) -> (wire::AuthState, Option<String>, Option<wire::Account>) {
    match auth {
        sdk::AuthState::LoggedIn { mode } => (
            wire::AuthState::SignedIn,
            None,
            Some(wire::Account {
                label: account_label(target, mode).to_owned(),
                plan_type: None,
                fingerprint: None,
            }),
        ),
        sdk::AuthState::LoggedOut { login_hint } => {
            (wire::AuthState::SignedOut, Some(login_hint.clone()), None)
        }
        _ => (
            wire::AuthState::Unknown,
            Some(login_command(target).to_owned()),
            None,
        ),
    }
}

/// The account label the owner recognises, never an email or organisation.
/// The same strings `claude/auth.ts`, `codex/adapter.ts` and `cursor/adapter.ts`
/// produced.
fn account_label(target: TargetId, mode: &sdk::AuthMode) -> &'static str {
    match (target, mode) {
        (TargetId::Claude, sdk::AuthMode::Subscription) => "Claude account",
        (TargetId::Claude, sdk::AuthMode::ApiKey) => "Anthropic API key",
        (TargetId::Claude, _) => "Cloud provider credentials",
        (TargetId::Codex, sdk::AuthMode::Subscription) => "ChatGPT",
        (TargetId::Codex, sdk::AuthMode::ApiKey) => "API key",
        (TargetId::Codex, sdk::AuthMode::Other(label)) if label == "amazon-bedrock" => {
            "Amazon Bedrock"
        }
        (TargetId::Codex, _) => "Signed in",
        (TargetId::Cursor, _) => "Cursor",
    }
}

/// The vendor's own login command.
fn login_command(target: TargetId) -> &'static str {
    match target {
        TargetId::Claude => mango_agent_claude::pinned::LOGIN_COMMAND,
        TargetId::Codex => mango_agent_codex::harness::CODEX_LOGIN_HINT,
        TargetId::Cursor => CURSOR_LOGIN_COMMAND,
    }
}

fn remedy(kind: wire::RemedyKind, command: Option<String>) -> wire::Remedy {
    wire::Remedy { kind, command }
}

/// One SDK model. Codex reported `isDefault` on every row; Claude and Cursor
/// only on the default one.
fn wire_model(target: TargetId, model: &sdk::Model) -> wire::Model {
    let efforts: Vec<wire::ReasoningEffort> = model
        .reasoning_efforts
        .iter()
        .map(|effort| wire::ReasoningEffort {
            id: effort.id.clone(),
            display_name: effort.display_name.clone(),
            description: effort.description.clone(),
        })
        .collect();
    wire::Model {
        id: model.id.clone(),
        display_name: model.display_name.clone(),
        description: model.description.clone(),
        is_default: match target {
            TargetId::Codex => Some(model.is_default),
            TargetId::Claude | TargetId::Cursor => model.is_default.then_some(true),
        },
        hidden: None,
        input_modalities: None,
        supported_reasoning_efforts: (!efforts.is_empty()).then_some(efforts),
        default_reasoning_effort: model.default_reasoning_effort.clone(),
        service_tiers: None,
    }
}

/// The twelve wire flags, each from the SDK field of the same name.
///
/// The SDK table is destructured without `..`, so a capability the SDK adds
/// is a compile error here rather than a flag silently left behind. The five
/// the wire has no member for are named and dropped.
///
/// # Example
///
/// ```ignore
/// let flags = capabilities(&sdk::Capabilities { resume: true, ..sdk::Capabilities::none() });
/// assert!(flags.resume && !flags.steering);
/// ```
pub(crate) fn capabilities(capabilities: &sdk::Capabilities) -> wire::Capabilities {
    let sdk::Capabilities {
        structured_streaming,
        reasoning_stream,
        interactive_approvals,
        questions: _,
        resume,
        model_catalog,
        configuration_catalog: _,
        session_configuration: _,
        images,
        usage_reporting,
        cancellation,
        steering,
        session_listing,
        native_review,
        account_usage,
        mcp_passthrough: _,
        configuration: _,
    } = *capabilities;
    wire::Capabilities {
        structured_streaming,
        reasoning_stream,
        interactive_approvals,
        resume,
        model_catalog,
        images,
        usage_reporting,
        cancellation,
        steering,
        session_listing,
        native_review,
        account_usage,
    }
}

// ---------------------------------------------------------------------------
// Configuration and open
// ---------------------------------------------------------------------------

/// The SDK patch a requested wire configuration asks for.
///
/// An absent `model` or `effort` keeps whatever the vendor or an earlier
/// override chose; it never clears it. Level and routing are always set,
/// because the wire always carries both.
///
/// # Example
///
/// ```ignore
/// let patch = configuration_patch(&requested);
/// assert!(patch.model.is_keep());
/// ```
pub(crate) fn configuration_patch(requested: &wire::Configuration) -> sdk::ConfigurationPatch {
    sdk::ConfigurationPatch::new()
        .model(keep_or_set(requested.model.clone()))
        .effort(keep_or_set(requested.effort.clone()))
        .level(sdk::ConfigurationChange::Set(level_to_sdk(requested.level)))
        .routing(sdk::ConfigurationChange::Set(routing_to_sdk(
            requested.routing,
        )))
}

fn keep_or_set(value: Option<String>) -> sdk::ConfigurationChange<String> {
    match value {
        Some(value) => sdk::ConfigurationChange::Set(value),
        None => sdk::ConfigurationChange::Keep,
    }
}

/// The `external-agent.open` result for a session the SDK opened.
///
/// `effectiveConfiguration` takes each axis from what the harness accepted
/// and falls back to the request per axis. `workspaceRoots` is always the
/// request's: the SDK has no such axis, and the roots are what the host
/// authorised, so echoing them is the truthful answer.
///
/// # Example
///
/// ```ignore
/// let result = open_result(&params.configuration, &session.snapshot(), None);
/// assert_eq!(result.native_session_id, session.snapshot().ids.native_session_id);
/// ```
pub(crate) fn open_result(
    requested: &wire::Configuration,
    snapshot: &sdk::SessionSnapshot,
    account_limits: Option<wire::AccountLimits>,
) -> wire::OpenResult {
    let accepted = &snapshot.configuration.accepted;
    wire::OpenResult {
        native_session_id: snapshot.ids.native_session_id.clone(),
        resumed: snapshot.resumed,
        fallback_reason: snapshot.fallback_reason.clone(),
        effective_configuration: wire::Configuration {
            model: accepted.model.clone().or_else(|| requested.model.clone()),
            effort: accepted.effort.clone().or_else(|| requested.effort.clone()),
            level: accepted.level.map_or(requested.level, level_to_wire),
            routing: accepted.routing.map_or(requested.routing, routing_to_wire),
            workspace_roots: requested.workspace_roots.clone(),
        },
        capabilities: capabilities(snapshot.capabilities.capabilities()),
        account_limits,
    }
}

fn level_to_sdk(level: wire::PermissionLevel) -> sdk::PermissionLevel {
    match level {
        wire::PermissionLevel::ReadOnly => sdk::PermissionLevel::ReadOnly,
        wire::PermissionLevel::Default => sdk::PermissionLevel::Default,
        wire::PermissionLevel::FullAccess => sdk::PermissionLevel::FullAccess,
    }
}

fn level_to_wire(level: sdk::PermissionLevel) -> wire::PermissionLevel {
    match level {
        sdk::PermissionLevel::ReadOnly => wire::PermissionLevel::ReadOnly,
        sdk::PermissionLevel::Default => wire::PermissionLevel::Default,
        sdk::PermissionLevel::FullAccess => wire::PermissionLevel::FullAccess,
    }
}

fn routing_to_sdk(routing: wire::ApprovalRouting) -> sdk::ApprovalRouting {
    match routing {
        wire::ApprovalRouting::User => sdk::ApprovalRouting::User,
        wire::ApprovalRouting::AutoReview => sdk::ApprovalRouting::AutoReview,
    }
}

fn routing_to_wire(routing: sdk::ApprovalRouting) -> wire::ApprovalRouting {
    match routing {
        sdk::ApprovalRouting::User => wire::ApprovalRouting::User,
        sdk::ApprovalRouting::AutoReview => wire::ApprovalRouting::AutoReview,
    }
}

// ---------------------------------------------------------------------------
// Account limits and native sessions
// ---------------------------------------------------------------------------

/// The wire's account limits from the SDK's, stamped `observed_at`.
///
/// Carries what the SDK carries: each window's label, used percentage,
/// duration and reset time, and the plan name. Everything else
/// `codex/rate-limits.ts` produced (per-limit buckets, credits, spend control,
/// reset credits, `reachedType`) has no SDK source and stays absent.
///
/// # Example
///
/// ```ignore
/// let limits = account_limits(TargetId::Codex, &sdk_limits, SystemTime::now());
/// assert_eq!(limits.windows.len(), sdk_limits.windows.len());
/// ```
pub(crate) fn account_limits(
    target: TargetId,
    limits: &sdk::AccountLimits,
    observed_at: SystemTime,
) -> wire::AccountLimits {
    wire::AccountLimits {
        target_id: target,
        windows: limits
            .windows
            .iter()
            .map(|window| wire::RateLimitWindow {
                label: window.label.clone(),
                used_percent: window.used_percent,
                window_duration_mins: window.window_duration_minutes.map(u64::from),
                resets_at_ms: window.resets_at.and_then(epoch_ms),
            })
            .collect(),
        by_limit_id: None,
        credits: None,
        spend_control: None,
        reset_credits: None,
        plan_type: limits.plan_type.clone(),
        reached_type: None,
        observed_at_ms: epoch_ms(observed_at).unwrap_or(0),
    }
}

/// One page of the vendor's own sessions, capped at the wire's fifty rows.
///
/// A page the SDK marked truncated is still a valid page. Rows past the cap
/// are dropped, and the SDK's cursor is forwarded as it came.
///
/// # Example
///
/// ```ignore
/// let result = native_sessions(TargetId::Codex, page);
/// assert!(result.sessions.len() <= 50);
/// ```
pub(crate) fn native_sessions(
    target: TargetId,
    page: sdk::SessionPage,
) -> wire::ListSessionsResult {
    wire::ListSessionsResult {
        sessions: page
            .sessions
            .into_iter()
            .take(NATIVE_SESSION_PAGE_LIMIT)
            .map(|session| wire::NativeSession {
                target_id: target,
                native_session_id: session.native_session_id,
                title: session.title,
                preview: session.preview,
                workspace_path: session.workspace_path,
                updated_at_ms: session.updated_at.and_then(epoch_ms),
            })
            .collect(),
        next_cursor: page.next_cursor,
    }
}

/// Milliseconds since the Unix epoch, or `None` for a time before it.
fn epoch_ms(time: SystemTime) -> Option<u64> {
    let elapsed = time.duration_since(UNIX_EPOCH).ok()?;
    Some(u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX))
}

// ---------------------------------------------------------------------------
// Errors and reasons
// ---------------------------------------------------------------------------

/// The protocol error for an SDK failure.
///
/// Caller mistakes stay `tool_argument` errors, as everywhere else in this
/// crate; vendor, launch and link failures get their own `kind`, a timeout is
/// `TIMEOUT` and a cancellation `CANCELLED`. The message is the SDK's own,
/// which is already bounded and redacted; a vendor's message text, stderr and
/// login credentials are never copied. When an `Operation` wrapper is present
/// its `dispatch` travels as a detail (`not-submitted | accepted |
/// acceptance-unknown`) so the hub can decide whether a replay is safe.
///
/// # Example
///
/// ```ignore
/// let error = remote_error(&sdk::Error::Busy.with_dispatch(sdk::Dispatch::NotSubmitted));
/// assert_eq!(error.details.unwrap()["dispatch"], "not-submitted");
/// ```
pub(crate) fn remote_error(error: &sdk::Error) -> RemoteError {
    let mut remote = cause_error(error.cause());
    if let Some(dispatch) = dispatch_of(error) {
        remote = remote.with_detail("dispatch", dispatch_name(dispatch));
    }
    if cleanup_required(error) {
        remote = remote.with_detail("cleanupRequired", true);
    }
    remote
}

/// The error for the innermost cause, without the wrappers' facts.
fn cause_error(cause: &sdk::Error) -> RemoteError {
    let message = cause.to_string();
    match cause {
        sdk::Error::Busy => {
            external(codes::INTERNAL, message, "external_agent_busy").with_detail("retryable", true)
        }
        sdk::Error::NotSupported { capability } => {
            argument(message).with_detail("capability", capability.to_string())
        }
        sdk::Error::UnsupportedTransport { .. }
        | sdk::Error::HostConfiguration { .. }
        | sdk::Error::LimitExceeded { .. } => argument(message),
        sdk::Error::VersionGate { minimum, .. } => external(
            codes::UNAVAILABLE,
            message,
            "external_agent_version_unsupported",
        )
        .with_detail("requiredVersion", minimum.clone()),
        sdk::Error::AuthRequired { .. } => {
            external(codes::UNAVAILABLE, message, "external_agent_signed_out")
        }
        sdk::Error::Launch { .. } => {
            external(codes::UNAVAILABLE, message, "external_agent_launch_failed")
        }
        sdk::Error::Link { .. } => {
            external(codes::UNAVAILABLE, message, "external_agent_link_lost")
        }
        sdk::Error::Closed { .. } => external(codes::UNAVAILABLE, message, "external_agent_closed"),
        sdk::Error::Protocol { .. } | sdk::Error::InvalidVendorValue { .. } => {
            external(codes::INTERNAL, message, "external_agent_protocol")
        }
        sdk::Error::Vendor(vendor) => external(codes::INTERNAL, message, "external_agent_vendor")
            .with_detail("vendorCode", vendor.code.to_string())
            .with_detail("retryable", vendor.retryable),
        sdk::Error::Timeout { after, .. } => RemoteError::new(codes::TIMEOUT, message).with_detail(
            "timeoutMs",
            u64::try_from(after.as_millis()).unwrap_or(u64::MAX),
        ),
        sdk::Error::Cancelled { reason } => RemoteError::new(codes::CANCELLED, message)
            .with_detail("reason", cancel_reason_name(*reason)),
        _ => external(codes::INTERNAL, message, "external_agent_failure"),
    }
}

fn argument(message: String) -> RemoteError {
    RemoteError::new(codes::INTERNAL, message).with_detail("kind", "tool_argument")
}

fn external(code: &str, message: String, kind: &str) -> RemoteError {
    RemoteError::new(code, message).with_detail("kind", kind)
}

/// The outermost `Operation` wrapper's dispatch, when there is one. The SDK's
/// own `Error::dispatch` defaults to `AcceptanceUnknown`, which would state a
/// fact nobody observed.
fn dispatch_of(error: &sdk::Error) -> Option<sdk::Dispatch> {
    match error {
        sdk::Error::Operation { dispatch, .. } => Some(*dispatch),
        sdk::Error::CleanupRequired { source, .. } => dispatch_of(source),
        _ => None,
    }
}

fn cleanup_required(error: &sdk::Error) -> bool {
    match error {
        sdk::Error::CleanupRequired { .. } => true,
        sdk::Error::Operation { source, .. } => cleanup_required(source),
        _ => false,
    }
}

fn dispatch_name(dispatch: sdk::Dispatch) -> &'static str {
    match dispatch {
        sdk::Dispatch::NotSubmitted => "not-submitted",
        sdk::Dispatch::Accepted => "accepted",
        _ => "acceptance-unknown",
    }
}

fn cancel_reason_name(reason: sdk::CancelReason) -> &'static str {
    match reason {
        sdk::CancelReason::Requested => "requested",
        sdk::CancelReason::ConsentRevoked => "consent-revoked",
        sdk::CancelReason::Timeout => "timeout",
        _ => "shutdown",
    }
}

#[cfg(test)]
#[path = "map_tests.rs"]
mod tests;
