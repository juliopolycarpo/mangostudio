//! Four command handlers sharing exact launch configuration and late consent.

use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use mango_protocol::error::{RemoteError, codes};
use mango_protocol::session::CallContext;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::{environment, gh_policy, toolchain};
use crate::blocking::run_blocking;
use crate::consent::source::ConsentSource;
use crate::ports::authorization::consent_denial;
use crate::probing::detection::path_env::PathEnv;
use crate::registry::Registry;
use crate::subprocess::{
    DefaultProcessSpawner, LaunchCheck, ProcessBudget, ProcessRequest, ProcessSpawner,
    ProcessStartError, ProcessTerminal, ProcessTerminalCause,
};

const CLI_OUTPUT_BYTES: usize = 1024 * 1024;
const SHELL_OUTPUT_BYTES: usize = 8 * 1024 * 1024;

#[cfg(test)]
mod tests;

struct Service {
    consent: Arc<ConsentSource>,
    spawner: Arc<dyn ProcessSpawner>,
}

pub(crate) fn register(mut registry: Registry, consent: ConsentSource) -> Registry {
    let service = Arc::new(Service {
        consent: Arc::new(consent),
        spawner: Arc::new(DefaultProcessSpawner),
    });
    for method in ["shell.run", "git.exec", "gh.exec", "gh.mutate"] {
        let service = Arc::clone(&service);
        registry = registry.implement(method, move |params: Value, context: CallContext| {
            let service = Arc::clone(&service);
            async move {
                service
                    .run(
                        method,
                        params,
                        context.cancel().clone(),
                        context.session().send_limit_bytes().saturating_sub(
                            serde_json::to_vec(context.id())
                                .expect("request ID serializes")
                                .len(),
                        ),
                    )
                    .await
            }
        });
    }
    registry
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShellParams {
    kind: String,
    command: String,
    cwd: Option<String>,
    timeout_ms: f64,
    max_output_bytes: f64,
    #[serde(default)]
    env_policy: environment::ShellEnvPolicy,
    toolchain: Option<toolchain::Selection>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CliParams {
    args: Vec<String>,
    cwd: String,
    timeout_ms: Option<f64>,
    accepted_exit_codes: Option<Vec<f64>>,
}

struct Prepared {
    request: ProcessRequest,
    shell: Option<(String, String)>,
    args: Vec<String>,
    accepted: Vec<f64>,
}

impl Service {
    async fn run(
        &self,
        method: &'static str,
        params: Value,
        cancel: CancellationToken,
        response_limit: usize,
    ) -> Result<Value, RemoteError> {
        let host = crate::probing::host::build_runtime_path_env(None);
        let preparation = run_blocking(move || prepare(method, params, &host, response_limit));
        let prepared = tokio::select! {
            biased;
            () = cancel.cancelled() => return Err(execution_error(method, "Command aborted before launch.", None, "", &[], true)),
            result = tokio::time::timeout(Duration::from_secs(15), preparation) => result.map_err(|_| execution_error(method, "Command preparation timed out.", None, "", &[], false))??,
        };
        let check = Arc::new(FreshLaunch {
            consent: Arc::clone(&self.consent),
            method,
            cwd: prepared.request.cwd.clone(),
        });
        let control = self
            .spawner
            .start(prepared.request.clone(), check, cancel.clone())
            .await
            .map_err(|error| start_error(method, &prepared.args, error))?;
        let terminal = if method == "gh.mutate" {
            control.wait().await
        } else {
            tokio::select! {
                terminal = control.wait() => terminal,
                () = cancel.cancelled() => {
                    let _ = control.cancel().await;
                    control.wait().await
                }
            }
        };
        map_terminal(method, &prepared, terminal)
    }
}

struct FreshLaunch {
    consent: Arc<ConsentSource>,
    method: &'static str,
    cwd: Option<PathBuf>,
}

impl LaunchCheck for FreshLaunch {
    fn check(&self) -> Result<(), RemoteError> {
        let allow = self.consent.refresh();
        let missing: Vec<_> = mangostudio_runtime_contract::catalog::capabilities_of(self.method)
            .expect("registered command belongs to the catalog")
            .iter()
            .filter(|capability| !allow.is_granted(capability))
            .cloned()
            .collect();
        if !missing.is_empty() {
            return Err(consent_denial(
                self.method,
                &missing,
                self.consent.slot().as_str(),
            ));
        }
        if let Some(cwd) = &self.cwd {
            let valid = std::fs::metadata(cwd).is_ok_and(|metadata| metadata.is_dir());
            if !valid {
                return Err(execution_error(
                    self.method,
                    &format!("Invalid cwd {:?}; expected an existing directory.", cwd),
                    None,
                    "",
                    &[],
                    false,
                ));
            }
        }
        Ok(())
    }
}

fn prepare(
    method: &str,
    params: Value,
    host: &PathEnv,
    response_limit: usize,
) -> Result<Prepared, RemoteError> {
    if method == "shell.run" {
        return prepare_shell(params, host, response_limit);
    }
    if params.get("command").is_some() {
        return Err(argument(
            "command=[redacted]",
            "argv in args, without a command field",
        ));
    }
    let params: CliParams = serde_json::from_value(params).map_err(|_| {
        argument(
            "params=[redacted]",
            "command argv, cwd, and numeric budgets",
        )
    })?;
    if params.cwd.is_empty() || params.cwd.contains('\0') {
        return Err(argument(
            "cwd=[redacted]",
            "a nonempty directory path without NUL",
        ));
    }
    if params.args.iter().any(|arg| arg.contains('\0')) {
        return Err(argument("args=[redacted]", "arguments without NUL"));
    }
    let accepted = params.accepted_exit_codes.unwrap_or_default();
    if accepted
        .iter()
        .any(|code| !code.is_finite() || code.fract() != 0.0)
    {
        return Err(argument(
            "acceptedExitCodes=[redacted]",
            "integer exit codes",
        ));
    }
    if method.starts_with("gh.") {
        gh_policy::validate(method == "gh.mutate", &params.args)?;
    }
    let env: BTreeMap<_, _> = host.env.clone().into_iter().collect();
    let (program, env) = if method == "git.exec" {
        ("git", environment::git(&env))
    } else {
        ("gh", environment::gh(&env))
    };
    let mut request = ProcessRequest::new(program, params.args.clone());
    request.cwd = Some(PathBuf::from(&params.cwd));
    request.env = Some(
        env.into_iter()
            .map(|(key, value)| (key.into(), value.into()))
            .collect(),
    );
    let cap = output_cap(
        response_limit,
        &json!({"args": params.args}),
        CLI_OUTPUT_BYTES,
    )?;
    request.budget = ProcessBudget::new(duration(params.timeout_ms.unwrap_or(15_000.0))?, cap, cap)
        .with_post_exit_drain(Duration::from_millis(50));
    Ok(Prepared {
        request,
        shell: None,
        args: params.args,
        accepted,
    })
}

fn prepare_shell(
    params: Value,
    host: &PathEnv,
    response_limit: usize,
) -> Result<Prepared, RemoteError> {
    let params: ShellParams = serde_json::from_value(params).map_err(|_| {
        argument(
            "params=[redacted]",
            "shell kind, command, and numeric budgets",
        )
    })?;
    if params.command.contains('\0') || params.cwd.as_ref().is_some_and(|cwd| cwd.contains('\0')) {
        return Err(argument("command/cwd=[redacted]", "strings without NUL"));
    }
    if !params.max_output_bytes.is_finite() || params.max_output_bytes < 0.0 {
        return Err(argument(
            &format!("maxOutputBytes={}", params.max_output_bytes),
            "a finite nonnegative byte cap",
        ));
    }
    let path = host.env.get("PATH").map(String::as_str).unwrap_or("");
    let candidates: &[&str] = match params.kind.as_str() {
        "bash" => &["bash"],
        "zsh" => &["zsh"],
        "powershell" if host.is_windows() => &["pwsh", "powershell"],
        _ => &[],
    };
    let program = candidates
        .iter()
        .find_map(|name| crate::health::which_in(name, OsStr::new(path)))
        .ok_or_else(|| {
            execution_error(
                "shell.run",
                &format!(
                    "The {:?} shell is not available on this system.",
                    params.kind
                ),
                None,
                "",
                &[],
                false,
            )
        })?;
    let args = if params.kind == "powershell" {
        vec!["-NoProfile", "-NonInteractive", "-Command", &params.command]
    } else {
        vec!["-c", &params.command]
    };
    let mut request = ProcessRequest::new(program, args);
    request.cwd = shell_cwd(params.cwd.as_deref(), &host.home_dir)?;
    let env = toolchain::build(
        host,
        params.toolchain.as_ref(),
        &toolchain::NativeToolchainFs,
    );
    request.env = Some(
        environment::shell(&env, &params.env_policy)
            .into_iter()
            .map(|(key, value)| (key.into(), value.into()))
            .collect(),
    );
    let desired = params.max_output_bytes.min(SHELL_OUTPUT_BYTES as f64) as usize;
    let cap = output_cap(
        response_limit,
        &json!({"shell":params.kind,"command":params.command}),
        desired,
    )?;
    request.budget = ProcessBudget::new(duration(params.timeout_ms)?, cap, cap)
        .with_post_exit_drain(Duration::from_millis(100));
    Ok(Prepared {
        request,
        shell: Some((params.kind, params.command)),
        args: Vec::new(),
        accepted: Vec::new(),
    })
}

fn shell_cwd(cwd: Option<&str>, home: &str) -> Result<Option<PathBuf>, RemoteError> {
    let Some(cwd) = cwd.filter(|cwd| !cwd.is_empty()) else {
        return Ok(None);
    };
    let path = if cwd == "~" {
        PathBuf::from(home)
    } else if let Some(relative) = cwd.strip_prefix("~/") {
        PathBuf::from(home).join(relative)
    } else {
        PathBuf::from(cwd)
    };
    std::path::absolute(path).map(Some).map_err(|error| {
        execution_error(
            "shell.run",
            &format!("Cannot resolve cwd: {error}"),
            None,
            "",
            &[],
            false,
        )
    })
}

fn duration(milliseconds: f64) -> Result<Duration, RemoteError> {
    if milliseconds <= 0.0 {
        return Err(argument(
            &format!("timeoutMs={milliseconds}"),
            "a positive finite duration",
        ));
    }
    let duration = Duration::try_from_secs_f64(milliseconds / 1000.0).map_err(|_| {
        argument(
            &format!("timeoutMs={milliseconds}"),
            "a positive finite duration",
        )
    })?;
    if std::time::Instant::now().checked_add(duration).is_none() {
        return Err(argument(
            &format!("timeoutMs={milliseconds}"),
            "a duration representable by the platform clock",
        ));
    }
    Ok(duration)
}

fn output_cap(limit: usize, echo: &Value, desired: usize) -> Result<usize, RemoteError> {
    let fixed = serde_json::to_vec(echo)
        .expect("JSON value serializes")
        .len()
        .saturating_add(1024);
    let available = limit.checked_sub(fixed).ok_or_else(|| {
        argument(
            "command context exceeds response budget",
            "a command that fits the negotiated frame",
        )
    })?;
    // JSON can expand a byte sixfold. CLI failures also repeat one stream in the message.
    Ok(desired.min(available / 18))
}

fn argument(value: &str, expected: &str) -> RemoteError {
    RemoteError::new(
        codes::INTERNAL,
        format!("Invalid {value}; expected {expected}."),
    )
    .with_detail("kind", "tool_argument")
}

fn execution_error(
    method: &str,
    message: &str,
    exit: Option<i32>,
    stdout: &str,
    args: &[String],
    aborted: bool,
) -> RemoteError {
    let kind = if method == "shell.run" {
        "shell_execution"
    } else if method == "git.exec" {
        "git_execution"
    } else {
        "gh_execution"
    };
    let error = RemoteError::new(codes::INTERNAL, message).with_detail("kind", kind);
    if method == "shell.run" {
        return error;
    }
    let error = error
        .with_detail("exitCode", json!(exit))
        .with_detail("stdout", stdout)
        .with_detail("stderr", message)
        .with_detail("args", json!(args));
    if aborted {
        error.with_detail("aborted", true)
    } else {
        error
    }
}

fn start_error(method: &str, args: &[String], error: ProcessStartError) -> RemoteError {
    match error {
        ProcessStartError::LimitExceeded => execution_error(
            method,
            "Process admission limit exceeded.",
            None,
            "",
            args,
            false,
        ),
        ProcessStartError::LaunchDenied(error) => error,
        ProcessStartError::CancelledBeforeStart => execution_error(
            method,
            "Command aborted before launch.",
            None,
            "",
            args,
            true,
        ),
        ProcessStartError::TimedOutBeforeStart => execution_error(
            method,
            "Command timed out before launch.",
            None,
            "",
            args,
            false,
        ),
        ProcessStartError::SpawnFailed(error) => execution_error(
            method,
            &format!("Cannot start command: {error}"),
            None,
            "",
            args,
            false,
        ),
        ProcessStartError::SupervisorUnavailable => execution_error(
            method,
            "Process supervisor unavailable.",
            None,
            "",
            args,
            false,
        ),
    }
}

fn shell_exit(terminal: &ProcessTerminal, windows: bool) -> (Option<i32>, Option<&'static str>) {
    // Bun exposes a process killed on Windows as exit code 1 with no signal,
    // including the timeout path. Preserve that wire result while keeping the
    // authoritative termination cause below as `timed_out` or `aborted`.
    if windows
        && matches!(
            terminal.cause,
            ProcessTerminalCause::TimedOut
                | ProcessTerminalCause::Cancelled
                | ProcessTerminalCause::Forced
        )
    {
        return (Some(1), None);
    }
    let exit = terminal.exit.as_ref().and_then(|exit| exit.code);
    let signal = terminal
        .exit
        .as_ref()
        .and_then(|exit| exit.signal.as_ref())
        .map(|signal| signal.name);
    (exit, signal)
}

fn cli_exit(terminal: &ProcessTerminal, windows: bool) -> Option<i32> {
    let (exit, _) = shell_exit(terminal, windows);
    exit.or_else(|| {
        terminal
            .exit
            .as_ref()
            .and_then(|exit| exit.signal.as_ref())
            .map(|signal| 128 + signal.number)
    })
}

fn map_terminal(
    method: &str,
    prepared: &Prepared,
    terminal: ProcessTerminal,
) -> Result<Value, RemoteError> {
    let stdout = capture_text(&terminal.stdout.bytes);
    let stderr = capture_text(&terminal.stderr.bytes);
    let exit = cli_exit(&terminal, cfg!(windows));
    if let Some((kind, command)) = &prepared.shell {
        let (exit, signal) = shell_exit(&terminal, cfg!(windows));
        let termination = match terminal.cause {
            ProcessTerminalCause::TimedOut => json!({"kind":"timed_out"}),
            ProcessTerminalCause::Cancelled | ProcessTerminalCause::Forced => {
                json!({"kind":"aborted"})
            }
            _ => signal.map_or_else(
                || json!({"kind":"exited"}),
                |signal| json!({"kind":"signalled","signal":signal}),
            ),
        };
        return Ok(
            json!({"shell":kind,"command":command,"exitCode":exit,"signal":signal,"stdout":stdout,"stderr":stderr,
            "truncated":terminal.stdout.truncated || terminal.stderr.truncated || terminal.stdout.incomplete || terminal.stderr.incomplete,
            "termination":termination,"durationMs":terminal.elapsed.as_secs_f64()*1000.0}),
        );
    }
    let label = if method == "git.exec" {
        "Git"
    } else {
        "GitHub CLI"
    };
    let failure = match terminal.cause {
        ProcessTerminalCause::Cancelled | ProcessTerminalCause::Forced => {
            Some((format!("{label} command aborted."), true))
        }
        ProcessTerminalCause::TimedOut => Some((format!("{label} command timed out."), false)),
        _ if terminal.stdout.truncated || terminal.stderr.truncated => Some((
            format!(
                "{label} output exceeded {} bytes.",
                prepared.request.budget.max_stdout_bytes
            ),
            false,
        )),
        _ => None,
    };
    if let Some((message, aborted)) = failure {
        return Err(execution_error(
            method,
            &message,
            exit,
            "",
            &prepared.args,
            aborted,
        ));
    }
    let code = exit.unwrap_or(1);
    if code != 0 && !prepared.accepted.contains(&f64::from(code)) {
        let fallback = format!("{label} command failed.");
        let message = if !stderr.trim().is_empty() {
            stderr.trim()
        } else if !stdout.trim().is_empty() {
            stdout.trim()
        } else {
            &fallback
        };
        let mut error = execution_error(
            method,
            message,
            Some(code),
            stdout.trim(),
            &prepared.args,
            false,
        );
        error = error.with_detail("stderr", stderr.trim());
        return Err(error);
    }
    let mut result = json!({"stdout":stdout,"stderr":stderr,"exitCode":code});
    if terminal.stdout.incomplete || terminal.stderr.incomplete {
        result["incomplete"] = json!(true);
    }
    Ok(result)
}

fn capture_text(bytes: &[u8]) -> std::borrow::Cow<'_, str> {
    // TextDecoder, used by the TypeScript peer, consumes an initial UTF-8 BOM.
    String::from_utf8_lossy(bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes))
}
