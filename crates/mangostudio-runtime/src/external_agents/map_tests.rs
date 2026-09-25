//! Tests for the SDK → wire mapping.
//!
//! Every `Discovery` fixture mirrors the facts one TypeScript adapter test fed
//! its adapter, and builds its permission matrix with the SDK harness's own
//! public builder, so the key table is checked against real SDK verdicts.

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use mango_agent_claude::auth::AccountKind;
use mango_agent_claude::permissions::ModeAvailability;
use mango_external_agents as sdk;
use mango_external_agents::Harness as _;
use mango_protocol::error::codes;
use serde_json::{Value, json};

use super::*;
use crate::result_check::{cached_result_validator, check_result};

// ---------------------------------------------------------------------------
// Named fixtures
// ---------------------------------------------------------------------------

const PROBED_AT_MS: u64 = 1_790_000_000_000;

fn claude_availability(account: Option<AccountKind>) -> ModeAvailability {
    ModeAvailability {
        account_kind: account,
        auto_mode_disabled_by_policy: false,
        accepted_modes: None,
    }
}

/// `survey.capabilities(true)` for a build that advertises its aliases.
fn claude_capabilities() -> sdk::DiscoveredCapabilities {
    sdk::DiscoveredCapabilities::new(sdk::Capabilities {
        structured_streaming: true,
        reasoning_stream: true,
        resume: true,
        cancellation: true,
        usage_reporting: true,
        model_catalog: true,
        ..sdk::Capabilities::none()
    })
}

fn claude_models() -> Vec<sdk::Model> {
    ["fable", "opus", "sonnet"]
        .into_iter()
        .map(|id| sdk::Model {
            reasoning_efforts: vec![sdk::ReasoningEffort {
                id: String::from("low"),
                ..sdk::ReasoningEffort::default()
            }],
            ..sdk::Model::new(id)
        })
        .collect()
}

/// `claude-adapter-lifecycle`: a signed-in subscription on a current build.
fn claude_subscription(availability: ModeAvailability) -> sdk::Discovery {
    sdk::Discovery {
        executable: Some(PathBuf::from("/usr/local/bin/claude")),
        version: Some(String::from("2.1.211 (Claude Code)")),
        gate: sdk::GateVerdict::Usable,
        auth: sdk::AuthState::LoggedIn {
            mode: sdk::AuthMode::Subscription,
        },
        capabilities: claude_capabilities(),
        permission_matrix: mango_agent_claude::permissions::matrix(&availability),
        models: claude_models(),
        configuration_catalog: sdk::ConfigurationCatalog::empty(),
    }
}

fn claude_signed_in_subscription() -> sdk::Discovery {
    claude_subscription(claude_availability(Some(AccountKind::Subscription)))
}

/// `claude-adapter-lifecycle`: "names the version to upgrade to when a flag
/// every turn passes is gone".
fn claude_missing_surface() -> sdk::Discovery {
    sdk::Discovery {
        gate: sdk::GateVerdict::MissingRequiredSurface {
            expected: "the launch flags every turn passes",
            received: "a help text without one of them",
        },
        auth: sdk::AuthState::Unknown,
        capabilities: sdk::DiscoveredCapabilities::none(),
        models: Vec::new(),
        ..claude_signed_in_subscription()
    }
}

/// `codex-adapter`: "reports the version, a minimal account label and the full
/// 2 x 3 matrix".
fn codex_signed_in() -> sdk::Discovery {
    sdk::Discovery {
        executable: Some(PathBuf::from("/usr/local/bin/codex")),
        version: Some(String::from("codex-cli 0.147.0")),
        gate: sdk::GateVerdict::Usable,
        auth: sdk::AuthState::LoggedIn {
            mode: sdk::AuthMode::Subscription,
        },
        capabilities: sdk::DiscoveredCapabilities::new(
            *CodexHarness::new().descriptor().capabilities.capabilities(),
        ),
        permission_matrix: mango_agent_codex::permissions::matrix(),
        models: vec![sdk::Model {
            is_default: true,
            display_name: Some(String::from("GPT-5.6 Sol")),
            ..sdk::Model::new("gpt-5.6-sol")
        }],
        configuration_catalog: sdk::ConfigurationCatalog::empty(),
    }
}

/// `codex-adapter`: "offers nothing selectable for a Codex too old to open a
/// session". The SDK keeps the declared matrix on a refused build.
fn codex_too_old() -> sdk::Discovery {
    sdk::Discovery {
        version: Some(String::from("codex-cli 0.140.0")),
        gate: sdk::GateVerdict::VersionTooOld {
            found: String::from("codex-cli 0.140.0"),
            minimum: String::from(mango_agent_codex::MINIMUM_CODEX_VERSION),
        },
        auth: sdk::AuthState::Unknown,
        capabilities: sdk::DiscoveredCapabilities::none(),
        models: Vec::new(),
        ..codex_signed_in()
    }
}

/// `cursor-adapter`: a current build. ACP discovery reads no auth surface and
/// reports the harness ceiling, so auth is unknown.
fn cursor_current() -> sdk::Discovery {
    let harness = AcpHarness::builtin("cursor").expect("the cursor profile");
    sdk::Discovery {
        executable: Some(PathBuf::from("/usr/local/bin/cursor-agent")),
        version: Some(String::from("2026.08.04-aaa8809")),
        gate: sdk::GateVerdict::Usable,
        auth: sdk::AuthState::Unknown,
        capabilities: sdk::DiscoveredCapabilities::new(
            *harness.descriptor().capabilities.capabilities(),
        ),
        permission_matrix: mango_agent_acp::profile::matrix(&harness.profile().modes),
        models: Vec::new(),
        configuration_catalog: sdk::ConfigurationCatalog::empty(),
    }
}

/// `cursor-adapter`: "names the version to upgrade to when an older build
/// fails its handshake".
fn cursor_too_old() -> sdk::Discovery {
    sdk::Discovery {
        version: Some(String::from("2026.07.16-899851b")),
        gate: sdk::GateVerdict::VersionTooOld {
            found: String::from("2026.07.16-899851b"),
            minimum: String::from("2026.08.04"),
        },
        ..cursor_current()
    }
}

/// `cursor-adapter`: "does not blame the version when a current build fails
/// its handshake".
fn cursor_missing_surface() -> sdk::Discovery {
    sdk::Discovery {
        gate: sdk::GateVerdict::MissingRequiredSurface {
            expected: "an ACP handshake",
            received: "none",
        },
        ..cursor_current()
    }
}

fn describe(target: TargetId, discovery: &sdk::Discovery) -> Value {
    serde_json::to_value(descriptor(target, discovery, PROBED_AT_MS)).expect("serializable")
}

fn live() -> Value {
    json!({ "source": "live", "probedAtMs": PROBED_AT_MS, "attempts": 1 })
}

fn cell(level: &str, routing: &str, supported: bool, unattended: bool) -> Value {
    json!({ "level": level, "routing": routing, "supported": supported, "unattended": unattended })
}

fn with(mut value: Value, extra: Value) -> Value {
    let (Value::Object(target), Value::Object(extra)) = (&mut value, extra) else {
        panic!("expected two objects");
    };
    target.extend(extra);
    value
}

fn no_capabilities() -> Value {
    serde_json::to_value(wire::Capabilities::default()).expect("serializable")
}

// ---------------------------------------------------------------------------
// Harnesses
// ---------------------------------------------------------------------------

#[test]
fn each_target_gets_its_own_harness_id_and_profile() {
    let pinned = [
        (TargetId::Claude, "claude", None),
        (TargetId::Codex, "codex", None),
        (TargetId::Cursor, "acp:cursor", Some("cursor")),
    ];
    for (target, id, profile) in pinned {
        let harness = harness_for(target, None);
        let received = harness.descriptor().id();
        assert_eq!(
            received.as_str(),
            id,
            "expected {target:?} to register as {id} | received {received}"
        );
        assert_eq!(
            harness_id(target),
            *received,
            "expected harness_id({target:?}) to match"
        );
        assert_eq!(
            received
                .acp_profile()
                .map(|profile| profile.to_string())
                .as_deref(),
            profile,
            "expected {target:?}'s ACP profile to be {profile:?}"
        );
    }
}

#[test]
fn the_registry_exposes_exactly_the_three_product_targets() {
    let registry = product_harnesses().expect("three distinct ids");
    let ids: Vec<String> = registry
        .ids()
        .into_iter()
        .map(ToString::to_string)
        .collect();
    assert_eq!(
        ids,
        ["acp:cursor", "claude", "codex"],
        "expected only product targets"
    );
    for unreachable in ["acp:grok", "acp:opencode", "acp:gemini", "acp:codex", "acp"] {
        let id = sdk::HarnessId::new(unreachable).expect("a valid id");
        assert!(
            registry.get(&id).is_none(),
            "expected {unreachable} to be unreachable | received a registered harness"
        );
    }
}

#[test]
fn cursor_launches_cursor_agent_not_the_shared_agent_alias() {
    let harness = AcpHarness::builtin("cursor").expect("the cursor profile");
    let default = sdk::ExecutablePath::default();
    let argv = harness.profile().resolved_argv(&default);
    let version = harness.profile().resolved_version_argv(&default);
    assert_eq!(
        argv,
        ["cursor-agent", "acp"],
        "expected cursor-agent in ACP mode"
    );
    assert_eq!(version.first().map(String::as_str), Some("cursor-agent"));
    assert_eq!(
        harness.profile().login_hint.as_deref(),
        Some(CURSOR_LOGIN_COMMAND),
        "expected the product's login constant to be the profile's own hint"
    );
}

#[test]
fn a_resolved_executable_replaces_the_program_name() {
    let path = PathBuf::from("/opt/tools/cursor-agent");
    let harness = AcpHarness::builtin("cursor")
        .expect("the cursor profile")
        .with_executable(sdk::ExecutablePath::resolved(path.clone()));
    let argv = harness
        .profile()
        .resolved_argv(&sdk::ExecutablePath::resolved(path));
    assert_eq!(argv, ["/opt/tools/cursor-agent", "acp"]);
    // Each target accepts a path without changing which harness it is.
    for target in TargetId::ALL {
        let with_path = harness_for(target, Some(PathBuf::from("/opt/bin/agent")));
        assert_eq!(with_path.descriptor().id(), &harness_id(target));
    }
}

// ---------------------------------------------------------------------------
// Descriptors, per vendor
// ---------------------------------------------------------------------------

#[test]
fn claude_signed_in_subscription_descriptor() {
    let received = describe(TargetId::Claude, &claude_signed_in_subscription());
    let models: Vec<Value> = ["fable", "opus", "sonnet"]
        .into_iter()
        .map(|id| json!({ "id": id, "supportedReasoningEfforts": [{ "id": "low" }] }))
        .collect();
    let expected = json!({
        "targetId": "claude",
        "installed": true,
        "version": "2.1.211 (Claude Code)",
        "authState": "signed-in",
        "capabilities": {
            "structuredStreaming": true, "reasoningStream": true, "interactiveApprovals": false,
            "resume": true, "modelCatalog": true, "images": false, "usageReporting": true,
            "cancellation": true, "steering": false, "sessionListing": false,
            "nativeReview": false, "accountUsage": false
        },
        "supportedConfigurations": [
            with(cell("read-only", "user", true, false), json!({ "vendorId": "plan" })),
            with(cell("read-only", "auto-review", false, true), json!({
                "unsupportedReasonKey": "externalAgents.unsupported.claudeReadOnlyHasNoReviewer"
            })),
            with(cell("default", "user", true, false), json!({ "vendorId": "default" })),
            with(cell("default", "auto-review", true, true), json!({ "vendorId": "auto" })),
            with(cell("full-access", "user", true, true), json!({ "vendorId": "bypassPermissions" })),
            with(cell("full-access", "auto-review", false, true), json!({
                "unsupportedReasonKey": "externalAgents.unsupported.claudeFullAccessHasNoReviewer"
            })),
        ],
        "models": models,
        "account": { "label": "Claude account" },
        "discovery": live(),
    });
    assert_eq!(received, expected, "claude subscription descriptor drifted");
}

#[test]
fn claude_refuses_auto_with_the_reason_the_account_gives() {
    let cases = [
        (
            claude_availability(Some(AccountKind::ApiKey)),
            "externalAgents.unsupported.claudeAutoNeedsSubscription",
        ),
        (
            claude_availability(Some(AccountKind::CloudProvider)),
            "externalAgents.unsupported.claudeAutoNeedsSubscription",
        ),
        (
            ModeAvailability {
                auto_mode_disabled_by_policy: true,
                ..claude_availability(Some(AccountKind::Subscription))
            },
            "externalAgents.unsupported.claudeAutoDisabledByPolicy",
        ),
        (
            claude_availability(None),
            "externalAgents.unsupported.claudeAutoUnverified",
        ),
    ];
    for (availability, key) in cases {
        let received = describe(TargetId::Claude, &claude_subscription(availability));
        let auto = &received["supportedConfigurations"][3];
        assert_eq!(
            auto,
            &with(
                cell("default", "auto-review", false, true),
                json!({
                    "unsupportedReasonKey": key, "vendorId": "auto"
                })
            ),
            "expected default/auto-review refused with {key}"
        );
    }
}

#[test]
fn claude_refuses_a_mode_the_build_does_not_list() {
    let availability = ModeAvailability {
        accepted_modes: Some(BTreeSet::from([
            String::from("plan"),
            String::from("bypassPermissions"),
        ])),
        ..claude_availability(Some(AccountKind::Subscription))
    };
    let received = describe(TargetId::Claude, &claude_subscription(availability));
    let cells = &received["supportedConfigurations"];
    assert_eq!(
        cells[2],
        with(
            cell("default", "user", false, false),
            json!({
                "unsupportedReasonKey": "externalAgents.unsupported.claudeModeMissing",
                "vendorId": "default"
            })
        )
    );
    assert_eq!(cells[0]["supported"], true, "expected read-only/user kept");
    assert_eq!(
        cells[4]["supported"], true,
        "expected full-access/user kept"
    );
    assert!(
        received.get("unavailableReason").is_none(),
        "expected the target kept"
    );
}

#[test]
fn claude_missing_surface_names_the_version_to_upgrade_to() {
    let received = describe(TargetId::Claude, &claude_missing_surface());
    let key = json!({ "unsupportedReasonKey": "externalAgents.unsupported.claudeVersionTooOld" });
    let expected = json!({
        "targetId": "claude",
        "installed": true,
        "version": "2.1.211 (Claude Code)",
        "requiredVersion": "2.1.211",
        "authState": "unknown",
        "capabilities": no_capabilities(),
        "supportedConfigurations": [
            with(cell("read-only", "user", false, false), key.clone()),
            with(cell("read-only", "auto-review", false, true), key.clone()),
            with(cell("default", "user", false, false), key.clone()),
            with(cell("default", "auto-review", false, true), key.clone()),
            with(cell("full-access", "user", false, true), key.clone()),
            with(cell("full-access", "auto-review", false, true), key),
        ],
        "unavailableReason": "version-unsupported",
        "remedy": { "kind": "update" },
        "discovery": live(),
    });
    assert_eq!(
        received, expected,
        "claude refused-build descriptor drifted"
    );
}

#[test]
fn claude_signed_out_offers_the_vendor_hint_and_sign_in() {
    let discovery = sdk::Discovery {
        auth: sdk::AuthState::LoggedOut {
            login_hint: String::from("claude auth login"),
        },
        ..claude_signed_in_subscription()
    };
    let received = describe(TargetId::Claude, &discovery);
    assert_eq!(received["authState"], "signed-out");
    assert_eq!(received["loginCommand"], "claude auth login");
    assert_eq!(received["unavailableReason"], "signed-out");
    assert_eq!(
        received["remedy"],
        json!({ "kind": "sign-in", "command": "claude auth login" })
    );
    assert!(
        received.get("account").is_none(),
        "expected no account when signed out"
    );
}

#[test]
fn an_unknown_auth_state_still_offers_the_login_command() {
    let discovery = sdk::Discovery {
        auth: sdk::AuthState::Unknown,
        ..claude_signed_in_subscription()
    };
    let received = describe(TargetId::Claude, &discovery);
    assert_eq!(received["authState"], "unknown");
    assert_eq!(received["loginCommand"], "claude auth login");
    assert!(
        received.get("remedy").is_none(),
        "expected no remedy for an unknown state"
    );
}

#[test]
fn codex_signed_in_descriptor() {
    let received = describe(TargetId::Codex, &codex_signed_in());
    let vendor = |level: &str, routing: &str| {
        let sdk_level = match level {
            "read-only" => sdk::PermissionLevel::ReadOnly,
            "default" => sdk::PermissionLevel::Default,
            _ => sdk::PermissionLevel::FullAccess,
        };
        let sdk_routing = if routing == "user" {
            sdk::ApprovalRouting::User
        } else {
            sdk::ApprovalRouting::AutoReview
        };
        let unattended = level == "full-access" || routing == "auto-review";
        with(
            cell(level, routing, true, unattended),
            json!({
                "vendorId": mango_agent_codex::permissions::VendorConfiguration::for_pair(
                    sdk_level, sdk_routing,
                ).vendor_id()
            }),
        )
    };
    let expected = json!({
        "targetId": "codex",
        "installed": true,
        "version": "codex-cli 0.147.0",
        "authState": "signed-in",
        "capabilities": {
            "structuredStreaming": true, "reasoningStream": true, "interactiveApprovals": true,
            "resume": true, "modelCatalog": true, "images": true, "usageReporting": true,
            "cancellation": true, "steering": true, "sessionListing": true,
            "nativeReview": true, "accountUsage": true
        },
        "supportedConfigurations": [
            vendor("read-only", "user"), vendor("read-only", "auto-review"),
            vendor("default", "user"), vendor("default", "auto-review"),
            vendor("full-access", "user"), vendor("full-access", "auto-review"),
        ],
        "models": [{ "id": "gpt-5.6-sol", "displayName": "GPT-5.6 Sol", "isDefault": true }],
        "account": { "label": "ChatGPT" },
        "discovery": live(),
    });
    assert_eq!(received, expected, "codex signed-in descriptor drifted");
    assert_eq!(
        received["supportedConfigurations"][2]["vendorId"], "workspace-write/on-request/user",
        "expected the SDK's own vendor id for default/user"
    );
}

#[test]
fn codex_account_labels_never_carry_an_identity() {
    let cases = [
        (sdk::AuthMode::Subscription, "ChatGPT"),
        (sdk::AuthMode::ApiKey, "API key"),
        (
            sdk::AuthMode::Other(String::from("amazon-bedrock")),
            "Amazon Bedrock",
        ),
        (
            sdk::AuthMode::Other(String::from("someone@example.com")),
            "Signed in",
        ),
    ];
    for (mode, label) in cases {
        let discovery = sdk::Discovery {
            auth: sdk::AuthState::LoggedIn { mode },
            ..codex_signed_in()
        };
        let received = describe(TargetId::Codex, &discovery);
        assert_eq!(received["account"], json!({ "label": label }));
        assert!(
            !received.to_string().contains("someone@example.com"),
            "expected no raw identity on the wire"
        );
    }
}

#[test]
fn codex_too_old_offers_nothing_selectable() {
    let received = describe(TargetId::Codex, &codex_too_old());
    let refused = |level: &str, routing: &str, vendor: &str| {
        let unattended = level == "full-access" || routing == "auto-review";
        with(
            cell(level, routing, false, unattended),
            json!({
                "unsupportedReasonKey": "externalAgents.unsupported.codexVersionTooOld",
                "vendorId": vendor,
            }),
        )
    };
    let expected = json!({
        "targetId": "codex",
        "installed": true,
        "version": "codex-cli 0.140.0",
        "requiredVersion": mango_agent_codex::MINIMUM_CODEX_VERSION,
        "authState": "unknown",
        "capabilities": no_capabilities(),
        "supportedConfigurations": [
            refused("read-only", "user", "read-only/never/user"),
            refused("read-only", "auto-review", "read-only/never/auto_review"),
            refused("default", "user", "workspace-write/on-request/user"),
            refused("default", "auto-review", "workspace-write/on-request/auto_review"),
            refused("full-access", "user", "danger-full-access/never/user"),
            refused("full-access", "auto-review", "danger-full-access/never/auto_review"),
        ],
        "unavailableReason": "version-unsupported",
        "remedy": { "kind": "update" },
        "discovery": live(),
    });
    assert_eq!(received, expected, "codex refused-build descriptor drifted");
}

#[test]
fn not_installed_matches_each_typescript_adapter() {
    for (target, login) in [
        (TargetId::Claude, "claude auth login"),
        (TargetId::Codex, "codex login"),
        (TargetId::Cursor, "cursor-agent login"),
    ] {
        let received = describe(target, &sdk::Discovery::not_installed());
        let expected = json!({
            "targetId": target.as_str(),
            "installed": false,
            "authState": "unknown",
            "loginCommand": login,
            "capabilities": no_capabilities(),
            "supportedConfigurations": [],
            "unavailableReason": "not-installed",
            "remedy": { "kind": "install" },
            "discovery": live(),
        });
        assert_eq!(
            received, expected,
            "{target:?} not-installed descriptor drifted"
        );
    }
}

#[test]
fn cursor_current_descriptor_refuses_auto_review_and_full_access() {
    let received = describe(TargetId::Cursor, &cursor_current());
    let no_auto =
        json!({ "unsupportedReasonKey": "externalAgents.unsupported.cursorNoAutoReview" });
    let expected = json!({
        "targetId": "cursor",
        "installed": true,
        "version": "2026.08.04-aaa8809",
        "authState": "unknown",
        "loginCommand": "cursor-agent login",
        "capabilities": {
            "structuredStreaming": true, "reasoningStream": true, "interactiveApprovals": true,
            "resume": true, "modelCatalog": false, "images": true, "usageReporting": true,
            "cancellation": true, "steering": false, "sessionListing": true,
            "nativeReview": false, "accountUsage": false
        },
        "supportedConfigurations": [
            cell("read-only", "user", true, false),
            with(cell("read-only", "auto-review", false, true), no_auto.clone()),
            cell("default", "user", true, false),
            with(cell("default", "auto-review", false, true), no_auto.clone()),
            with(cell("full-access", "user", false, true), json!({
                "unsupportedReasonKey": "externalAgents.unsupported.cursorNoFullAccess"
            })),
            with(cell("full-access", "auto-review", false, true), no_auto),
        ],
        "discovery": live(),
    });
    assert_eq!(received, expected, "cursor current descriptor drifted");
}

#[test]
fn cursor_too_old_names_the_version_and_keeps_its_login_command() {
    let received = describe(TargetId::Cursor, &cursor_too_old());
    assert_eq!(received["unavailableReason"], "version-unsupported");
    assert_eq!(received["requiredVersion"], "2026.08.04");
    assert_eq!(received["loginCommand"], "cursor-agent login");
    assert_eq!(received["capabilities"], no_capabilities());
    for entry in received["supportedConfigurations"]
        .as_array()
        .expect("cells")
    {
        assert_eq!(
            entry["unsupportedReasonKey"], "externalAgents.unsupported.cursorVersionTooOld",
            "expected every cell refused for the version | received {entry}"
        );
    }
}

#[test]
fn cursor_missing_surface_does_not_blame_the_version() {
    let received = describe(TargetId::Cursor, &cursor_missing_surface());
    assert!(
        received.get("unavailableReason").is_none(),
        "expected no version claim"
    );
    assert!(
        received.get("requiredVersion").is_none(),
        "expected no floor named"
    );
    assert!(
        received.get("remedy").is_none(),
        "expected no update remedy"
    );
    for entry in received["supportedConfigurations"]
        .as_array()
        .expect("cells")
    {
        assert_eq!(entry["supported"], false);
        assert_eq!(
            entry["unsupportedReasonKey"], "externalAgents.unsupported.cursorAcpUnavailable",
            "expected every cell refused for the handshake | received {entry}"
        );
    }
}

// ---------------------------------------------------------------------------
// The key table
// ---------------------------------------------------------------------------

fn reasons() -> [sdk::UnsupportedReason; 5] {
    [
        sdk::UnsupportedReason::NotOfferedByVendor,
        sdk::UnsupportedReason::RequiresAccountUpgrade,
        sdk::UnsupportedReason::RequiresNewerVersion,
        sdk::UnsupportedReason::UnattendedNotPermitted,
        sdk::UnsupportedReason::Other(String::from("anything")),
    ]
}

fn reason_name(reason: &sdk::UnsupportedReason) -> &'static str {
    match reason {
        sdk::UnsupportedReason::NotOfferedByVendor => "not-offered",
        sdk::UnsupportedReason::RequiresAccountUpgrade => "account-upgrade",
        sdk::UnsupportedReason::RequiresNewerVersion => "newer-version",
        sdk::UnsupportedReason::UnattendedNotPermitted => "unattended",
        _ => "other",
    }
}

/// Every cell of the table that carries a key. Everything else carries none.
const KEY_TABLE: &[(&str, &str, &str, &str, &str)] = &[
    (
        "claude",
        "read-only",
        "user",
        "newer-version",
        "claudeModeMissing",
    ),
    (
        "claude",
        "read-only",
        "auto-review",
        "not-offered",
        "claudeReadOnlyHasNoReviewer",
    ),
    (
        "claude",
        "read-only",
        "auto-review",
        "newer-version",
        "claudeModeMissing",
    ),
    (
        "claude",
        "default",
        "user",
        "newer-version",
        "claudeModeMissing",
    ),
    (
        "claude",
        "default",
        "auto-review",
        "not-offered",
        "claudeAutoUnverified",
    ),
    (
        "claude",
        "default",
        "auto-review",
        "account-upgrade",
        "claudeAutoNeedsSubscription",
    ),
    (
        "claude",
        "default",
        "auto-review",
        "newer-version",
        "claudeModeMissing",
    ),
    (
        "claude",
        "default",
        "auto-review",
        "unattended",
        "claudeAutoDisabledByPolicy",
    ),
    (
        "claude",
        "default",
        "auto-review",
        "other",
        "claudeAutoUnverified",
    ),
    (
        "claude",
        "full-access",
        "user",
        "newer-version",
        "claudeModeMissing",
    ),
    (
        "claude",
        "full-access",
        "auto-review",
        "not-offered",
        "claudeFullAccessHasNoReviewer",
    ),
    (
        "claude",
        "full-access",
        "auto-review",
        "newer-version",
        "claudeModeMissing",
    ),
    (
        "cursor",
        "read-only",
        "auto-review",
        "not-offered",
        "cursorNoAutoReview",
    ),
    (
        "cursor",
        "read-only",
        "auto-review",
        "account-upgrade",
        "cursorNoAutoReview",
    ),
    (
        "cursor",
        "read-only",
        "auto-review",
        "newer-version",
        "cursorNoAutoReview",
    ),
    (
        "cursor",
        "read-only",
        "auto-review",
        "unattended",
        "cursorNoAutoReview",
    ),
    (
        "cursor",
        "read-only",
        "auto-review",
        "other",
        "cursorNoAutoReview",
    ),
    (
        "cursor",
        "default",
        "auto-review",
        "not-offered",
        "cursorNoAutoReview",
    ),
    (
        "cursor",
        "default",
        "auto-review",
        "account-upgrade",
        "cursorNoAutoReview",
    ),
    (
        "cursor",
        "default",
        "auto-review",
        "newer-version",
        "cursorNoAutoReview",
    ),
    (
        "cursor",
        "default",
        "auto-review",
        "unattended",
        "cursorNoAutoReview",
    ),
    (
        "cursor",
        "default",
        "auto-review",
        "other",
        "cursorNoAutoReview",
    ),
    (
        "cursor",
        "full-access",
        "user",
        "not-offered",
        "cursorNoFullAccess",
    ),
    (
        "cursor",
        "full-access",
        "auto-review",
        "not-offered",
        "cursorNoAutoReview",
    ),
    (
        "cursor",
        "full-access",
        "auto-review",
        "account-upgrade",
        "cursorNoAutoReview",
    ),
    (
        "cursor",
        "full-access",
        "auto-review",
        "newer-version",
        "cursorNoAutoReview",
    ),
    (
        "cursor",
        "full-access",
        "auto-review",
        "unattended",
        "cursorNoAutoReview",
    ),
    (
        "cursor",
        "full-access",
        "auto-review",
        "other",
        "cursorNoAutoReview",
    ),
];

fn wire_level(level: sdk::PermissionLevel) -> &'static str {
    match level {
        sdk::PermissionLevel::ReadOnly => "read-only",
        sdk::PermissionLevel::Default => "default",
        sdk::PermissionLevel::FullAccess => "full-access",
    }
}

fn wire_routing(routing: sdk::ApprovalRouting) -> &'static str {
    match routing {
        sdk::ApprovalRouting::User => "user",
        sdk::ApprovalRouting::AutoReview => "auto-review",
    }
}

#[test]
fn the_permission_key_table_is_pinned_cell_by_cell() {
    let mut mismatches = Vec::new();
    for target in TargetId::ALL {
        for level in sdk::PermissionLevel::ALL {
            for routing in sdk::ApprovalRouting::ALL {
                for reason in reasons() {
                    let facts = (
                        target.as_str(),
                        wire_level(level),
                        wire_routing(routing),
                        reason_name(&reason),
                    );
                    let expected = KEY_TABLE
                        .iter()
                        .find(|row| (row.0, row.1, row.2, row.3) == facts)
                        .map(|row| format!("externalAgents.unsupported.{}", row.4));
                    let received =
                        unsupported_reason_key(target, level, routing, &reason).map(str::to_owned);
                    if expected != received {
                        mismatches.push(format!(
                            "{facts:?}: expected {expected:?} | received {received:?}"
                        ));
                    }
                }
            }
        }
    }
    assert!(
        mismatches.is_empty(),
        "key table drifted:\n{}",
        mismatches.join("\n")
    );
}

#[test]
fn every_key_in_the_table_is_one_the_frontend_ships() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../apps/shared/src/i18n/en.ts"
    );
    let catalog = std::fs::read_to_string(path).unwrap_or_else(|error| {
        panic!("expected the English catalog at {path} | received {error}")
    });
    let gate_keys = [
        keys::CLAUDE_VERSION_TOO_OLD,
        keys::CODEX_VERSION_TOO_OLD,
        keys::CURSOR_VERSION_TOO_OLD,
        keys::CURSOR_ACP_UNAVAILABLE,
    ];
    let leaves = KEY_TABLE.iter().map(|row| row.4).chain(
        gate_keys
            .iter()
            .map(|key| key.trim_start_matches("externalAgents.unsupported.")),
    );
    for leaf in leaves {
        assert!(
            catalog.contains(&format!("      {leaf}:")),
            "expected i18n key externalAgents.unsupported.{leaf} in {path}"
        );
    }
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

type Flip = fn(&mut sdk::Capabilities);

const WIRE_FLAGS: [(&str, Flip); 12] = [
    ("structuredStreaming", |c| c.structured_streaming = true),
    ("reasoningStream", |c| c.reasoning_stream = true),
    ("interactiveApprovals", |c| c.interactive_approvals = true),
    ("resume", |c| c.resume = true),
    ("modelCatalog", |c| c.model_catalog = true),
    ("images", |c| c.images = true),
    ("usageReporting", |c| c.usage_reporting = true),
    ("cancellation", |c| c.cancellation = true),
    ("steering", |c| c.steering = true),
    ("sessionListing", |c| c.session_listing = true),
    ("nativeReview", |c| c.native_review = true),
    ("accountUsage", |c| c.account_usage = true),
];

const SDK_ONLY_FLAGS: [(&str, Flip); 5] = [
    ("questions", |c| c.questions = true),
    ("configurationCatalog", |c| c.configuration_catalog = true),
    ("sessionConfiguration", |c| c.session_configuration = true),
    ("mcpPassthrough", |c| c.mcp_passthrough = true),
    ("configuration", |c| c.configuration = true),
];

fn true_flags(flags: wire::Capabilities) -> Vec<String> {
    let Value::Object(map) = serde_json::to_value(flags).expect("serializable") else {
        panic!("expected an object");
    };
    map.into_iter()
        .filter(|(_, value)| value == &Value::Bool(true))
        .map(|(key, _)| key)
        .collect()
}

#[test]
fn each_wire_flag_comes_from_its_own_sdk_field() {
    assert_eq!(
        true_flags(capabilities(&sdk::Capabilities::none())),
        Vec::<String>::new(),
        "expected nothing set from an empty table"
    );
    for (flag, flip) in WIRE_FLAGS {
        let mut table = sdk::Capabilities::none();
        flip(&mut table);
        assert_eq!(
            true_flags(capabilities(&table)),
            [flag],
            "expected only {flag} set after flipping its SDK field"
        );
    }
    for (field, flip) in SDK_ONLY_FLAGS {
        let mut table = sdk::Capabilities::none();
        flip(&mut table);
        assert_eq!(
            true_flags(capabilities(&table)),
            Vec::<String>::new(),
            "expected SDK-only field {field} to set no wire flag"
        );
    }
    assert_eq!(
        true_flags(capabilities(&sdk::Capabilities::all())).len(),
        12
    );
}

// ---------------------------------------------------------------------------
// Configuration and open
// ---------------------------------------------------------------------------

fn requested(model: Option<&str>, effort: Option<&str>) -> wire::Configuration {
    wire::Configuration {
        model: model.map(str::to_owned),
        effort: effort.map(str::to_owned),
        level: wire::PermissionLevel::Default,
        routing: wire::ApprovalRouting::AutoReview,
        workspace_roots: vec![String::from("/workspace")],
    }
}

#[test]
fn an_absent_model_or_effort_keeps_rather_than_clears() {
    let patch = configuration_patch(&requested(None, None));
    assert!(
        patch.model.is_keep(),
        "expected model Keep | received {:?}",
        patch.model
    );
    assert!(
        patch.effort.is_keep(),
        "expected effort Keep | received {:?}",
        patch.effort
    );
    assert!(!patch.asks_for_a_reset(), "expected no axis reset");
    assert_eq!(
        patch.level.set_value(),
        Some(&sdk::PermissionLevel::Default)
    );
    assert_eq!(
        patch.routing.set_value(),
        Some(&sdk::ApprovalRouting::AutoReview)
    );
}

#[test]
fn a_present_model_or_effort_is_set() {
    let patch = configuration_patch(&requested(Some("opus"), Some("high")));
    assert_eq!(patch.model.set_value().map(String::as_str), Some("opus"));
    assert_eq!(patch.effort.set_value().map(String::as_str), Some("high"));
    for (wire_level, sdk_level) in [
        (
            wire::PermissionLevel::ReadOnly,
            sdk::PermissionLevel::ReadOnly,
        ),
        (
            wire::PermissionLevel::FullAccess,
            sdk::PermissionLevel::FullAccess,
        ),
    ] {
        let patch = configuration_patch(&wire::Configuration {
            level: wire_level,
            routing: wire::ApprovalRouting::User,
            ..requested(None, None)
        });
        assert_eq!(patch.level.set_value(), Some(&sdk_level));
        assert_eq!(patch.routing.set_value(), Some(&sdk::ApprovalRouting::User));
    }
}

fn snapshot(accepted: sdk::Configuration) -> sdk::SessionSnapshot {
    sdk::SessionSnapshot::opening(
        sdk::SessionIds {
            session_id: sdk::SessionId::new("chat-1"),
            native_session_id: String::from("native-1"),
        },
        harness_for(TargetId::Codex, None)
            .descriptor()
            .identity
            .clone(),
        sdk::TransportSelection::new(None, sdk::TransportKind::Stdio),
        UNIX_EPOCH,
    )
    .with_capabilities(sdk::SessionCapabilities::new(sdk::Capabilities {
        resume: true,
        steering: true,
        ..sdk::Capabilities::none()
    }))
    .with_configuration(sdk::ConfigurationState::unknown().with_accepted(accepted))
}

#[test]
fn open_result_prefers_what_the_harness_accepted_per_axis() {
    let accepted = sdk::Configuration::unknown()
        .with_model("gpt-5.6-sol")
        .with_level(sdk::PermissionLevel::ReadOnly);
    let snapshot = snapshot(accepted)
        .resumed()
        .with_fallback_reason("none needed");
    let result = open_result(&requested(Some("asked"), Some("high")), &snapshot, None);
    let received = serde_json::to_value(result).expect("serializable");
    let expected = json!({
        "nativeSessionId": "native-1",
        "resumed": true,
        "fallbackReason": "none needed",
        "effectiveConfiguration": {
            "model": "gpt-5.6-sol",
            "effort": "high",
            "level": "read-only",
            "routing": "auto-review",
            "workspaceRoots": ["/workspace"]
        },
        "capabilities": with(no_capabilities(), json!({ "resume": true, "steering": true })),
    });
    assert_eq!(received, expected, "open result drifted");
}

#[test]
fn open_result_falls_back_to_the_request_when_nothing_was_accepted() {
    let snapshot = snapshot(sdk::Configuration::unknown());
    let result = open_result(&requested(None, None), &snapshot, None);
    assert_eq!(result.effective_configuration, requested(None, None));
    assert!(!result.resumed);
    assert_eq!(result.fallback_reason, None);
}

// ---------------------------------------------------------------------------
// Account limits and native sessions
// ---------------------------------------------------------------------------

fn codex_limits() -> sdk::AccountLimits {
    sdk::AccountLimits {
        windows: vec![
            sdk::RateLimitWindow {
                label: Some(String::from("primary")),
                used_percent: 42.5,
                window_duration_minutes: Some(300),
                resets_at: Some(UNIX_EPOCH + Duration::from_secs(1_790_000_000)),
            },
            sdk::RateLimitWindow {
                label: None,
                used_percent: 0.0,
                window_duration_minutes: None,
                resets_at: None,
            },
        ],
        plan_type: Some(String::from("plus")),
        observed_at: UNIX_EPOCH,
    }
}

#[test]
fn account_limits_carry_windows_plan_and_the_observation_time() {
    let observed = UNIX_EPOCH + Duration::from_millis(1_790_000_000_123);
    let received = serde_json::to_value(account_limits(TargetId::Codex, &codex_limits(), observed))
        .expect("serializable");
    let expected = json!({
        "targetId": "codex",
        "windows": [
            { "label": "primary", "usedPercent": 42.5, "windowDurationMins": 300,
              "resetsAtMs": 1_790_000_000_000_u64 },
            { "usedPercent": 0.0 }
        ],
        "planType": "plus",
        "observedAtMs": 1_790_000_000_123_u64,
    });
    assert_eq!(received, expected, "account limits drifted");
}

fn native_page(count: usize) -> sdk::SessionPage {
    sdk::SessionPage {
        sessions: (0..count)
            .map(|index| sdk::NativeSession {
                native_session_id: format!("native-{index}"),
                title: Some(format!("Session {index}")),
                preview: None,
                workspace_path: Some(String::from("/workspace")),
                updated_at: Some(UNIX_EPOCH + Duration::from_millis(1_000 + index as u64)),
            })
            .collect(),
        next_cursor: Some(String::from("cursor-2")),
        truncated: true,
    }
}

#[test]
fn native_sessions_convert_times_and_cap_at_fifty() {
    let received = native_sessions(TargetId::Codex, native_page(60));
    assert_eq!(
        received.sessions.len(),
        50,
        "expected the wire's 50-row cap"
    );
    assert_eq!(received.next_cursor.as_deref(), Some("cursor-2"));
    assert_eq!(
        serde_json::to_value(&received.sessions[0]).expect("serializable"),
        json!({
            "targetId": "codex", "nativeSessionId": "native-0", "title": "Session 0",
            "workspacePath": "/workspace", "updatedAtMs": 1_000
        })
    );
    let short = native_sessions(TargetId::Cursor, native_page(3));
    assert_eq!(
        short.sessions.len(),
        3,
        "expected a truncated page kept whole"
    );
}

/// One listed row with only the fields a vendor filled.
fn listed_row(title: Option<&str>, preview: Option<&str>) -> sdk::SessionPage {
    sdk::SessionPage {
        sessions: vec![sdk::NativeSession {
            native_session_id: String::from("native-row"),
            title: title.map(String::from),
            preview: preview.map(String::from),
            workspace_path: None,
            updated_at: None,
        }],
        next_cursor: None,
        truncated: false,
    }
}

/// A Codex thread with no name keeps its preview beside an absent title,
/// so the picker's `title ?? preview` heading shows the first message rather
/// than a blank row. The runtime must never invent a title from the preview:
/// the hub persists the title as the vendor's own name for the thread.
#[test]
fn an_unnamed_codex_thread_carries_its_preview_and_no_title() {
    let listed = native_sessions(
        TargetId::Codex,
        listed_row(None, Some("add a migration for the lease table")),
    );
    let received = serde_json::to_value(&listed.sessions).expect("serializable");
    assert_eq!(
        received,
        json!([{
            "targetId": "codex",
            "nativeSessionId": "native-row",
            "preview": "add a migration for the lease table",
        }]),
        "expected an absent title beside the preview | received {received}"
    );
    assert_valid(
        "external-agent.list-sessions",
        &serde_json::to_value(&listed).expect("serializable"),
    );
}

/// Cursor lists no title and no preview; the row must stay untitled rather
/// than gain a placeholder the vendor never wrote.
#[test]
fn an_untitled_cursor_row_stays_untitled() {
    let listed = native_sessions(TargetId::Cursor, listed_row(None, None));
    let received = serde_json::to_value(&listed.sessions).expect("serializable");
    assert_eq!(
        received,
        json!([{ "targetId": "cursor", "nativeSessionId": "native-row" }]),
        "expected neither a title nor a preview on an untitled row | received {received}"
    );
    assert_valid(
        "external-agent.list-sessions",
        &serde_json::to_value(&listed).expect("serializable"),
    );
}

// ---------------------------------------------------------------------------
// Errors and reasons
// ---------------------------------------------------------------------------

fn details(error: &RemoteError) -> Value {
    Value::Object(error.details.clone().unwrap_or_default())
}

#[test]
fn caller_errors_stay_argument_errors() {
    let cases = [
        sdk::Error::HostConfiguration {
            expected: "a registered harness id",
            received: String::from("acp:grok"),
        },
        sdk::Error::not_supported(sdk::Capability::Steering),
        sdk::Error::LimitExceeded {
            subject: "attachments",
            limit: 4,
            received: 5,
        },
    ];
    for error in cases {
        let remote = remote_error(&error);
        assert_eq!(remote.code, codes::INTERNAL);
        assert_eq!(details(&remote)["kind"], "tool_argument", "for {error:?}");
    }
    assert_eq!(
        details(&remote_error(&sdk::Error::not_supported(
            sdk::Capability::Steering
        )))["capability"],
        "steering"
    );
}

#[test]
fn vendor_launch_and_timeout_failures_get_their_own_codes() {
    let cases = [
        (
            sdk::Error::Launch {
                program: String::from("/home/someone/.local/bin/codex"),
                message: String::from("no such file"),
            },
            codes::UNAVAILABLE,
            Some("external_agent_launch_failed"),
        ),
        (
            sdk::Error::Timeout {
                operation: String::from("thread/start"),
                after: Duration::from_secs(5),
            },
            codes::TIMEOUT,
            None,
        ),
        (
            sdk::Error::Cancelled {
                reason: sdk::CancelReason::ConsentRevoked,
            },
            codes::CANCELLED,
            None,
        ),
        (
            sdk::Error::VersionGate {
                found: String::from("0.1"),
                minimum: String::from("0.153.4"),
            },
            codes::UNAVAILABLE,
            Some("external_agent_version_unsupported"),
        ),
        (
            sdk::Error::AuthRequired {
                login_hint: String::from("codex login"),
            },
            codes::UNAVAILABLE,
            Some("external_agent_signed_out"),
        ),
        (
            sdk::Error::Protocol {
                expected: String::from("a thread id"),
                received: String::from("garbage"),
            },
            codes::INTERNAL,
            Some("external_agent_protocol"),
        ),
    ];
    for (error, code, kind) in cases {
        let remote = remote_error(&error);
        assert_eq!(remote.code, code, "for {error:?}");
        assert_eq!(
            details(&remote).get("kind").and_then(Value::as_str),
            kind,
            "for {error:?}"
        );
    }
    let timeout = remote_error(&sdk::Error::Timeout {
        operation: String::from("thread/start"),
        after: Duration::from_secs(5),
    });
    assert_eq!(details(&timeout)["timeoutMs"], 5_000);
    let cancelled = remote_error(&sdk::Error::Cancelled {
        reason: sdk::CancelReason::ConsentRevoked,
    });
    assert_eq!(details(&cancelled)["reason"], "consent-revoked");
}

#[test]
fn vendor_errors_never_copy_the_vendor_message() {
    let secret = "sk-live-0123456789 token=abc";
    let vendor = sdk::VendorError::new(sdk::ErrorCode::from_static("rate-limited"), secret)
        .with_vendor_code("429", true);
    let remote = remote_error(&sdk::Error::Vendor(vendor));
    let rendered = format!("{} {}", remote.message, details(&remote));
    assert!(
        !rendered.contains("sk-live"),
        "expected no credential text | received {rendered}"
    );
    assert_eq!(details(&remote)["vendorCode"], "rate-limited");
    assert_eq!(details(&remote)["retryable"], true);
    assert_eq!(details(&remote)["kind"], "external_agent_vendor");
}

#[test]
fn the_dispatch_travels_only_when_an_operation_recorded_it() {
    for (dispatch, name) in [
        (sdk::Dispatch::NotSubmitted, "not-submitted"),
        (sdk::Dispatch::Accepted, "accepted"),
        (sdk::Dispatch::AcceptanceUnknown, "acceptance-unknown"),
    ] {
        let error = sdk::Error::Link {
            peer: String::from("codex"),
            message: String::from("closed"),
        }
        .with_dispatch(dispatch);
        let remote = remote_error(&error);
        assert_eq!(details(&remote)["dispatch"], name, "for {dispatch:?}");
        assert_eq!(details(&remote)["kind"], "external_agent_link_lost");
    }
    let bare = remote_error(&sdk::Error::Busy);
    assert!(
        details(&bare).get("dispatch").is_none(),
        "expected no dispatch fabricated for a bare error"
    );
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

fn assert_valid(method: &str, result: &Value) {
    let declared = mangostudio_runtime_contract::catalog::method(method)
        .unwrap_or_else(|| panic!("expected {method} in the embedded catalog"));
    let validator = cached_result_validator(method, &declared.result);
    if let Err(error) = check_result(method, &validator, result) {
        panic!("expected a valid {method} result | received {error}: {result}");
    }
}

#[test]
fn every_mapped_result_validates_against_the_catalog() {
    let fixtures = [
        (TargetId::Claude, claude_signed_in_subscription()),
        (TargetId::Claude, claude_missing_surface()),
        (TargetId::Claude, sdk::Discovery::not_installed()),
        (TargetId::Codex, codex_signed_in()),
        (TargetId::Codex, codex_too_old()),
        (TargetId::Cursor, cursor_current()),
        (TargetId::Cursor, cursor_too_old()),
        (TargetId::Cursor, cursor_missing_surface()),
    ];
    for (target, discovery) in &fixtures {
        let result = wire::DiscoverResult {
            descriptors: vec![descriptor(*target, discovery, PROBED_AT_MS)],
        };
        assert_valid(
            "external-agent.discover",
            &serde_json::to_value(result).expect("serializable"),
        );
    }

    let limits = account_limits(TargetId::Codex, &codex_limits(), SystemTime::UNIX_EPOCH);
    let open = open_result(
        &requested(Some("gpt-5.6-sol"), None),
        &snapshot(sdk::Configuration::unknown()),
        Some(limits.clone()),
    );
    assert_valid(
        "external-agent.open",
        &serde_json::to_value(open).expect("serializable"),
    );
    assert_valid(
        "external-agent.refresh-account-usage",
        &serde_json::to_value(wire::RefreshAccountUsageResult {
            limits: Some(limits),
        })
        .expect("serializable"),
    );
    assert_valid(
        "external-agent.list-sessions",
        &serde_json::to_value(native_sessions(TargetId::Codex, native_page(60)))
            .expect("serializable"),
    );
}
