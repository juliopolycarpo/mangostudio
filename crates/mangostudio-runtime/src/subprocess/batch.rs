//! Safe command lines for Windows batch files (`.bat` / `.cmd`).
//!
//! `CreateProcessW` runs a batch file through `cmd.exe`, which does not parse the MSVC quoting
//! every other child receives: `\"` is not an escape to it, and `&`, `|`, `<`, `>`, `^`, `(`, `)`
//! outside quotes are command syntax (BatBadBut, CVE-2024-24576). A batch target therefore gets
//! its own command line, modelled on the Rust standard library's batch handling:
//! `cmd.exe /e:ON /v:OFF /d /c ""<script>" "<arg>" ..."`, with the interpreter named by full
//! path from the child's own `SystemRoot` (never a search that could find a planted `cmd.exe`),
//! every argument quoted, and delayed expansion off so `!` is literal. A request that inherits
//! the runtime's environment uses the runtime's own Windows directory, which is that child's
//! `SystemRoot`.
//!
//! Characters that cannot be carried safely inside a cmd.exe quoted string are refused rather
//! than escaped: `"` would end the quoting, `%` is expanded even inside quotes, and CR/LF end
//! the command. A refused argument never reaches a shell.
//!
//! The module is platform-neutral so its rules are tested on every host; only the Windows Job
//! spawner calls it.

use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};
use std::io;
use std::path::{Path, PathBuf};

use super::ProcessRequest;

/// Characters a batch-file argument may not contain, with the reason each is refused.
const REFUSED: [(char, &str); 5] = [
    ('"', "a double quote would end cmd.exe's quoting"),
    ('%', "cmd.exe expands % even inside quotes"),
    ('\r', "a carriage return ends the cmd.exe command"),
    ('\n', "a line feed ends the cmd.exe command"),
    ('\0', "a NUL cannot cross a Windows command line"),
];

/// Whether `program` names a batch file (`.bat` or `.cmd`, any case).
///
/// # Example
/// ```ignore
/// assert!(is_batch(Path::new(r"C:\tools\npx.CMD")));
/// ```
pub(crate) fn is_batch(program: &Path) -> bool {
    program
        .extension()
        .and_then(OsStr::to_str)
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("bat") || extension.eq_ignore_ascii_case("cmd")
        })
}

/// The interpreter path and command line for launching a batch file.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct BatchLaunch {
    pub interpreter: PathBuf,
    pub command_line: String,
}

impl BatchLaunch {
    /// Builds the `cmd.exe` launch for `request`, whose program is a batch file.
    ///
    /// `inherited_windows_directory` is the runtime's own Windows directory, used only when the
    /// request inherits the environment (`request.env` is `None`).
    ///
    /// # Example
    /// ```ignore
    /// let launch = BatchLaunch::new(&request, None)?;
    /// assert!(launch.command_line.starts_with("cmd.exe /e:ON /v:OFF /d /c \"\""));
    /// ```
    pub(crate) fn new(
        request: &ProcessRequest,
        inherited_windows_directory: Option<&str>,
    ) -> io::Result<Self> {
        let root = interpreter_root(request, inherited_windows_directory).ok_or_else(|| {
            invalid(
                "a batch file needs SystemRoot in the child environment to locate cmd.exe; \
                 expected an environment that carries SystemRoot"
                    .to_owned(),
            )
        })?;
        let script = unicode(request.program.as_os_str(), "the batch file path")?;
        if script.contains('"') || script.ends_with('\\') {
            return Err(invalid(format!(
                "batch file path {script:?} cannot be quoted for cmd.exe; expected a path \
                 without '\"' that does not end in '\\'"
            )));
        }
        let mut command_line = format!("cmd.exe /e:ON /v:OFF /d /c \"\"{script}\"");
        for (index, argument) in request.args.iter().enumerate() {
            let argument = unicode(argument, &format!("argument {index}"))?;
            if let Some((character, reason)) = REFUSED
                .iter()
                .find(|(character, _)| argument.contains(*character))
            {
                return Err(invalid(format!(
                    "argument {index} contains {character:?}, which a batch-file program cannot \
                     receive safely ({reason}); expected an argument without '\"', '%', CR, LF \
                     or NUL"
                )));
            }
            // Trailing backslashes are doubled so the program's own (MSVC) argument parser does
            // not read the closing quote as escaped; nothing else inside the quotes is special.
            let trailing = argument.len() - argument.trim_end_matches('\\').len();
            command_line.push_str(" \"");
            command_line.push_str(argument);
            command_line.push_str(&"\\".repeat(trailing));
            command_line.push('"');
        }
        command_line.push('"');
        Ok(Self {
            interpreter: PathBuf::from(format!(
                "{}\\System32\\cmd.exe",
                root.trim_end_matches(['\\', '/'])
            )),
            command_line,
        })
    }
}

/// The Windows directory an interpreter for `request` is found under: the exact environment's
/// `SystemRoot`, or, for a request that inherits the runtime's environment, the runtime's own
/// Windows directory. An exact environment without `SystemRoot` has none; it is never filled in
/// from the runtime.
///
/// # Example
/// ```ignore
/// assert_eq!(interpreter_root(&inheriting, Some(r"C:\Windows")).as_deref(), Some(r"C:\Windows"));
/// ```
pub(super) fn interpreter_root(
    request: &ProcessRequest,
    inherited_windows_directory: Option<&str>,
) -> Option<String> {
    match request.env.as_ref() {
        Some(env) => system_root(env),
        None => inherited_windows_directory
            .filter(|value| !value.is_empty())
            .map(str::to_owned),
    }
}

fn system_root(env: &BTreeMap<OsString, OsString>) -> Option<String> {
    env.iter()
        .find(|(key, _)| {
            key.to_str()
                .is_some_and(|key| key.eq_ignore_ascii_case("SystemRoot"))
        })
        .and_then(|(_, value)| value.to_str())
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn unicode<'a>(value: &'a OsStr, what: &str) -> io::Result<&'a str> {
    value.to_str().ok_or_else(|| {
        invalid(format!(
            "{what} is not valid Unicode; expected Unicode text for a batch-file command line"
        ))
    })
}

fn invalid(message: String) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(program: &str, args: &[&str]) -> ProcessRequest {
        let mut request = ProcessRequest::new(program, args.iter().copied());
        request.env = Some(BTreeMap::from([(
            OsString::from("SYSTEMROOT"),
            OsString::from(r"C:\Windows"),
        )]));
        request
    }

    #[test]
    fn only_bat_and_cmd_extensions_are_batch_files() {
        for batch in [r"C:\n\npx.cmd", r"C:\n\RUN.BAT", "x.Cmd"] {
            assert!(
                is_batch(Path::new(batch)),
                "expected {batch} to be a batch file"
            );
        }
        for other in [r"C:\n\node.exe", "npx", "tool.cmd.exe"] {
            assert!(
                !is_batch(Path::new(other)),
                "expected {other} not to be a batch file"
            );
        }
    }

    #[test]
    fn every_argument_is_quoted_so_shell_syntax_stays_literal() {
        let launch = BatchLaunch::new(
            &request(
                r"C:\Program Files\nodejs\npx.cmd",
                &[
                    "-y",
                    "a&b|c<d>e^f(g)",
                    "has space",
                    "",
                    "!bang!",
                    r"C:\dir\",
                ],
            ),
            None,
        )
        .expect("these arguments are safe");
        assert_eq!(
            launch.interpreter,
            PathBuf::from(r"C:\Windows\System32\cmd.exe")
        );
        assert_eq!(
            launch.command_line,
            r#"cmd.exe /e:ON /v:OFF /d /c ""C:\Program Files\nodejs\npx.cmd" "-y" "a&b|c<d>e^f(g)" "has space" "" "!bang!" "C:\dir\\"""#
        );
    }

    /// Regression: a probe inherits the runtime's environment, so it has no exact `SystemRoot`;
    /// refusing it made every `.cmd` vendor shim (Cursor's `agent.cmd`) look not installed.
    #[test]
    fn an_inherited_environment_uses_the_runtimes_windows_directory() {
        let mut inheriting = request(r"C:\c\agent.cmd", &["--version"]);
        inheriting.env = None;
        let launch = BatchLaunch::new(&inheriting, Some(r"D:\Win"))
            .expect("the inherited Windows directory locates cmd.exe");
        assert_eq!(
            launch.interpreter,
            PathBuf::from(r"D:\Win\System32\cmd.exe"),
            "expected the runtime's Windows directory | received: {:?}",
            launch.interpreter
        );
    }

    #[test]
    fn arguments_cmd_exe_cannot_quote_are_refused_not_escaped() {
        for (argument, named) in [
            (r#"x" & calc & ""#, r#"'"'"#),
            ("%PATH%", "'%'"),
            ("a\r\nb", r"'\r'"),
            ("a\nb", r"'\n'"),
        ] {
            let error = BatchLaunch::new(&request(r"C:\n\npx.cmd", &["ok", argument]), None)
                .expect_err("expected the argument refused");
            let message = error.to_string();
            assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
            assert!(
                message.contains("argument 1 contains") && message.contains(named),
                "expected the refusal to name the argument and {named} | received {message}"
            );
        }
    }

    #[test]
    fn a_batch_file_without_system_root_or_with_an_unquotable_path_is_refused() {
        let mut bare = request(r"C:\n\npx.cmd", &[]);
        bare.env = None;
        let error = BatchLaunch::new(&bare, None).expect_err("expected SystemRoot required");
        assert!(
            error
                .to_string()
                .contains("expected an environment that carries SystemRoot")
        );
        let mut exact_without_root = request(r"C:\n\npx.cmd", &[]);
        exact_without_root.env = Some(BTreeMap::new());
        assert!(
            BatchLaunch::new(&exact_without_root, Some(r"C:\Windows")).is_err(),
            "expected an exact environment without SystemRoot refused, not filled in"
        );
        let error =
            BatchLaunch::new(&request(r"C:\n\dir\", &[]), None).expect_err("trailing slash");
        assert!(error.to_string().contains("cannot be quoted for cmd.exe"));
    }
}
