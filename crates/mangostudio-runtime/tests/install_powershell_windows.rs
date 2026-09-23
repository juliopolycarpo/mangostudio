//! Windows install recipes run `powershell`, so a PowerShell child must stream stdout through the
//! supervisor under the exact request shape `install.run` builds: a bare `powershell` resolved by
//! `CreateProcessW`, the install environment allowlist, a null stdin, the runtime's own cwd, a
//! zero capture cap, and an output tap.
//!
//! When the install shape fails, the assertion reports a matrix that changes one factor at a time
//! against it, up to the request `shell.run` builds (which CI has shown to stream), so a failure
//! on a Windows runner names the factor that matters.
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

mod support;

use support::scratch::scratch_dir;

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

fn powershell_path() -> PathBuf {
    PathBuf::from(std::env::var_os("SystemRoot").expect("Windows defines SystemRoot"))
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe")
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
async fn run(shape: &Shape) -> (String, String) {
    let (tap, mut chunks) = ProcessOutputTap::channel(64);
    let mut request = ProcessRequest::new(&shape.program, shape.args.clone())
        .with_stdin(shape.stdin.clone())
        .with_budget(ProcessBudget::new(
            Duration::from_secs(15),
            shape.cap,
            shape.cap,
        ));
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

/// One factor changed at a time from the install shape, ending at `shell.run`'s request.
fn variants(directory: &std::path::Path) -> Vec<Shape> {
    let base = Shape::install("Write-Output x");
    let full: BTreeMap<OsString, OsString> = std::env::vars_os().collect();
    let script = directory.join("installer.ps1");
    std::fs::write(&script, "Write-Output 'x'\r\n").expect("script is written");
    let mut shapes = Vec::new();
    let mut push = |label, change: &dyn Fn(&mut Shape)| {
        let mut shape = base.clone();
        shape.label = label;
        change(&mut shape);
        shapes.push(shape);
    };
    push("-File script", &|shape| {
        shape.args = vec![
            "-NoProfile".into(),
            "-NonInteractive".into(),
            "-ExecutionPolicy".into(),
            "Bypass".into(),
            "-File".into(),
            script.to_string_lossy().into_owned(),
        ];
    });
    push("[Console]::Out.Write", &|shape| {
        shape.args[3] = "[Console]::Out.Write('x')".into();
    });
    push("absolute powershell.exe", &|shape| {
        shape.program = powershell_path();
    });
    push("full environment", &|shape| shape.env = full.clone());
    push("explicit cwd", &|shape| {
        shape.cwd = Some(directory.to_path_buf());
    });
    push("capture instead of tap", &|shape| {
        shape.tap = false;
        shape.cap = 4096;
    });
    push("byte stdin", &|shape| {
        shape.stdin = ProcessStdin::Bytes(b"input\r\n".to_vec());
    });
    push("shell.run shape", &|shape| {
        shape.program = powershell_path();
        shape.args[3] = "[Console]::Out.Write('x')".into();
        shape.env = full.clone();
        shape.cwd = Some(directory.to_path_buf());
        shape.tap = false;
        shape.cap = 4096;
    });
    push("shell.run shape with Write-Output", &|shape| {
        shape.program = powershell_path();
        shape.env = full.clone();
        shape.cwd = Some(directory.to_path_buf());
        shape.tap = false;
        shape.cap = 4096;
    });
    shapes
}

#[tokio::test(flavor = "current_thread")]
async fn powershell_streams_stdout_under_the_install_request_shape() {
    let directory = scratch_dir("install-powershell-windows");
    let (stdout, report) = run(&Shape::install("Write-Output x")).await;
    if stdout.contains('x') {
        return;
    }
    let mut matrix = vec![report];
    for shape in variants(&directory) {
        matrix.push(run(&shape).await.1);
    }
    panic!(
        "expected a PowerShell recipe child to stream stdout \"x\" under the install request \
         shape | received none. One factor at a time:\n{}",
        matrix.join("\n")
    );
}
