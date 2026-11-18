//! A hub session that ends while a Claude `start_turn` still waits on its launcher drops the
//! protocol handler that owns that start. The launch finishes later; these tests prove, over the
//! real Claude harness and a named launcher held at the launch, who reaps the child and what the
//! supervisor is left holding.
use std::sync::Arc;
use std::time::Duration;

use tokio_util::sync::CancellationToken;

use super::claude_stop_tests::{Kill, StubbornClaudeLauncher, limits};
use super::test_support::{self as fixtures, Rig};
use crate::external_agents::port::CloseCause;
use crate::external_agents::wire;

/// Polls `read` until it equals `expected`, failing with the last value.
async fn until<T: PartialEq + std::fmt::Debug>(what: &str, expected: T, read: impl Fn() -> T) {
    let mut last = read();
    for _ in 0..500 {
        if last == expected {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
        last = read();
    }
    panic!("expected {what} to reach {expected:?} | received {last:?}");
}

#[tokio::test]
async fn a_start_dropped_by_hub_teardown_has_its_late_child_reaped_and_leaves_nothing_registered() {
    let launcher = StubbornClaudeLauncher::new([]);
    let mut rig = Rig::new(Arc::clone(&launcher) as _, wire::TargetId::Claude, limits()).await;
    rig.open().await;
    let gate = launcher.gate_turn_launch();

    // The hub's handler for `external-agent.turn`, waiting on the launcher.
    let supervisor = Arc::clone(&rig.supervisor);
    let session_id = rig.params.session_id.clone();
    let handler = tokio::spawn(async move {
        supervisor
            .turn(
                wire::TurnParams {
                    session_id,
                    client_message_id: "late".into(),
                    input: "synthetic input".into(),
                    configuration: fixtures::configuration(),
                    attachments: None,
                },
                &CancellationToken::new(),
            )
            .await
    });
    tokio::time::timeout(Duration::from_secs(5), gate.arrived.notified())
        .await
        .expect("expected the turn to reach the launcher | received no launch within 5 s");

    // Hub teardown: the handler is dropped, then the consent watcher shuts the supervisor down.
    handler.abort();
    let _ = handler.await;
    rig.supervisor.close_all(CloseCause::Shutdown).await;

    // The launcher answers after all of that.
    gate.release.notify_one();
    until("the late child to be killed through its control", 1, || {
        launcher.kills().len()
    })
    .await;
    until("live children after the reap", 0, || {
        launcher.live_children()
    })
    .await;
    // A second kill would arrive within the same few scheduler turns; give it time to.
    tokio::time::sleep(Duration::from_millis(200)).await;

    assert_eq!(
        (
            launcher.launches(),
            launcher.kills().len(),
            launcher.live_children()
        ),
        (1, 1, 0),
        "expected one launch, killed exactly once, none alive | received (launches, kills, live) {:?} with kills {:?}",
        (
            launcher.launches(),
            launcher.kills().len(),
            launcher.live_children()
        ),
        launcher.kills(),
    );
    assert_eq!(
        rig.supervisor.live_sessions().0,
        0,
        "expected no session registered in the supervisor after shutdown | received {} live",
        rig.supervisor.live_sessions().0
    );
    // The hub that asked for the turn is the session that ended: its reply died with the handler
    // and no event of that turn exists to publish, so the hub's stream stays silent.
    let published = tokio::time::timeout(Duration::from_millis(50), rig.events.recv()).await;
    assert!(
        published.is_err(),
        "expected no event for a turn that never started | received {published:?}"
    );
}

#[tokio::test]
async fn a_late_child_whose_kill_is_refused_is_tried_once_and_left_to_the_guarded_launcher() {
    let launcher = StubbornClaudeLauncher::new([Kill::Refuse, Kill::End]);
    let rig = Rig::new(Arc::clone(&launcher) as _, wire::TargetId::Claude, limits()).await;
    rig.open().await;
    let gate = launcher.gate_turn_launch();
    let supervisor = Arc::clone(&rig.supervisor);
    let session_id = rig.params.session_id.clone();
    let handler = tokio::spawn(async move {
        supervisor
            .turn(
                wire::TurnParams {
                    session_id,
                    client_message_id: "late".into(),
                    input: "synthetic input".into(),
                    configuration: fixtures::configuration(),
                    attachments: None,
                },
                &CancellationToken::new(),
            )
            .await
    });
    tokio::time::timeout(Duration::from_secs(5), gate.arrived.notified())
        .await
        .expect("expected the turn to reach the launcher | received no launch within 5 s");
    handler.abort();
    let _ = handler.await;
    rig.supervisor.close_all(CloseCause::Shutdown).await;
    gate.release.notify_one();
    tokio::time::sleep(Duration::from_millis(800)).await;

    assert_eq!(
        (launcher.kills().len(), launcher.live_children()),
        (1, 1),
        "expected a refused kill on an abandoned start to be tried once and leave the child to the guarded launcher | received (kills, live) {:?} with {:?}",
        (launcher.kills().len(), launcher.live_children()),
        launcher.kills(),
    );
}
