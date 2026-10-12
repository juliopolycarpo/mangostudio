//! The close bound each target gets: the SDK's own `close_worst_case` for the harness, computed
//! from the `Limits` the backend actually runs with.
use std::sync::Arc;
use std::time::Duration;

use mango_agent_acp::deadlines::Deadlines as AcpDeadlines;
use mango_agent_claude::deadlines::Deadlines as ClaudeDeadlines;
use mango_agent_codex::deadlines::Deadlines as CodexDeadlines;
use mango_external_agents::Limits;

use super::super::launcher::GuardedProcessLauncher;
use super::{Backend, ProductHarnesses, close_budget};
use crate::external_agents::port::AgentBackend;
use crate::external_agents::wire::TargetId;
use crate::subprocess::AlwaysAllow;

/// The SDK's answer for `target`, asked of its harness crate again here rather than through
/// `close_budget`: it catches an arm pointing at another harness's `Deadlines`, or a margin added
/// to one target, not a change in what the SDK computes (the default-seconds test pins that).
fn sdk_close_worst_case(target: TargetId, limits: &Limits) -> Duration {
    match target {
        TargetId::Cursor => AcpDeadlines::from_limits(limits).close_worst_case(),
        TargetId::Codex => CodexDeadlines::from_limits(limits).close_worst_case(),
        TargetId::Claude => ClaudeDeadlines::from_limits(limits).close_worst_case(),
    }
}

fn custom_limits() -> Limits {
    Limits {
        kill_grace: Duration::from_millis(10),
        shutdown_timeout: Duration::from_millis(100),
        ..Limits::default()
    }
}

#[test]
fn default_limits_give_each_target_the_sdks_worst_case_close() {
    let limits = Limits::default();
    let received = TargetId::ALL.map(|target| (target.as_str(), close_budget(&limits, target)));
    let expected = [
        ("codex", Duration::from_secs(36)),
        ("cursor", Duration::from_secs(29)),
        ("claude", Duration::from_secs(24)),
    ];
    assert_eq!(
        received, expected,
        "expected the close_worst_case seconds per target at the SDK's default limits | received {received:?}"
    );
}

#[test]
fn every_target_gets_exactly_the_sdks_worst_case_close_for_the_same_limits() {
    for limits in [Limits::default(), custom_limits()] {
        for target in TargetId::ALL {
            let received = close_budget(&limits, target);
            let expected = sdk_close_worst_case(target, &limits);
            assert_eq!(
                received,
                expected,
                "expected the {} bound to equal the SDK's close_worst_case | received {received:?} for kill_grace {:?}, shutdown_timeout {:?}",
                target.as_str(),
                limits.kill_grace,
                limits.shutdown_timeout
            );
        }
    }
}

#[test]
fn the_bound_moves_with_the_limits_it_is_derived_from() {
    let defaults = Limits::default();
    let custom = custom_limits();
    for target in TargetId::ALL {
        let (before, after) = (
            close_budget(&defaults, target),
            close_budget(&custom, target),
        );
        assert!(
            after < before && after > Duration::ZERO,
            "expected a shorter nonzero {} bound under kill_grace 10 ms and shutdown_timeout 100 ms | received {before:?} at the defaults, {after:?} under the custom limits",
            target.as_str()
        );
    }
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
    let expected = TargetId::ALL.map(|target| sdk_close_worst_case(target, &limits));
    assert_eq!(
        received, expected,
        "expected the Backend to apply its Limits per target | received {received:?}"
    );
}

/// A Claude `close` that finds an earlier one which gave up on a pending launch waits for the late
/// child's stop. The supervisor never asks twice (`close_live` claims the close once per session),
/// so this figure is not a term of the supervisor's bound; it must still fit inside it, so a host
/// that did close twice could not outlast the timer.
#[test]
fn a_later_claude_close_over_a_late_childs_stop_fits_inside_the_close_bound() {
    for limits in [Limits::default(), custom_limits()] {
        let later = ClaudeDeadlines::from_limits(&limits).close_after_pending_launch();
        let bound = close_budget(&limits, TargetId::Claude);
        assert!(
            later <= bound,
            "expected close_after_pending_launch to fit inside the Claude close bound | received {later:?} against {bound:?} for kill_grace {:?}, shutdown_timeout {:?}",
            limits.kill_grace,
            limits.shutdown_timeout
        );
    }
}
