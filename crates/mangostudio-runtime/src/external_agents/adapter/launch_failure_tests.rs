//! Discovery over the real guarded launcher and a real file on `PATH`.
//!
//! The SDK's three harnesses read an `Error::Launch` from their version probe as "not installed",
//! and this runtime's launcher raises `Error::Launch` for every OS spawn failure. A vendor CLI that
//! is on `PATH` but cannot be executed must therefore not come back as a descriptor that tells the
//! user to install it: it is a refused launch (installed, nothing else known), and the OS error is
//! logged. Unix only: Windows resolves a bare program name through `PATHEXT`, so a plain file without an executable
//! extension is never a candidate there and the same setup is a missing program, not a refused one.
#![cfg(unix)]

use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::backend::{Backend, ProductHarnesses};
use super::launcher::GuardedProcessLauncher;
use super::test_support::{host, limits};
use crate::diagnostics::DiagnosticSink;
use crate::external_agents::port::AgentBackend;
use crate::external_agents::wire::{DiscoveryState, RemedyKind, TargetId, UnavailableReason};
use crate::subprocess::AlwaysAllow;
use crate::test_support::scratch_dir;
use mangostudio_runtime_contract::errors::EXTERNAL_AGENT_DISCOVERY_LAUNCH_REFUSED_CODE;

/// Every target the runtime discovers: each launches its bare program name when the host resolved
/// no executable path.
const TARGETS: [TargetId; 3] = [TargetId::Claude, TargetId::Codex, TargetId::Cursor];

/// Keeps the diagnostic lines a backend wrote, instead of printing them to stderr.
#[derive(Default)]
struct RecordingDiagnostics(Mutex<Vec<String>>);

impl DiagnosticSink for RecordingDiagnostics {
    fn write_line(&self, line: &str) {
        self.0.lock().unwrap().push(line.to_owned());
    }
}

impl RecordingDiagnostics {
    fn lines(&self) -> Vec<String> {
        self.0.lock().unwrap().clone()
    }
}

/// A backend over the production launcher and harnesses: only the filesystem is fixture.
fn production_backend(diagnostics: &Arc<RecordingDiagnostics>) -> Arc<Backend> {
    let limits = limits();
    Arc::new(
        Backend::new(
            Arc::new(GuardedProcessLauncher::new(Arc::new(AlwaysAllow), &limits)),
            Arc::new(ProductHarnesses),
            limits,
            Duration::from_secs(2),
        )
        .with_diagnostics(Arc::clone(diagnostics) as Arc<dyn DiagnosticSink>),
    )
}

/// What one discovery produced, reduced to the facts the assertions name.
#[derive(Debug, PartialEq, Eq)]
enum Discovered {
    /// A descriptor that says the CLI is not installed, with the install remedy.
    NotInstalled,
    /// A descriptor that says the CLI is installed and was refused by the operating system: no
    /// unavailable reason and no remedy on the wire (a released hub rejects a reason it does not
    /// know), and the `launch-refused` code on the discovery report.
    LaunchRefused,
    /// Anything else, as the descriptor's own facts.
    Other(String),
    /// A failure on the wire.
    Failure(String),
}

/// Discovers `target` with `bin` as the only `PATH` entry and no resolved executable path, so the
/// harness launches the bare program name and the guardian searches `PATH` itself.
async fn discover(backend: &Backend, target: TargetId, bin: &Path, cwd: &Path) -> Discovered {
    let mut launch = host(cwd.to_path_buf());
    launch
        .environment
        .insert("PATH".to_owned(), bin.display().to_string());
    let outcome = tokio::time::timeout(
        Duration::from_secs(30),
        backend.discover(target, None, launch, None),
    )
    .await
    .unwrap_or_else(|_| panic!("expected {target:?} discovery within 30s | received a hung probe"));
    match outcome {
        Err(failure) => Discovered::Failure(format!("{:?}", failure.into_remote())),
        Ok(descriptor) => {
            let remedy_install = descriptor
                .remedy
                .as_ref()
                .is_some_and(|remedy| remedy.kind == RemedyKind::Install);
            let failure_code = descriptor.discovery.and_then(|report| report.failure_code);
            match (
                descriptor.installed,
                descriptor.discovery_state,
                descriptor.unavailable_reason,
                failure_code,
            ) {
                (
                    false,
                    DiscoveryState::Determined,
                    Some(UnavailableReason::NotInstalled),
                    None,
                ) if remedy_install => Discovered::NotInstalled,
                (true, DiscoveryState::Undetermined, None, Some(code))
                    if code == EXTERNAL_AGENT_DISCOVERY_LAUNCH_REFUSED_CODE
                        && descriptor.remedy.is_none() =>
                {
                    Discovered::LaunchRefused
                }
                _ => Discovered::Other(format!(
                    "installed {} state {:?} reason {:?} remedy {:?} failureCode {:?}",
                    descriptor.installed,
                    descriptor.discovery_state,
                    descriptor.unavailable_reason,
                    descriptor.remedy,
                    failure_code
                )),
            }
        }
    }
}

/// A file the kernel refuses to execute: a script body, but no execute bit.
fn write_without_exec_bit(bin: &Path, program: &str) {
    let path = bin.join(program);
    std::fs::write(&path, "#!/bin/sh\nexit 0\n").expect("write the fixture program");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644))
        .expect("clear the execute bits of the fixture program");
}

/// The program each target launches by bare name.
fn program_of(target: TargetId) -> &'static str {
    match target {
        TargetId::Claude => "claude",
        TargetId::Codex => "codex",
        TargetId::Cursor => "cursor-agent",
    }
}

/// Asserts that a non-executable CLI on `PATH` is a refused launch, with the OS error in
/// the operator log and nothing of the filesystem layout in it.
async fn assert_non_executable_is_a_refused_launch(target: TargetId) {
    let diagnostics = Arc::new(RecordingDiagnostics::default());
    let bin = scratch_dir("launch-failure-bin");
    let cwd = scratch_dir("launch-failure-cwd");
    write_without_exec_bit(bin.path(), program_of(target));

    let found = discover(
        &production_backend(&diagnostics),
        target,
        bin.path(),
        cwd.path(),
    )
    .await;

    assert_eq!(
        found,
        Discovered::LaunchRefused,
        "({target:?} discovery): expected a launch-refused descriptor for a \
         non-executable `{}` on PATH | received {found:?}",
        program_of(target)
    );
    let lines = diagnostics.lines();
    assert!(
        matches!(lines.as_slice(), [line]
            if line.contains("external_agent_launch_refused")
                && line.contains("\"level\":\"warn\"")
                && line.contains(&format!("\"target\":\"{}\"", target.as_str()))
                && line.contains("Permission denied (os error 13)")
                && !line.contains(&bin.path().display().to_string())),
        "({target:?} discovery): expected one warn line naming the target and the OS error, \
         without the PATH directory | received {lines:?}"
    );
}

#[tokio::test]
async fn a_non_executable_claude_on_path_is_a_refused_launch_not_not_installed() {
    assert_non_executable_is_a_refused_launch(TargetId::Claude).await;
}

#[tokio::test]
async fn a_non_executable_codex_on_path_is_a_refused_launch_not_not_installed() {
    assert_non_executable_is_a_refused_launch(TargetId::Codex).await;
}

#[tokio::test]
async fn a_non_executable_cursor_agent_on_path_is_a_refused_launch_not_not_installed() {
    assert_non_executable_is_a_refused_launch(TargetId::Cursor).await;
}

#[tokio::test]
async fn a_vendor_cli_missing_from_path_is_still_not_installed() {
    for target in TARGETS {
        let diagnostics = Arc::new(RecordingDiagnostics::default());
        let bin = scratch_dir("launch-missing-bin");
        let cwd = scratch_dir("launch-missing-cwd");

        let found = discover(
            &production_backend(&diagnostics),
            target,
            bin.path(),
            cwd.path(),
        )
        .await;

        assert_eq!(
            found,
            Discovered::NotInstalled,
            "({target:?} discovery): expected a not-installed descriptor for an empty PATH \
             directory | received {found:?}"
        );
        assert!(
            diagnostics.lines().is_empty(),
            "({target:?} discovery): expected no diagnostic for a missing program | \
             received {:?}",
            diagnostics.lines()
        );
    }
}

#[tokio::test]
async fn a_missing_working_directory_is_not_a_missing_program() {
    let diagnostics = Arc::new(RecordingDiagnostics::default());
    let bin = scratch_dir("launch-cwd-bin");
    let parent = scratch_dir("launch-cwd-parent");
    let gone = parent.path().join("removed");

    let found = discover(
        &production_backend(&diagnostics),
        TargetId::Claude,
        bin.path(),
        &gone,
    )
    .await;

    assert_eq!(
        found,
        Discovered::LaunchRefused,
        "expected a missing cwd to read as a refused launch, not not-installed | \
         received {found:?}"
    );
    let lines = diagnostics.lines();
    assert!(
        matches!(lines.as_slice(), [line]
            if line.contains("external_agent_launch_refused")
                && line.contains("\"target\":\"claude\"")
                && line.contains("No such file or directory (os error 2)")),
        "expected exactly one external_agent_launch_refused line naming ENOENT | \
         received {lines:?}"
    );
}

/// Restores a directory's mode on drop so the scratch cleanup can remove it.
struct Unsearchable(std::path::PathBuf);

impl Drop for Unsearchable {
    fn drop(&mut self) {
        let _ = std::fs::set_permissions(&self.0, std::fs::Permissions::from_mode(0o755));
    }
}

/// An unsearchable `PATH` entry is the OS refusing to look, not a program it found. With the CLI
/// installed nowhere else, execve reports EACCES for it all the same, so only the evidence that a
/// candidate exists makes the failure a refusal.
#[tokio::test]
async fn an_unsearchable_path_entry_with_the_cli_nowhere_is_still_not_installed() {
    // Root ignores directory modes, so the entry would stay searchable and the setup would
    // prove nothing.
    if nix::unistd::geteuid().is_root() {
        eprintln!("skipped: running as root, directory modes do not restrict root");
        return;
    }
    for target in TARGETS {
        let diagnostics = Arc::new(RecordingDiagnostics::default());
        let parent = scratch_dir("launch-sealed-parent");
        let sealed = parent.path().join("sealed");
        std::fs::create_dir(&sealed).expect("mkdir the sealed PATH entry");
        std::fs::set_permissions(&sealed, std::fs::Permissions::from_mode(0o000))
            .expect("seal the PATH entry");
        let _restore = Unsearchable(sealed.clone());
        let cwd = scratch_dir("launch-sealed-cwd");

        let found = discover(
            &production_backend(&diagnostics),
            target,
            &sealed,
            cwd.path(),
        )
        .await;

        assert_eq!(
            found,
            Discovered::NotInstalled,
            "({target:?} discovery): expected a not-installed descriptor when the only PATH \
             entry is unsearchable and holds no candidate | received {found:?}"
        );
        assert!(
            diagnostics.lines().is_empty(),
            "({target:?} discovery): expected no diagnostic for a CLI installed nowhere | \
             received {:?}",
            diagnostics.lines()
        );
    }
}

/// A refusal recorded for one target must not reach a target discovered at the same time, nor a
/// discovery that runs afterwards on the same backend.
#[tokio::test]
async fn a_refusal_never_leaks_into_another_target_or_a_later_discovery() {
    let diagnostics = Arc::new(RecordingDiagnostics::default());
    let backend = production_backend(&diagnostics);
    let refused_bin = scratch_dir("launch-leak-refused");
    let empty_bin = scratch_dir("launch-leak-empty");
    let cwd = scratch_dir("launch-leak-cwd");
    write_without_exec_bit(refused_bin.path(), "claude");
    write_without_exec_bit(refused_bin.path(), "cursor-agent");

    let mut batch = tokio::task::JoinSet::new();
    for (target, bin) in [
        (TargetId::Claude, refused_bin.path().to_path_buf()),
        (TargetId::Codex, empty_bin.path().to_path_buf()),
        (TargetId::Cursor, refused_bin.path().to_path_buf()),
    ] {
        let backend = Arc::clone(&backend);
        let cwd = cwd.path().to_path_buf();
        batch.spawn(async move { (target, discover(&backend, target, &bin, &cwd).await) });
    }
    let mut together = Vec::new();
    while let Some(joined) = batch.join_next().await {
        together.push(joined.expect("a discovery task"));
    }
    together.sort_by_key(|(target, _)| target.as_str());
    let later = discover(&backend, TargetId::Codex, empty_bin.path(), cwd.path()).await;

    assert_eq!(
        (together, later),
        (
            vec![
                (TargetId::Claude, Discovered::LaunchRefused),
                (TargetId::Codex, Discovered::NotInstalled),
                (TargetId::Cursor, Discovered::LaunchRefused),
            ],
            Discovered::NotInstalled
        ),
        "expected each target to keep its own answer, and a later codex discovery to stay \
         not-installed"
    );
    assert_eq!(
        diagnostics.lines().len(),
        2,
        "expected one warn line per refused target | received {:?}",
        diagnostics.lines()
    );
}
