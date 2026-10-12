//! The close bound each target gets, derived from the SDK's documented deadlines and the
//! `Limits` the backend actually runs with.
use std::sync::Arc;
use std::time::Duration;

use mango_external_agents::Limits;

use super::super::launcher::GuardedProcessLauncher;
use super::{Backend, ProductHarnesses, close_budget};
use crate::external_agents::port::AgentBackend;
use crate::external_agents::wire::TargetId;
use crate::subprocess::AlwaysAllow;

fn seconds(target: TargetId, limits: &Limits) -> u64 {
    close_budget(limits, target).as_secs()
}

#[test]
fn default_limits_give_each_target_its_documented_worst_close() {
    let limits = Limits::default();
    let received = TargetId::ALL.map(|target| (target.as_str(), seconds(target, &limits)));
    assert_eq!(
        received,
        [("codex", 41), ("cursor", 34), ("claude", 24)],
        "expected worst close seconds per target at 2 s kill_grace and 5 s shutdown_timeout | received {received:?}"
    );
}

#[test]
fn every_default_bound_covers_the_documented_close_paths() {
    let limits = Limits::default();
    let documented = [
        (TargetId::Cursor, 29, "ACP close"),
        (TargetId::Cursor, 34, "ACP agent exit to Closed"),
        (TargetId::Codex, 36, "Codex teardown"),
        (TargetId::Claude, 19, "Claude close with a turn active"),
        (TargetId::Claude, 24, "Claude close over a pending launch"),
    ];
    for (target, path_seconds, path) in documented {
        let bound = seconds(target, &limits);
        assert!(
            bound >= path_seconds,
            "expected a {} bound of at least {path_seconds} s for {path} | received {bound} s",
            target.as_str()
        );
    }
}

#[test]
fn the_bound_moves_with_the_limits_it_is_derived_from() {
    let limits = Limits {
        kill_grace: Duration::from_millis(10),
        shutdown_timeout: Duration::from_millis(100),
        ..Limits::default()
    };
    let received = TargetId::ALL.map(|target| close_budget(&limits, target));
    assert_eq!(
        received,
        [
            Duration::from_millis(730),
            Duration::from_millis(620),
            Duration::from_millis(420),
        ],
        "expected 3 kg + 7 st, 2 kg + 6 st and 2 kg + 4 st for codex, cursor, claude | received {received:?}"
    );
}

#[test]
fn an_unbounded_limit_saturates_instead_of_panicking() {
    let limits = Limits {
        shutdown_timeout: Duration::MAX,
        ..Limits::default()
    };
    for target in TargetId::ALL {
        assert_eq!(
            close_budget(&limits, target),
            Duration::MAX,
            "expected a saturated {} bound for a Duration::MAX shutdown_timeout",
            target.as_str()
        );
    }
}

#[test]
fn the_backend_answers_with_its_own_limits_per_target() {
    let limits = Limits {
        kill_grace: Duration::from_secs(1),
        shutdown_timeout: Duration::from_secs(3),
        ..Limits::default()
    };
    let backend = Backend::new(
        Arc::new(GuardedProcessLauncher::new(Arc::new(AlwaysAllow), &limits)),
        Arc::new(ProductHarnesses),
        limits,
        Duration::from_secs(2),
    );
    let received = TargetId::ALL.map(|target| backend.close_budget(target));
    let expected = TargetId::ALL.map(|target| close_budget(&limits, target));
    assert_eq!(
        received, expected,
        "expected the Backend to apply its Limits per target | received {received:?}"
    );
}
