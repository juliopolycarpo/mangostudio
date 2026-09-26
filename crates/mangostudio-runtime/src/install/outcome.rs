//! The terminal result of one install run: the wire status, exit code and timing.

use serde_json::{Value, json};

use crate::subprocess::{ProcessTerminal, ProcessTerminalCause};

/// `RuntimeInstallRunResult.status`.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RunStatus {
    Succeeded,
    Failed,
    Cancelled,
    TimedOut,
    SpawnFailed,
}

impl RunStatus {
    /// The wire literal, e.g. `RunStatus::TimedOut.as_str() == "timed-out"`.
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::TimedOut => "timed-out",
            Self::SpawnFailed => "spawn-failed",
        }
    }
}

/// One settled run, before it is stamped with its finish time.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct RunOutcome {
    pub exit_code: Option<i32>,
    pub status: RunStatus,
    pub truncated: bool,
    /// Whether an effect was ever launched, so a non-success may have changed the machine.
    pub launched: bool,
}

impl RunOutcome {
    /// A run whose step never started, e.g. `RunOutcome::not_launched(RunStatus::Cancelled)`.
    pub(crate) fn not_launched(status: RunStatus) -> Self {
        Self {
            exit_code: None,
            status,
            truncated: false,
            launched: false,
        }
    }

    /// Whether the machine may hold a partial change: a launched step that did not succeed.
    pub(crate) fn partial_effects_possible(self) -> bool {
        self.launched && self.status != RunStatus::Succeeded
    }

    /// The `RuntimeInstallRunResult` wire object for timestamps in epoch milliseconds.
    ///
    /// # Example
    ///
    /// ```ignore
    /// let value = RunOutcome::not_launched(RunStatus::Cancelled).to_wire(10, 15);
    /// assert_eq!(value["durationMs"], 5);
    /// ```
    pub(crate) fn to_wire(self, started_ms: u64, finished_ms: u64) -> Value {
        json!({
            "exitCode": self.exit_code,
            "status": self.status.as_str(),
            "truncated": self.truncated,
            "finishedAt": finished_ms,
            "durationMs": finished_ms.saturating_sub(started_ms),
        })
    }
}

/// Maps a launched step's supervisor record to its wire status and exit code.
///
/// The exit code is what Bun reports (`128 + signal` on Unix, `1` for a killed Windows child), so
/// a timed-out step reads the same as the TypeScript runtime's SIGKILLed one. A non-zero code is
/// still success when the recipe accepts it. A forced record with no stop request can only be the
/// supervisor's vanished-worker fallback, which is reported as `failed`, never as success.
///
/// # Example
///
/// ```ignore
/// let (exit, status) = launched_status(&terminal_exiting_with(0), &[], false);
/// assert_eq!((exit, status), (Some(0), RunStatus::Succeeded));
/// ```
pub(crate) fn launched_status(
    terminal: &ProcessTerminal,
    accepted: &[f64],
    windows: bool,
) -> (Option<i32>, RunStatus) {
    let exit = crate::commands::cli_exit(terminal, windows);
    let status = match terminal.cause {
        ProcessTerminalCause::TimedOut => RunStatus::TimedOut,
        ProcessTerminalCause::Exited if exit == Some(0) || accepts_exit_code(exit, accepted) => {
            RunStatus::Succeeded
        }
        _ => RunStatus::Failed,
    };
    (exit, status)
}

/// Whether `code` is one of the recipe's accepted non-zero exit codes, compared modulo 2^32.
///
/// A recipe pins winget's HRESULT as a signed constant; a platform may report the same bit
/// pattern unsigned. Mirrors `isAcceptedExitCode`'s `candidate >>> 0 === code >>> 0`.
///
/// # Example
///
/// ```ignore
/// assert!(accepts_exit_code(Some(-1978335189), &[2316632107.0]));
/// ```
pub(crate) fn accepts_exit_code(code: Option<i32>, accepted: &[f64]) -> bool {
    let Some(code) = code else {
        return false;
    };
    accepted
        .iter()
        .any(|candidate| to_uint32(*candidate) == to_uint32(f64::from(code)))
}

/// ECMAScript `ToUint32`: truncate toward zero, then wrap modulo 2^32; non-finite is `0`.
fn to_uint32(value: f64) -> u32 {
    if !value.is_finite() {
        return 0;
    }
    value.trunc().rem_euclid(4_294_967_296.0) as u32
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::{RunOutcome, RunStatus, accepts_exit_code, launched_status, to_uint32};
    use crate::subprocess::{
        ProcessCapture, ProcessExit, ProcessSignal, ProcessTerminal, ProcessTerminalCause,
    };

    const WINGET_NO_APPLICABLE_UPGRADE: f64 = -1_978_335_189.0;

    fn capture() -> ProcessCapture {
        ProcessCapture {
            bytes: Vec::new(),
            truncated: false,
            incomplete: false,
        }
    }

    fn terminal(cause: ProcessTerminalCause, exit: Option<ProcessExit>) -> ProcessTerminal {
        ProcessTerminal {
            cause,
            exit,
            elapsed: Duration::from_millis(1),
            stdout: capture(),
            stderr: capture(),
        }
    }

    fn exited(code: i32) -> ProcessTerminal {
        terminal(
            ProcessTerminalCause::Exited,
            Some(ProcessExit {
                success: code == 0,
                code: Some(code),
                signal: None,
            }),
        )
    }

    #[test]
    fn a_zero_exit_succeeds_and_a_non_zero_exit_fails() {
        assert_eq!(
            launched_status(&exited(0), &[], false),
            (Some(0), RunStatus::Succeeded)
        );
        assert_eq!(
            launched_status(&exited(1), &[], false),
            (Some(1), RunStatus::Failed)
        );
    }

    /// TS: "treats an accepted non-zero exit code as success".
    #[test]
    fn an_accepted_non_zero_exit_code_is_success() {
        let code = WINGET_NO_APPLICABLE_UPGRADE as i32;
        assert_eq!(
            launched_status(&exited(code), &[WINGET_NO_APPLICABLE_UPGRADE], false),
            (Some(code), RunStatus::Succeeded),
            "expected winget's already-current code accepted as success"
        );
    }

    /// TS: "still fails a non-zero exit code the recipe did not accept".
    #[test]
    fn an_unaccepted_non_zero_exit_code_still_fails() {
        assert_eq!(
            launched_status(&exited(1), &[WINGET_NO_APPLICABLE_UPGRADE], false).1,
            RunStatus::Failed
        );
    }

    /// TS: "matches an accepted exit code by bit pattern, not sign".
    #[test]
    fn accepted_codes_match_by_bit_pattern_not_sign() {
        assert!(accepts_exit_code(
            Some(WINGET_NO_APPLICABLE_UPGRADE as i32),
            &[2_316_632_107.0]
        ));
        assert!(accepts_exit_code(
            Some(-1_978_335_189),
            &[WINGET_NO_APPLICABLE_UPGRADE]
        ));
        assert!(!accepts_exit_code(None, &[0.0]));
        assert!(!accepts_exit_code(Some(1), &[]));
        assert_eq!(to_uint32(-1.0), u32::MAX);
        assert_eq!(to_uint32(f64::NAN), 0);
        assert_eq!(to_uint32(3.9), 3);
    }

    /// TS: "kills a timed-out child with SIGKILL" — Bun reports the SIGKILLed child as 137.
    #[test]
    fn a_timed_out_step_reports_the_sigkill_exit_code() {
        let killed = terminal(
            ProcessTerminalCause::TimedOut,
            Some(ProcessExit {
                success: false,
                code: None,
                signal: Some(ProcessSignal {
                    number: 9,
                    name: "SIGKILL",
                }),
            }),
        );
        assert_eq!(
            launched_status(&killed, &[], false),
            (Some(137), RunStatus::TimedOut)
        );
        assert_eq!(
            launched_status(&killed, &[], true),
            (Some(1), RunStatus::TimedOut),
            "expected Bun's Windows reading of a killed child"
        );
    }

    #[test]
    fn a_forced_record_without_a_stop_request_is_a_failure_not_a_success() {
        let vanished = terminal(ProcessTerminalCause::Forced, None);
        assert_eq!(
            launched_status(&vanished, &[0.0], false),
            (None, RunStatus::Failed)
        );
    }

    #[test]
    fn the_wire_result_carries_status_timing_and_partial_effect_facts() {
        let outcome = RunOutcome {
            exit_code: Some(137),
            status: RunStatus::TimedOut,
            truncated: true,
            launched: true,
        };
        assert_eq!(
            outcome.to_wire(1_000, 1_250),
            serde_json::json!({
                "exitCode": 137, "status": "timed-out", "truncated": true,
                "finishedAt": 1_250, "durationMs": 250,
            })
        );
        assert!(outcome.partial_effects_possible());
        assert!(!RunOutcome::not_launched(RunStatus::Cancelled).partial_effects_possible());
        assert_eq!(RunStatus::SpawnFailed.as_str(), "spawn-failed");
        assert_eq!(RunStatus::Cancelled.as_str(), "cancelled");
        assert_eq!(RunStatus::Succeeded.as_str(), "succeeded");
        assert_eq!(RunStatus::Failed.as_str(), "failed");
    }
}
