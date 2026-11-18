//! Tests that need the assembled production host: the registry `transport::build_host` builds
//! from every method family, which spans this crate and `mangostudio-runtime-cold`.
//!
//! They sit here, not beside `discovery` and `manifest` in `mangostudio-runtime-core`, because
//! the core crate cannot see the families it announces.

use mangostudio_runtime_contract::manifest::RuntimeCapabilityAllow;
use mangostudio_runtime_core::discovery::{
    DISCOVER_METHOD, TERMINAL_PREFIX, discovery_of, implemented_features,
};
use mangostudio_runtime_core::manifest::build_features;
use mangostudio_runtime_core::registry::Registry;
use mangostudio_runtime_core::runtime_home::RuntimeSlot;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use crate::test_support::scratch_dir;

fn full_allow() -> RuntimeCapabilityAllow {
    RuntimeCapabilityAllow {
        fs_read: true,
        fs_write: true,
        shell: true,
        git: true,
        probing: true,
        mcp: true,
        library: true,
        checkpoints: true,
        update: true,
        external_agents: Some(true),
    }
}

/// The pin the ceiling rests on: for every group, "implemented" must be
/// exactly what `features` reports under a full grant on a machine that
/// has git. A group registered without its flag, or flagged without its
/// methods, fails here.
#[test]
fn the_production_ceiling_matches_the_features_gate_under_full_consent() {
    let home = scratch_dir("discovery-ceiling");
    let host = crate::transport::build_host(RuntimeSlot::Host, &home, "9.9.9");
    let implemented = implemented_features(&host.registry);
    let granted = build_features(&host.registry, &full_allow(), true);

    let pairs = [
        ("git", implemented.git, granted.git),
        ("probing", implemented.probing, granted.probing),
        ("mcp", implemented.mcp, granted.mcp),
        ("library", implemented.library, granted.library),
        ("checkpoints", implemented.checkpoints, granted.checkpoints),
        ("fsRead", implemented.fs_read, granted.fs_read),
        ("fsWrite", implemented.fs_write, granted.fs_write),
        ("shell", implemented.shell, granted.shell),
        ("update", implemented.update, granted.update),
        (
            "externalAgents",
            implemented.external_agents,
            granted.external_agents,
        ),
    ];
    for (key, implemented, granted) in pairs {
        assert_eq!(
            implemented, granted,
            "expected implementation.features.{key} to equal features.{key} under full \
             consent | implemented: {implemented} | features: {granted}"
        );
    }
}

#[tokio::test]
async fn runtime_discover_answers_the_finished_registry_including_itself() {
    let home = scratch_dir("discovery-answer");
    let host = crate::transport::build_host(RuntimeSlot::Host, &home, "9.9.9");
    let expected = discovery_of(&host.registry);
    assert_eq!(
        expected.features.terminal,
        cfg!(any(unix, windows)),
        "expected the production build to implement the whole terminal.* family"
    );
    assert!(
        expected
            .methods
            .iter()
            .any(|method| method == DISCOVER_METHOD),
        "expected runtime.discover among {:?}",
        expected.methods
    );

    let wire = serde_json::to_value(&expected).expect("serialises");
    assert!(
        mangostudio_runtime_contract::schemas::validate_result(DISCOVER_METHOD, &wire).is_ok(),
        "the production answer must fit the runtime.discover result schema: {wire}"
    );

    let manifest = crate::health::build_capability_manifest(
        RuntimeSlot::Host,
        &home,
        &host.registry,
        &CancellationToken::new(),
    )
    .await;
    assert_eq!(manifest.implementation, Some(expected.implementation()));
}

#[tokio::test]
async fn consent_never_changes_the_announced_implementation() {
    let granted_home = scratch_dir("discovery-consent-granted");
    let denied_home = scratch_dir("discovery-consent-denied");
    mangostudio_runtime_core::runtime_home::write_runtime_slot_config(
        RuntimeSlot::Host,
        &denied_home,
        &[(
            "allow",
            Some(json!({
                "fsRead": false, "fsWrite": false, "shell": false, "git": false,
                "probing": false, "mcp": false, "library": false, "checkpoints": false,
                "update": false, "externalAgents": false,
            })),
        )],
    )
    .expect("deny every capability");

    let mut announced = Vec::new();
    for home in [&granted_home, &denied_home] {
        let host = crate::transport::build_host(RuntimeSlot::Host, home, "9.9.9");
        let manifest = crate::health::build_capability_manifest(
            RuntimeSlot::Host,
            home,
            &host.registry,
            &CancellationToken::new(),
        )
        .await;
        announced.push((manifest.features.shell, manifest.implementation));
    }

    assert!(announced[0].0, "the granted host must report shell");
    assert!(!announced[1].0, "the denied host must not report shell");
    assert_eq!(
        announced[0].1, announced[1].1,
        "expected one implementation under both consent profiles | granted: {:?} | denied: {:?}",
        announced[0].1, announced[1].1
    );
    assert!(announced[0].1.as_ref().is_some_and(|i| i.features.shell));
}

/// `health.rs` still attests terminal cleanup through the hand-kept
/// `TERMINAL_METHODS`; this keeps that list equal to the catalog family
/// the implementation ceiling derives from.
#[test]
fn the_hand_kept_terminal_list_is_the_catalog_terminal_family() {
    let mut declared: Vec<&str> = mangostudio_runtime_contract::catalog::catalog()
        .methods
        .iter()
        .map(|method| method.name.as_str())
        .filter(|name| name.starts_with(TERMINAL_PREFIX))
        .collect();
    declared.sort_unstable();
    let mut listed: Vec<&str> = crate::terminal::TERMINAL_METHODS.to_vec();
    listed.sort_unstable();
    assert_eq!(
        listed, declared,
        "expected TERMINAL_METHODS: {declared:?} | received: {listed:?}"
    );
}

/// The gate `manifest` exists for, observable for real: with `probing::register` implementing
/// all three `probing.*` methods, `features.probing` still needs `allow.probing` granted — an
/// implemented capability is not a granted one.
#[test]
fn probing_flips_true_only_when_all_three_methods_are_implemented_and_allowed() {
    let registry = crate::probing::register(Registry::new());

    let allowed = build_features(&registry, &full_allow(), true);
    assert!(
        allowed.probing,
        "all three probing.* methods are implemented and allow.probing is granted"
    );

    let mut denied_allow = full_allow();
    denied_allow.probing = false;
    let denied = build_features(&registry, &denied_allow, true);
    assert!(
        !denied.probing,
        "a consent denial must still suppress probing even though every method is implemented"
    );
}

#[test]
fn filesystem_registration_enables_checkpoints_without_library() {
    let home = scratch_dir("manifest-filesystem");
    let registry = crate::filesystem::register(
        crate::workspace_methods::register(Registry::new()),
        crate::consent::source::ConsentSource::new(RuntimeSlot::Host, home.to_path_buf()),
    );
    let ready = build_features(&registry, &full_allow(), false);
    assert!(ready.fs_read && ready.fs_write && ready.tools);
    assert!(ready.checkpoints && !ready.library);
    let mut allow = full_allow();
    allow.fs_read = false;
    let denied = build_features(&registry, &allow, false);
    assert!(!denied.fs_read);
    assert!(denied.fs_write);
}
