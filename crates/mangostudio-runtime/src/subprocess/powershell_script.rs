//! Launches for Windows PowerShell script entry points (`.ps1`).
//!
//! `CreateProcessW` cannot run a `.ps1`: it is not an executable image and, unlike a batch file,
//! no interpreter is implied. Some vendor CLIs install only a script (Cursor's Windows installer
//! lays down `%LOCALAPPDATA%\cursor-agent\cursor-agent.ps1`), so a script target is rewritten into
//! the same invocation the vendor's own `.cmd` shim uses:
//! `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <script> ...`.
//!
//! - The interpreter is named by full path under the child's own `SystemRoot` (or the Windows
//!   directory the runtime inherits, for a request that inherits the environment), never found
//!   by a search that could reach a planted `powershell.exe`.
//! - `-File` passes every later argument to the script as a literal string; nothing is parsed as
//!   PowerShell command text.
//! - The script path must be absolute. A relative one would resolve against the child's working
//!   directory, which for an agent is the workspace it was pointed at.
//! - `-ExecutionPolicy Bypass` applies to this process only and matches Cursor's own shim; a
//!   machine or user Group Policy still takes precedence over it.
//!
//! The rewrite returns an ordinary request for `powershell.exe`, so the Job containment, the
//! exact environment and the hidden window of the original request carry over unchanged. The
//! module is platform-neutral so its rules are tested on every host; only the Windows Job spawner
//! calls it.

use std::ffi::{OsStr, OsString};
use std::io;
use std::path::{Path, PathBuf};

use super::ProcessRequest;

/// The `powershell.exe` switches placed ahead of `-File <script>`.
const POWERSHELL_SWITCHES: [&str; 5] = [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
];

/// Whether `program` names a PowerShell script (`.ps1`, any case).
///
/// # Example
/// ```ignore
/// assert!(is_powershell_script(Path::new(r"C:\tools\cursor-agent.PS1")));
/// ```
pub(crate) fn is_powershell_script(program: &Path) -> bool {
    program
        .extension()
        .and_then(OsStr::to_str)
        .is_some_and(|extension| extension.eq_ignore_ascii_case("ps1"))
}

/// Rewrites `request`, whose program is a `.ps1`, into the request that runs it under Windows
/// PowerShell.
///
/// `inherited_windows_directory` is the runtime's own Windows directory, used only when
/// `request.env` is `None` (the child inherits the runtime's environment, so the runtime's
/// Windows directory is the child's `SystemRoot`).
///
/// # Example
/// ```ignore
/// let launch = powershell_script_request(&request, None)?;
/// assert_eq!(launch.args[5], "-File");
/// ```
pub(crate) fn powershell_script_request(
    request: &ProcessRequest,
    inherited_windows_directory: Option<&str>,
) -> io::Result<ProcessRequest> {
    let root =
        super::batch::interpreter_root(request, inherited_windows_directory).ok_or_else(|| {
            invalid(
                "a PowerShell script needs SystemRoot in the child environment to locate \
                 powershell.exe; expected an environment that carries SystemRoot"
                    .to_owned(),
            )
        })?;
    if !is_windows_absolute(request.program.as_os_str()) {
        return Err(invalid(format!(
            "PowerShell script path {:?} is not absolute; expected a full path such as \
             C:\\tools\\cursor-agent.ps1, so the script cannot resolve against the working \
             directory",
            request.program
        )));
    }
    let mut launch = request.clone();
    launch.program = PathBuf::from(format!(
        "{}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        root.trim_end_matches(['\\', '/'])
    ));
    launch.args = POWERSHELL_SWITCHES
        .iter()
        .map(OsString::from)
        .chain([OsString::from("-File"), request.program.clone().into()])
        .chain(request.args.iter().cloned())
        .collect();
    Ok(launch)
}

/// A drive-absolute (`C:\...`, `C:/...`) or UNC (`\\server\...`) path, judged by its text so the
/// rule is the same on every host.
fn is_windows_absolute(program: &OsStr) -> bool {
    let Some(text) = program.to_str() else {
        return false;
    };
    let bytes = text.as_bytes();
    let drive = bytes.len() > 2
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'\\' | b'/');
    drive || text.starts_with(r"\\")
}

fn invalid(message: String) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;

    fn request(program: &str, args: &[&str]) -> ProcessRequest {
        let mut request = ProcessRequest::new(program, args.iter().copied());
        request.env = Some(BTreeMap::from([
            (OsString::from("SYSTEMROOT"), OsString::from(r"C:\Windows")),
            (OsString::from("PATH"), OsString::from(r"C:\tools")),
        ]));
        request.cwd = Some(PathBuf::from(r"C:\workspace"));
        request
    }

    #[test]
    fn only_the_ps1_extension_is_a_powershell_script() {
        for script in [r"C:\c\cursor-agent.ps1", r"C:\c\AGENT.PS1", "x.Ps1"] {
            assert!(
                is_powershell_script(Path::new(script)),
                "expected {script} to be a PowerShell script"
            );
        }
        for other in [
            r"C:\c\agent.cmd",
            r"C:\c\agent.exe",
            "agent",
            "agent.ps1.exe",
        ] {
            assert!(
                !is_powershell_script(Path::new(other)),
                "expected {other} not to be a PowerShell script"
            );
        }
    }

    #[test]
    fn a_script_runs_under_the_system_powershell_with_its_arguments_literal() {
        let original = request(
            r"C:\Users\me\AppData\Local\cursor-agent\cursor-agent.ps1",
            &["acp", "literal $(Get-Date); & text", "has space"],
        );
        let launch = powershell_script_request(&original, None).expect("a valid script launch");
        assert_eq!(
            launch.program,
            PathBuf::from(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe")
        );
        let expected: Vec<OsString> = [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            r"C:\Users\me\AppData\Local\cursor-agent\cursor-agent.ps1",
            "acp",
            "literal $(Get-Date); & text",
            "has space",
        ]
        .into_iter()
        .map(OsString::from)
        .collect();
        assert_eq!(
            launch.args, expected,
            "expected argv: {expected:?} | received: {:?}",
            launch.args
        );
        assert_eq!(
            launch.env, original.env,
            "the exact environment carries over"
        );
        assert_eq!(launch.cwd, original.cwd);
        assert!(launch.hide_window, "expected the window to stay hidden");
    }

    #[test]
    fn an_inherited_environment_uses_the_runtimes_windows_directory() {
        let mut original = request(r"C:\c\cursor-agent.ps1", &["--version"]);
        original.env = None;
        let launch = powershell_script_request(&original, Some(r"D:\Win\"))
            .expect("the inherited Windows directory locates the interpreter");
        assert_eq!(
            launch.program,
            PathBuf::from(r"D:\Win\System32\WindowsPowerShell\v1.0\powershell.exe")
        );
        let error = powershell_script_request(&original, None)
            .expect_err("expected no interpreter without a Windows directory");
        assert!(
            error
                .to_string()
                .contains("expected an environment that carries SystemRoot"),
            "expected the SystemRoot refusal | received: {error}"
        );
    }

    #[test]
    fn an_exact_environment_without_system_root_is_refused_not_filled_in() {
        let mut original = request(r"C:\c\cursor-agent.ps1", &[]);
        original.env = Some(BTreeMap::from([(
            OsString::from("PATH"),
            OsString::from(r"C:\tools"),
        )]));
        let error = powershell_script_request(&original, Some(r"C:\Windows"))
            .expect_err("expected SystemRoot required from the exact environment");
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
    }

    #[test]
    fn a_relative_script_path_is_refused() {
        for relative in [
            "cursor-agent.ps1",
            r"tools\cursor-agent.ps1",
            r"\c\agent.ps1",
        ] {
            let error = powershell_script_request(&request(relative, &[]), None)
                .expect_err("expected a relative script refused");
            assert!(
                error.to_string().contains("is not absolute"),
                "expected {relative} refused as not absolute | received: {error}"
            );
        }
        for absolute in [
            r"C:\c\agent.ps1",
            "C:/c/agent.ps1",
            r"\\server\share\agent.ps1",
        ] {
            assert!(
                powershell_script_request(&request(absolute, &[]), None).is_ok(),
                "expected {absolute} accepted as absolute"
            );
        }
    }
}
