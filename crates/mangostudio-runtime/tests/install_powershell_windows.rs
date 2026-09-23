//! Windows install recipes run `powershell`, so a PowerShell child must stream stdout through the
//! supervisor under the exact request shape `install.run` builds: a bare `powershell` resolved by
//! `CreateProcessW`, the install environment allowlist, a null stdin, the runtime's own cwd, a
//! zero capture cap, and an output tap.
//!
//! When the install shape fails, the assertion names (never prints the values of) the variables
//! the allowlist drops here and bisects them for the one PowerShell needs, so a failure on a
//! Windows runner names the variable.
#![cfg(windows)]

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use mangostudio_runtime::subprocess::{
    AlwaysAllow, DefaultProcessSpawner, ProcessBudget, ProcessOutputTap, ProcessRequest,
    ProcessSpawner, ProcessStdin, ProcessStream,
};
use tokio_util::sync::CancellationToken;

/// `INSTALL_ENV_KEYS` plus `WIN32_INSTALL_ENV_KEYS` from `src/install/environment.rs`.
const INSTALL_KEYS: &[&str] = &[
    "PATH",
    "HOME",
    "SHELL",
    "TMPDIR",
    "TMP",
    "TEMP",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_RUNTIME_DIR",
    "NVM_DIR",
    "FNM_DIR",
    "BUN_INSTALL",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "SystemRoot",
    "WINDIR",
    "ComSpec",
    "PATHEXT",
    "SystemDrive",
    "USERPROFILE",
    "LOCALAPPDATA",
    "APPDATA",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "ProgramData",
];

/// The install allowlist over this process's environment, with `Path` read as `PATH`.
fn install_env() -> BTreeMap<OsString, OsString> {
    let mut env = BTreeMap::new();
    for (key, value) in std::env::vars_os() {
        let name = key.to_string_lossy();
        let canonical = if name.eq_ignore_ascii_case("PATH") {
            "PATH"
        } else {
            name.as_ref()
        };
        if INSTALL_KEYS.contains(&canonical) {
            env.insert(OsString::from(canonical), value);
        }
    }
    env
}

#[derive(Clone)]
struct Shape {
    label: &'static str,
    program: PathBuf,
    args: Vec<String>,
    env: BTreeMap<OsString, OsString>,
    stdin: ProcessStdin,
    cwd: Option<PathBuf>,
    tap: bool,
    cap: usize,
}

impl Shape {
    /// Exactly what `install.run` sends for a `powershell -Command` recipe.
    fn install(command: &str) -> Self {
        Self {
            label: "install shape",
            program: PathBuf::from("powershell"),
            args: ["-NoProfile", "-NonInteractive", "-Command", command]
                .map(String::from)
                .to_vec(),
            env: install_env(),
            stdin: ProcessStdin::Null,
            cwd: None,
            tap: true,
            cap: 0,
        }
    }
}

/// Runs one shape and returns the stdout it streamed (or captured) and a one-line report.
async fn run(shape: &Shape, deadline: Duration) -> (String, String) {
    let (tap, mut chunks) = ProcessOutputTap::channel(64);
    let mut request = ProcessRequest::new(&shape.program, shape.args.clone())
        .with_stdin(shape.stdin.clone())
        .with_budget(ProcessBudget::new(deadline, shape.cap, shape.cap));
    request.env = Some(shape.env.clone());
    request.cwd = shape.cwd.clone();
    if shape.tap {
        request = request.with_output_tap(tap);
    } else {
        drop(tap);
    }
    let terminal = DefaultProcessSpawner
        .start(request, Arc::new(AlwaysAllow), CancellationToken::new())
        .await
        .expect("powershell starts")
        .wait()
        .await;
    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    while let Ok(chunk) = chunks.try_recv() {
        match chunk.stream {
            ProcessStream::Stdout => stdout.extend(chunk.bytes),
            ProcessStream::Stderr => stderr.extend(chunk.bytes),
        }
    }
    if !shape.tap {
        stdout = terminal.stdout.bytes.clone();
        stderr = terminal.stderr.bytes.clone();
    }
    let stdout = String::from_utf8_lossy(&stdout).into_owned();
    let report = format!(
        "{}: cause={:?} exit={:?} stdout={:?} stderr={:?} elapsed={:?}",
        shape.label,
        terminal.cause,
        terminal.exit.as_ref().map(|exit| exit.code),
        stdout,
        String::from_utf8_lossy(&stderr),
        terminal.elapsed
    );
    (stdout, report)
}

/// Names (never values) of this process's variables the install allowlist drops, and of the
/// allowlist keys that exist here only under a different casing.
fn allowlist_report(full: &BTreeMap<OsString, OsString>) -> (Vec<OsString>, String) {
    let allowed = install_env();
    let dropped: Vec<OsString> = full
        .keys()
        .filter(|key| {
            !allowed.contains_key(*key) && !key.to_string_lossy().eq_ignore_ascii_case("PATH")
        })
        .cloned()
        .collect();
    let recased: Vec<String> = INSTALL_KEYS
        .iter()
        .filter_map(|wanted| {
            let actual = full
                .keys()
                .map(|key| key.to_string_lossy().into_owned())
                .find(|key| key.eq_ignore_ascii_case(wanted) && key != wanted)?;
            (!full.contains_key(&OsString::from(*wanted)))
                .then(|| format!("{wanted} (here {actual})"))
        })
        .collect();
    let report = format!(
        "allowlist keys present only under another casing: {recased:?}\ndropped variables: {:?}",
        dropped
            .iter()
            .map(|key| key.to_string_lossy())
            .collect::<Vec<_>>()
    );
    (dropped, report)
}

/// The install shape with the allowlist plus `extra` variables from `full`, with a short bound.
async fn streams_with(full: &BTreeMap<OsString, OsString>, extra: &[OsString]) -> (bool, String) {
    let mut shape = Shape::install("Write-Output x");
    for key in extra {
        shape.env.insert(key.clone(), full[key].clone());
    }
    let (stdout, report) = run(&shape, Duration::from_secs(8)).await;
    (stdout.contains('x'), report)
}

/// Bisects the dropped variables for one whose addition lets the install shape stream.
async fn bisect(full: &BTreeMap<OsString, OsString>, dropped: Vec<OsString>) -> String {
    let mut steps = Vec::new();
    let (all, report) = streams_with(full, &dropped).await;
    steps.push(format!(
        "allowlist + all {} dropped: {report}",
        dropped.len()
    ));
    if !all {
        return steps.join("\n");
    }
    let mut candidates = dropped;
    while candidates.len() > 1 {
        let half = candidates.split_off(candidates.len() / 2);
        let (first, report) = streams_with(full, &candidates).await;
        let names: Vec<_> = candidates.iter().map(|key| key.to_string_lossy()).collect();
        steps.push(format!("allowlist + {names:?}: {report}"));
        if !first {
            candidates = half;
        }
    }
    let (single, report) = streams_with(full, &candidates).await;
    steps.push(format!(
        "allowlist + {:?} alone streams={single}: {report}",
        candidates.first().map(|key| key.to_string_lossy())
    ));
    steps.join("\n")
}

#[tokio::test(flavor = "current_thread")]
async fn powershell_streams_stdout_under_the_install_request_shape() {
    let (stdout, report) = run(&Shape::install("Write-Output x"), Duration::from_secs(15)).await;
    if stdout.contains('x') {
        return;
    }
    let full: BTreeMap<OsString, OsString> = std::env::vars_os().collect();
    let (dropped, names) = allowlist_report(&full);
    let search = bisect(&full, dropped).await;
    panic!(
        "expected a PowerShell recipe child to stream stdout \"x\" under the install request \
         shape | received none.\n{report}\n{names}\nsearch:\n{search}"
    );
}
