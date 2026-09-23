//! Safe command lines for Windows batch files (`.bat` / `.cmd`).
//!
//! `CreateProcessW` runs a batch file through `cmd.exe`, which does not parse the MSVC quoting
//! every other child receives: `\"` is not an escape to it, and `&`, `|`, `<`, `>`, `^`, `(`, `)`
//! outside quotes are command syntax (BatBadBut, CVE-2024-24576). A batch target therefore gets
//! its own command line, modelled on the Rust standard library's batch handling:
//! `cmd.exe /e:ON /v:OFF /d /c ""<script>" "<arg>" ..."`, with the interpreter named by full
//! path from the child's own `SystemRoot` (never a search that could find a planted `cmd.exe`),
//! every argument quoted, and delayed expansion off so `!` is literal.
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
    /// # Example
    /// ```ignore
    /// let launch = BatchLaunch::new(&request)?;
    /// assert!(launch.command_line.starts_with("cmd.exe /e:ON /v:OFF /d /c \"\""));
    /// ```
    pub(crate) fn new(request: &ProcessRequest) -> io::Result<Self> {
        let root = system_root(request.env.as_ref()).ok_or_else(|| {
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

fn system_root(env: Option<&BTreeMap<OsString, OsString>>) -> Option<String> {
    env?.iter()
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
        let launch = BatchLaunch::new(&request(
            r"C:\Program Files\nodejs\npx.cmd",
            &[
                "-y",
                "a&b|c<d>e^f(g)",
                "has space",
                "",
                "!bang!",
                r"C:\dir\",
            ],
        ))
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

    #[test]
    fn arguments_cmd_exe_cannot_quote_are_refused_not_escaped() {
        for (argument, named) in [
            (r#"x" & calc & ""#, r#"'"'"#),
            ("%PATH%", "'%'"),
            ("a\r\nb", r"'\r'"),
            ("a\nb", r"'\n'"),
        ] {
            let error = BatchLaunch::new(&request(r"C:\n\npx.cmd", &["ok", argument]))
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
        let error = BatchLaunch::new(&bare).expect_err("expected SystemRoot required");
        assert!(
            error
                .to_string()
                .contains("expected an environment that carries SystemRoot")
        );
        let error = BatchLaunch::new(&request(r"C:\n\dir\", &[])).expect_err("trailing slash");
        assert!(error.to_string().contains("cannot be quoted for cmd.exe"));
    }
}
