//! The hub's capacity-retry window is tied to the close bound the runtime enforces.
use std::sync::Arc;
use std::time::Duration;

use super::super::production_backend;
use crate::external_agents::supervisor::{CAPACITY_KIND, CLEANUP_TIMEOUT};
use crate::external_agents::wire::TargetId;
use crate::subprocess::AlwaysAllow;

/// Slack on top of the longest a slot can stay held: one retry interval (1 s) for the attempt that
/// lands just before a slot frees, and one more for the round trip. `CAPACITY_RETRY_MS` in the
/// hub's `external-session-manager.ts` is
/// `longest close bound + cleanup wait of a cancelled open + this`.
const HUB_RETRY_MARGIN: Duration = Duration::from_secs(2);

const HUB_SESSION_MANAGER: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../apps/api/src/modules/external-agents/application/external-session-manager.ts"
);

/// The number in `const CAPACITY_RETRY_MS = 40_000;`, or why it could not be read.
fn hub_capacity_retry_window(source: &str) -> Result<Duration, String> {
    let declaration = "const CAPACITY_RETRY_MS = ";
    let start = source
        .find(declaration)
        .ok_or_else(|| format!("expected a `{declaration}<milliseconds>;` declaration"))?
        + declaration.len();
    let literal: String = source[start..]
        .chars()
        .take_while(|character| *character != ';')
        .collect();
    literal
        .replace('_', "")
        .trim()
        .parse::<u64>()
        .map(Duration::from_millis)
        .map_err(|error| {
            format!("expected an integer millisecond literal | received {literal:?} ({error})")
        })
}

const HUB_OPEN_FAILURES: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../apps/shared/src/external-agents/open-failures.ts"
);

/// The client names a runtime at its session cap by the kind this refusal carries and has copy for
/// that spelling only, so a rename on either side would silently turn it back into the generic
/// sentence. This ties the shared constant to the kind the supervisor sends.
#[test]
fn the_shared_capacity_code_is_the_kind_the_supervisor_refuses_with() {
    let source = std::fs::read_to_string(HUB_OPEN_FAILURES).unwrap_or_else(|error| {
        panic!("expected the shared open failures at {HUB_OPEN_FAILURES} | received {error}")
    });
    let marker = "export const EXTERNAL_AGENT_CAPACITY_CODE = '";
    let start = source
        .find(marker)
        .unwrap_or_else(|| panic!("expected `{marker}...'` in {HUB_OPEN_FAILURES}"))
        + marker.len();
    let received: String = source[start..]
        .chars()
        .take_while(|character| *character != '\'')
        .collect();
    assert_eq!(
        received, CAPACITY_KIND,
        "expected EXTERNAL_AGENT_CAPACITY_CODE to equal the supervisor's CAPACITY_KIND | received {received:?}"
    );
}

#[test]
fn the_hub_retry_window_reads_back_from_its_declaration() {
    let source = "/** doc */\nconst CAPACITY_RETRY_MS = 40_000;\nconst OTHER = 1;";
    assert_eq!(
        hub_capacity_retry_window(source),
        Ok(Duration::from_secs(40)),
        "expected the underscore-separated literal to read as 40 s"
    );
}

#[test]
fn a_hub_retry_window_that_is_not_a_literal_is_named_in_the_failure() {
    let received = hub_capacity_retry_window("const CAPACITY_RETRY_MS = limit();");
    assert!(
        matches!(&received, Err(message) if message.contains("limit()")),
        "expected a failure that quotes the non-literal `limit()` | received {received:?}"
    );
    let missing = hub_capacity_retry_window("const OTHER = 1;");
    assert!(
        matches!(&missing, Err(message) if message.contains("CAPACITY_RETRY_MS")),
        "expected a failure that names the missing declaration | received {missing:?}"
    );
}

/// The hub retries an `external_agent_capacity` refusal for as long as the runtime can still be
/// closing the session that holds the slot, and the hub cannot see the runtime's limits, so it
/// holds a literal. A slot is held longest by a cancelled open: the supervisor waits up to
/// `CLEANUP_TIMEOUT` for it to settle, then closes what it opened under the close bound, so the
/// window covers both, plus the margin. This ties that literal to the number the runtime enforces, at the limits
/// production passes, so an SDK deadline change or an edit on either side fails here.
#[test]
fn the_hub_retry_window_is_the_longest_runtime_close_bound_plus_its_margins() {
    let backend = production_backend(Arc::new(AlwaysAllow), CLEANUP_TIMEOUT);
    let longest = TargetId::ALL
        .map(|target| backend.close_budget(target).saturating_add(CLEANUP_TIMEOUT))
        .into_iter()
        .max()
        .expect("TargetId::ALL is not empty");
    let held = longest.saturating_add(CLEANUP_TIMEOUT);
    let source = std::fs::read_to_string(HUB_SESSION_MANAGER).unwrap_or_else(|error| {
        panic!("expected the hub session manager at {HUB_SESSION_MANAGER} | received {error}")
    });
    let window = hub_capacity_retry_window(&source)
        .unwrap_or_else(|message| panic!("{message} | in {HUB_SESSION_MANAGER}"));
    assert_eq!(
        window,
        held.saturating_add(HUB_RETRY_MARGIN),
        "expected CAPACITY_RETRY_MS to be {held:?} (the longest runtime close bound {longest:?}, SDK close_worst_case + cleanup, plus {CLEANUP_TIMEOUT:?} for a cancelled open to settle) plus {HUB_RETRY_MARGIN:?} | received {window:?}"
    );
}
