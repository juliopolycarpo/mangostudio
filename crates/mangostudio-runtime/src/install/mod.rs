//! `install.run` and `install.cancel`: running one hub-built installer argv on this machine,
//! streaming its output as `install.output` events, and stopping safely.
//!
//! The hub decides everything about *whether* — which recipes exist, which are allowed, the argv
//! and the audit row. This module owns only what has to happen where the software is going:
//! launching the argv through the shared process supervisor, capturing bounded output into the
//! run's log, and recording how the step ended. It mirrors `apps/runtime/src/services/install.ts`
//! except for the cancellation corrections below.
//!
//! # Chains, steps and stopping
//!
//! Each `install.run` carries one argv, so each run is one step. The chain is the set of runs a
//! hub session requested; a stop reason applies to the run it names (`install.cancel`) or to
//! every run of the session (session loss, abandoned request, consent withdrawal).
//!
//! - **Before a step launches**, any stop prevents the launch: the run settles as `cancelled`
//!   with nothing started. Shell consent is re-read inside the supervisor immediately before the
//!   OS effect, and an `install.cancel` that arrives before its `install.run` still applies.
//! - **During a step**, explicit cancel, hub-session loss and consent withdrawal only mark the
//!   chain stopping. The step keeps its owner and finishes within its own `timeoutMs`, its real
//!   result (`succeeded`, `failed`, `timed-out`) is recorded, and no further step starts.
//!   Consent withdrawal is noticed locally by polling `runtime.json`, since the guard already
//!   denies the hub's `install.cancel` once shell consent is gone.
//! - **A step's timeout** forces its process tree through the supervisor and is reported as
//!   `timed-out` with a note that the machine may be partially changed.
//! - **Runtime process exit** by signal ends the process, and the supervisor's parent-death lease
//!   (a Job object on Windows) terminates whatever the step still owns. On end of stdio input with
//!   no signal after it, the host first waits for [`settled`], bounded by each step's own deadline.
//!   That is the hub crashing or otherwise vanishing. An orderly Hub stop ends stdin and then
//!   escalates to SIGTERM after 2 s and SIGKILL 2 s later (`TERMINATE_GRACE_MS` and
//!   `KILL_GRACE_MS` in `apps/api/src/services/runtime-client/spawn-runtime-child.ts`; on Windows
//!   both steps are process termination at 2 s), so its signal or termination cuts the wait
//!   short and a longer step is killed. Whether the Hub should widen that
//!   window while installs run is an open decision owned there, not here.
//!
//! Detaching a browser viewer is not cancellation, and no path promises rollback. A run's owner is
//! a task of its own, so dropping the request (the session tearing down its handlers) never
//! drops the step; when no request is left to answer, the owner writes the audit line and a
//! stderr diagnostic itself.

mod environment;
mod log;
mod outcome;
mod output;
mod runs;
mod service;

pub(crate) use service::register;

/// Resolves once every install run this process owns has settled.
///
/// Each run is bounded by its own step deadline plus the supervisor's cleanup bound, so this
/// never waits indefinitely. The stdio host awaits it after its hub session ends on end of input,
/// until a signal arrives. So a hub that crashes (end of input, no signal) does not turn into a
/// killed installer; an orderly Hub stop still signals within its own escalation window, which
/// ends a longer step (see the module docs).
///
/// # Example
///
/// ```ignore
/// crate::install::settled().await;
/// ```
pub(crate) async fn settled() {
    runs::InstallRuns::process().settled().await;
}
