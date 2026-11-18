//! Finding an executable on a `PATH` value, shared by shell detection, the terminal, `git`
//! probing and the toolchain commands.
//!
//! This is machine probing, not configuration: [`which_in`] reads the machine's `PATHEXT` on
//! Windows to learn which extensions make a file runnable, at the site that needs it (AGENTS.md
//! names the carve-out and `tests/config_boundary.rs` pins the call).

use std::path::{Path, PathBuf};

use mangostudio_runtime_contract::manifest::RuntimeShellKind;

/// PATH candidates for a shell kind on a host, mirroring
/// `apps/shared/src/process/host.ts`'s `resolveShellExecutable`: `bash`/`zsh`
/// resolve their own name; `powershell` is Windows-only and tries `pwsh`
/// first, then `powershell`. An empty slice means the kind is never offered.
///
/// The one rule shared by shell detection (which feeds
/// `hello.capabilities.shells` and `runtime.health.shells`) and `shell.run`
/// acceptance, so the advertised list can never include a shell `shell.run`
/// refuses. `windows_host` is `cfg!(windows)` for detection and the
/// described host's platform for execution.
///
/// ```
/// use mangostudio_runtime_contract::manifest::RuntimeShellKind;
/// use mangostudio_runtime_core::executable_path::shell_path_candidates;
///
/// assert!(shell_path_candidates(RuntimeShellKind::Powershell, false).is_empty());
/// assert_eq!(shell_path_candidates(RuntimeShellKind::Powershell, true), ["pwsh", "powershell"]);
/// ```
#[must_use]
pub fn shell_path_candidates(
    kind: RuntimeShellKind,
    windows_host: bool,
) -> &'static [&'static str] {
    match kind {
        RuntimeShellKind::Bash => &["bash"],
        RuntimeShellKind::Zsh => &["zsh"],
        RuntimeShellKind::Powershell if windows_host => &["pwsh", "powershell"],
        RuntimeShellKind::Powershell => &[],
    }
}

/// Resolves `name` against an explicit `PATH` value, checking (on Unix)
/// that it is actually executable rather than merely present — mirrors
/// `Bun.which`'s own check. On Windows there is no execute bit, so the
/// name must instead carry an executable extension: see
/// `windows_executable_names`. Never reads the real `PATH`. Tests can
/// supply a temporary search directory without mutating the process-wide
/// `PATH`; on Windows the process's `PATHEXT` still applies, because it
/// describes the machine rather than the caller's search directories.
///
/// Returns `dir.join(name)` as found, never canonicalised: two `PATH`
/// entries that reach the same real file through a symlink or a `..`
/// segment resolve to two different [`PathBuf`]s here, and so to two
/// different `git` probe cache keys for what is, on disk, one binary. A
/// changed `PATH` ordering that starts naming the same binary through its
/// other spelling re-probes rather than reusing an already-cached answer —
/// wasted work, not a correctness bug (the fresh probe still reports the
/// truth), and one `PATH` layouts that reorder such entries are rare
/// enough in practice that resolving every candidate has not been worth
/// its own `std::fs::canonicalize` call on this walk's hot path.
#[must_use]
pub fn which_in(name: &str, path_var: &std::ffi::OsStr) -> Option<PathBuf> {
    let names = if cfg!(windows) {
        windows_executable_names(name, std::env::var_os("PATHEXT").as_deref())
    } else {
        vec![name.to_owned()]
    };
    first_executable_in(&names, path_var)
}

/// Walks `path_var` in order and returns the first directory entry named in
/// `names` that is an executable file. Within one directory, `names` is tried
/// in order, so an earlier `PATHEXT` extension wins over a later one there,
/// but a hit in an earlier directory always beats any name in a later one.
fn first_executable_in(names: &[String], path_var: &std::ffi::OsStr) -> Option<PathBuf> {
    std::env::split_paths(path_var).find_map(|dir| {
        names
            .iter()
            .map(|name| dir.join(name))
            .find(|candidate| is_executable_file(candidate))
    })
}

/// `PATHEXT` as Windows documents its default, used when the variable is unset
/// or empty.
const DEFAULT_WINDOWS_PATHEXT: &str = ".COM;.EXE;.BAT;.CMD";

/// The file names a Windows shell would try for `name`, in order. Pure, so
/// it is tested on every host.
///
/// Windows has no execute bit, so the extension is what makes a file
/// runnable: a `name` that already ends in a `PATHEXT` extension (compared
/// case-insensitively) is tried as written, and every other `name` gets each
/// extension appended. A bare extensionless `name` is never a candidate, so a
/// POSIX-style script called `gh` cannot shadow a later `gh.exe`.
///
/// Appended extensions are lowercased. Windows matches them case-insensitively
/// either way, and `PATHEXT` spells them in upper case by default, so the
/// returned path reads `gh.exe` as installers name the file, not `gh.EXE`.
fn windows_executable_names(name: &str, pathext: Option<&std::ffi::OsStr>) -> Vec<String> {
    let pathext = pathext.map(|value| value.to_string_lossy());
    let pathext = pathext
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(DEFAULT_WINDOWS_PATHEXT);
    let extensions = pathext
        .split(';')
        .map(str::trim)
        .filter(|extension| extension.len() > 1 && extension.starts_with('.'))
        .collect::<Vec<_>>();
    let lowercase_name = name.to_ascii_lowercase();
    if extensions
        .iter()
        .any(|extension| lowercase_name.ends_with(&extension.to_ascii_lowercase()))
    {
        return vec![name.to_owned()];
    }
    extensions
        .iter()
        .map(|extension| format!("{name}{}", extension.to_ascii_lowercase()))
        .collect()
}

/// Checks a concrete path before trying to execute it, such as `/usr/bin/git`.
#[must_use]
pub fn is_executable_file(path: &Path) -> bool {
    std::fs::metadata(path)
        .is_ok_and(|metadata| metadata.is_file() && has_execute_permission(&metadata))
}

/// Whether any execute bit is set in a file's mode.
#[cfg(unix)]
fn has_execute_permission(metadata: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    metadata.permissions().mode() & 0o111 != 0
}

/// Windows has no execute bit: any regular file may be started.
#[cfg(not(unix))]
fn has_execute_permission(_metadata: &std::fs::Metadata) -> bool {
    true
}

#[cfg(test)]
mod tests {
    use mangostudio_runtime_contract::manifest::RuntimeShellKind;

    use crate::test_support::scratch_dir;

    /// The shared rule offers PowerShell only on a Windows host.
    #[test]
    fn shell_path_candidates_offers_powershell_only_on_windows() {
        use super::shell_path_candidates;

        let off = shell_path_candidates(RuntimeShellKind::Powershell, false);
        assert!(
            off.is_empty(),
            "expected powershell candidates off Windows: [] | received: {off:?}"
        );
        let on = shell_path_candidates(RuntimeShellKind::Powershell, true);
        assert_eq!(
            on,
            ["pwsh", "powershell"],
            "expected powershell candidates on Windows: [pwsh, powershell] | received: {on:?}"
        );
    }

    #[test]
    fn an_executable_file_is_a_regular_file_the_platform_can_start() {
        let dir = scratch_dir("executable-file");
        let file = dir.join("tool");
        std::fs::write(&file, "").unwrap();
        let missing = dir.join("missing");
        assert!(
            !super::is_executable_file(&missing),
            "expected a missing path to be refused | received executable: {}",
            missing.display()
        );
        let directory = std::path::Path::new(dir.as_os_str());
        assert!(
            !super::is_executable_file(directory),
            "expected a directory to be refused | received executable: {}",
            directory.display()
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for (mode, expected) in [(0o644, false), (0o755, true), (0o001, true)] {
                std::fs::set_permissions(&file, std::fs::Permissions::from_mode(mode)).unwrap();
                assert_eq!(
                    super::is_executable_file(&file),
                    expected,
                    "expected mode {mode:o} to be executable: {expected}"
                );
            }
        }
        #[cfg(not(unix))]
        assert!(
            super::is_executable_file(&file),
            "expected a regular file to be executable on a platform without execute bits"
        );
    }

    #[test]
    fn windows_executable_names_follow_pathext() {
        use std::ffi::OsStr;

        let cases: [(&str, Option<&str>, &[&str]); 8] = [
            // Unset and empty fall back to Windows' own default list.
            ("gh", None, &["gh.com", "gh.exe", "gh.bat", "gh.cmd"]),
            ("gh", Some(""), &["gh.com", "gh.exe", "gh.bat", "gh.cmd"]),
            ("gh", Some("  "), &["gh.com", "gh.exe", "gh.bat", "gh.cmd"]),
            // The variable's own order wins, appended in lower case; blanks and non-extensions
            // drop out.
            ("gh", Some(".CMD; .exe;;.;bad"), &["gh.cmd", "gh.exe"]),
            // A name that already ends in a listed extension is tried as written, in any case.
            ("gh.exe", Some(".COM;.EXE"), &["gh.exe"]),
            ("GH.Cmd", Some(".EXE;.cmd"), &["GH.Cmd"]),
            // A dot that is not a listed extension does not make the name runnable.
            (
                "python3.12",
                Some(".EXE;.CMD"),
                &["python3.12.exe", "python3.12.cmd"],
            ),
            ("gh.exe", Some(".CMD"), &["gh.exe.cmd"]),
        ];
        for (name, pathext, expected) in cases {
            let received = super::windows_executable_names(name, pathext.map(OsStr::new));
            assert_eq!(
                received, expected,
                "(windows_executable_names): expected names for {name:?} with PATHEXT {pathext:?}: {expected:?} | received: {received:?}"
            );
        }
    }

    /// The `gh.exe`-behind-an-extensionless-`gh` layout from the bug report, walked with the
    /// names a Windows host would try. Unix execute bits stand in for Windows' lack of them.
    #[cfg(unix)]
    #[test]
    fn executable_walk_skips_an_extensionless_file_for_a_later_pathext_match() {
        use std::os::unix::fs::PermissionsExt;

        let root = scratch_dir("pathext-walk");
        let (first, second, third) = (root.join("first"), root.join("second"), root.join("third"));
        for dir in [&first, &second, &third] {
            std::fs::create_dir_all(dir).unwrap();
        }
        for file in [
            first.join("gh"),
            second.join("gh.exe"),
            second.join("gh.cmd"),
            third.join("gh.bat"),
        ] {
            std::fs::write(&file, "").unwrap();
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let path_var = std::env::join_paths([&first, &second, &third]).unwrap();

        // `.cmd` is listed first, so within `second` it beats `gh.exe`; `first`'s bare `gh` is
        // never a candidate.
        let names = super::windows_executable_names("gh", Some(".cmd;.exe".as_ref()));
        assert_eq!(
            super::first_executable_in(&names, &path_var),
            Some(second.join("gh.cmd")),
            "(first_executable_in): expected the .cmd shim in the second directory"
        );
        let names = super::windows_executable_names("gh", Some(".bat".as_ref()));
        assert_eq!(
            super::first_executable_in(&names, &path_var),
            Some(third.join("gh.bat")),
            "(first_executable_in): expected the .bat shim in the third directory"
        );
        let names = super::windows_executable_names("gh", Some(".com".as_ref()));
        assert_eq!(
            super::first_executable_in(&names, &path_var),
            None,
            "(first_executable_in): expected no match for a PATHEXT no file carries"
        );
    }
}
