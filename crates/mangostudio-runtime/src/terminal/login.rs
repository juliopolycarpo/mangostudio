//! Shared login arguments and verified Cursor executable aliases.
use std::collections::{BTreeMap, HashSet};
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use mango_protocol::RemoteError;
use serde::Deserialize;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::probing::detection::agent_cli_definitions::{
    CURSOR_AGENT_CLI_DEFINITION, parse_cursor_shared_agent_version,
};
use crate::subprocess::{
    DefaultProcessSpawner, LaunchCheck, ProcessBudget, ProcessRequest, ProcessSpawner,
    ProcessStartError, ProcessTerminalCause,
};

#[derive(Deserialize)]
pub(crate) struct LoginDescriptor {
    pub(crate) program: String,
    pub(crate) args: Vec<String>,
}

pub(crate) fn descriptors() -> &'static BTreeMap<String, LoginDescriptor> {
    static DESCRIPTORS: OnceLock<BTreeMap<String, LoginDescriptor>> = OnceLock::new();
    DESCRIPTORS.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../../apps/shared/src/external-agents/login.json"
        ))
        .expect("checked login descriptors")
    })
}

pub(crate) fn command(target: &str) -> &'static str {
    static COMMANDS: OnceLock<BTreeMap<String, String>> = OnceLock::new();
    COMMANDS.get_or_init(|| {
        descriptors()
            .iter()
            .map(|(target, descriptor)| {
                let mut argv = vec![descriptor.program.clone()];
                argv.extend(descriptor.args.clone());
                (target.clone(), argv.join(" "))
            })
            .collect()
    })[target]
        .as_str()
}

/// Finds executable Cursor aliases in literal PATH order. For example, a
/// relative PATH directory's `agent` is pinned before the PTY changes cwd.
pub(crate) fn cursor_alias_candidates(path: Option<&str>) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    let mut candidates = Vec::new();
    if let Some(path) = path {
        for directory in std::env::split_paths(OsStr::new(path)) {
            for name in CURSOR_AGENT_CLI_DEFINITION.runtime.shared_binary_names {
                if let Ok(candidate) = std::path::absolute(directory.join(name))
                    && seen.insert(candidate.clone())
                    && crate::health::is_executable_file(&candidate)
                {
                    candidates.push(candidate);
                }
            }
        }
    }
    candidates
}

/// Probes aliases in the filtered login environment and waits for native
/// settlement. For example, Grok's `agent` is skipped when a later `agent`
/// reports a recognized Cursor release version.
pub(crate) async fn resolve_cursor_alias(
    candidates: Vec<PathBuf>,
    env: &BTreeMap<OsString, OsString>,
    cwd: &Path,
    check: Arc<dyn LaunchCheck>,
    cancel: &CancellationToken,
) -> Result<Option<PathBuf>, RemoteError> {
    let deadline = Instant::now() + Duration::from_secs(5);
    let version_args = CURSOR_AGENT_CLI_DEFINITION.runtime.version_args;
    for candidate in candidates {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if cancel.is_cancelled() || remaining.is_zero() {
            break;
        }
        let mut request =
            ProcessRequest::new(&candidate, version_args.iter().copied()).with_budget(
                ProcessBudget::new(remaining.min(Duration::from_secs(2)), 8192, 1024),
            );
        request.env = Some(env.clone());
        request.cwd = Some(cwd.to_path_buf());
        let control = match DefaultProcessSpawner
            .start(request, Arc::clone(&check), cancel.clone())
            .await
        {
            Ok(control) => control,
            Err(ProcessStartError::LaunchDenied(error)) => return Err(error),
            Err(ProcessStartError::CancelledBeforeStart) => return Ok(None),
            Err(_) => continue,
        };
        let terminal = tokio::select! {
            terminal = control.wait() => terminal,
            () = cancel.cancelled() => {
                let _ = control.cancel().await;
                control.wait().await
            }
        };
        if cancel.is_cancelled() {
            break;
        }
        if terminal.cause == ProcessTerminalCause::Exited
            && terminal.exit.is_some_and(|exit| exit.success)
            && !terminal.stdout.truncated
            && !terminal.stdout.incomplete
            && std::str::from_utf8(&terminal.stdout.bytes)
                .ok()
                .and_then(parse_cursor_shared_agent_version)
                .is_some()
        {
            return Ok(Some(candidate));
        }
    }
    Ok(None)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::test_support::ScratchDir;
    use mango_protocol::error::codes;
    use std::os::unix::fs::PermissionsExt;

    struct DenyProbe;

    impl LaunchCheck for DenyProbe {
        fn check(&self) -> Result<(), RemoteError> {
            Err(RemoteError::new(
                codes::DENIED,
                "shell consent revoked before alias probe",
            ))
        }
    }

    #[tokio::test]
    async fn cursor_alias_probe_checks_fresh_consent_before_running() {
        let scratch = ScratchDir::created("denied-cursor-alias");
        let agent = scratch.join("agent");
        let marker = scratch.join("executed");
        std::fs::write(&agent, "#!/bin/sh\nprintf ran > \"$PROBE_MARKER\"\n").unwrap();
        std::fs::set_permissions(&agent, std::fs::Permissions::from_mode(0o700)).unwrap();
        let env = BTreeMap::from([(
            OsString::from("PROBE_MARKER"),
            marker.clone().into_os_string(),
        )]);
        let error = resolve_cursor_alias(
            vec![agent],
            &env,
            &scratch,
            Arc::new(DenyProbe),
            &CancellationToken::new(),
        )
        .await
        .expect_err("revoked shell consent refuses the alias probe");
        assert_eq!(error.code, codes::DENIED);
        assert!(!marker.exists());
    }
}
