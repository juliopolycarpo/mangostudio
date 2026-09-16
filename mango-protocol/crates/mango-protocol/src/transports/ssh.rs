//! The hardened `ssh` argv preset of `spec/transports/spawn.md`, and the exit
//! classifier that goes with it.
//!
//! Both functions are pure: they build an argv and read an exit status.
//! Nothing here starts a process, so a caller can unit-test its launch command
//! — and `spec/fixtures/1/ssh-argv.json` holds the corpus both SDKs build the
//! same argv from.

use std::fmt;

use super::spawn::{ExitStatus, last_non_empty_line, signal_name};

/// Reference connect timeout of the preset.
pub const DEFAULT_CONNECT_TIMEOUT_SECONDS: u32 = 10;

const PORT_MIN: u16 = 1;

/// `ssh` reports every failure of its own with this status, whatever caused it.
const SSH_OWN_FAILURE: i32 = 255;

/// A POSIX login shell says this when it cannot find the command.
const COMMAND_NOT_FOUND: i32 = 127;

/// What a launch over the system `ssh` client is pointed at.
///
/// # Example
///
/// ```
/// use mango_protocol::transports::ssh::SshArgv;
///
/// let options = SshArgv::new("build-box", ["mango-runtime", "--stdio"]);
/// assert_eq!(options.host, "build-box");
/// ```
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshArgv {
    /// The host to reach. Never begins with `-`.
    pub host: String,
    /// The remote account, when it is not the local one.
    pub user: Option<String>,
    /// The remote port, when it is not 22.
    ///
    /// A port is a `u16` by definition, so one above the range is refused by
    /// the type rather than by [`ssh_argv`]. That is why
    /// `spec/fixtures/1/ssh-argv.json`'s `n_port_above_the_range` cannot be
    /// built here at all: a stronger refusal than the runtime one the
    /// TypeScript SDK has to make, since JavaScript has no integer types to
    /// refuse it with.
    pub port: Option<u16>,
    /// A private key to use, and only that key.
    pub identity_file: Option<String>,
    /// The remote path first, its arguments after.
    pub command: Vec<String>,
    /// How long `ssh` may spend connecting.
    pub connect_timeout_seconds: u32,
}

impl SshArgv {
    /// The preset pointed at `host`, running `command` there.
    ///
    /// # Example
    ///
    /// ```
    /// use mango_protocol::transports::ssh::SshArgv;
    ///
    /// let options = SshArgv::new("build-box", ["mango-runtime"]);
    /// assert_eq!(options.connect_timeout_seconds, 10);
    /// ```
    #[must_use]
    pub fn new<I, S>(host: impl Into<String>, command: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Self {
            host: host.into(),
            user: None,
            port: None,
            identity_file: None,
            command: command.into_iter().map(Into::into).collect(),
            connect_timeout_seconds: DEFAULT_CONNECT_TIMEOUT_SECONDS,
        }
    }

    /// Logs in as `user` rather than the local account.
    ///
    /// # Example
    ///
    /// ```
    /// use mango_protocol::transports::ssh::SshArgv;
    ///
    /// let options = SshArgv::new("build-box", ["mango-runtime"]).with_user("deploy");
    /// assert_eq!(options.user.as_deref(), Some("deploy"));
    /// ```
    #[must_use]
    pub fn with_user(mut self, user: impl Into<String>) -> Self {
        self.user = Some(user.into());
        self
    }

    /// Connects to `port` rather than 22.
    ///
    /// # Example
    ///
    /// ```
    /// use mango_protocol::transports::ssh::SshArgv;
    ///
    /// let options = SshArgv::new("build-box", ["mango-runtime"]).with_port(2222);
    /// assert_eq!(options.port, Some(2222));
    /// ```
    ///
    /// A port above the range is not a value this can be given:
    ///
    /// ```compile_fail
    /// use mango_protocol::transports::ssh::SshArgv;
    ///
    /// SshArgv::new("build-box", ["mango-runtime"]).with_port(65_536);
    /// ```
    #[must_use]
    pub fn with_port(mut self, port: u16) -> Self {
        self.port = Some(port);
        self
    }

    /// Offers this key, and refuses to fall back on the agent's own.
    ///
    /// # Example
    ///
    /// ```
    /// use mango_protocol::transports::ssh::SshArgv;
    ///
    /// let options =
    ///     SshArgv::new("build-box", ["mango-runtime"]).with_identity_file("~/.ssh/id_ed25519");
    /// assert!(options.identity_file.is_some());
    /// ```
    #[must_use]
    pub fn with_identity_file(mut self, identity_file: impl Into<String>) -> Self {
        self.identity_file = Some(identity_file.into());
        self
    }

    /// Bounds how long `ssh` may spend connecting.
    ///
    /// # Example
    ///
    /// ```
    /// use mango_protocol::transports::ssh::SshArgv;
    ///
    /// let options = SshArgv::new("build-box", ["mango-runtime"]).with_connect_timeout_seconds(20);
    /// assert_eq!(options.connect_timeout_seconds, 20);
    /// ```
    #[must_use]
    pub fn with_connect_timeout_seconds(mut self, seconds: u32) -> Self {
        self.connect_timeout_seconds = seconds;
        self
    }
}

/// Which part of an [`SshArgv`] could not become a command line.
///
/// The names match `spec/fixtures/1/ssh-argv.json`'s `reason`, so both SDKs
/// refuse the same inputs for the same stated reason.
///
/// # Example
///
/// ```
/// use mango_protocol::transports::ssh::{SshArgv, SshArgvError, ssh_argv};
///
/// let refused = ssh_argv(&SshArgv::new("-oProxyCommand=touch /tmp/x", ["x"]))
///     .expect_err("a host that could become an option");
/// assert_eq!(refused.reason(), "host");
/// ```
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum SshArgvError {
    /// A host that is empty, has whitespace, or could become an option.
    Host(String),
    /// A user that is empty, has whitespace, or could become an option.
    User(String),
    /// A port of 0 — the one value a `u16` allows that no endpoint can name.
    Port(u16),
    /// A connect timeout under one second.
    ConnectTimeoutSeconds(u32),
    /// No remote path to run.
    Command(Vec<String>),
}

impl SshArgvError {
    /// The field this refusal is about, spelled as the fixture corpus spells
    /// it.
    ///
    /// # Example
    ///
    /// ```
    /// use mango_protocol::transports::ssh::SshArgvError;
    ///
    /// assert_eq!(SshArgvError::Port(0).reason(), "port");
    /// ```
    #[must_use]
    pub const fn reason(&self) -> &'static str {
        match self {
            Self::Host(_) => "host",
            Self::User(_) => "user",
            Self::Port(_) => "port",
            Self::ConnectTimeoutSeconds(_) => "connectTimeoutSeconds",
            Self::Command(_) => "command",
        }
    }
}

impl fmt::Display for SshArgvError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Host(host) => write!(
                formatter,
                "ssh host is {host:?}; expected a non-empty host name without whitespace and not beginning with \"-\""
            ),
            Self::User(user) => write!(
                formatter,
                "ssh user is {user:?}; expected a non-empty user name without whitespace and not beginning with \"-\""
            ),
            Self::Port(port) => write!(
                formatter,
                "ssh port is {port}; expected a port of at least {PORT_MIN}"
            ),
            Self::ConnectTimeoutSeconds(seconds) => write!(
                formatter,
                "ssh connectTimeoutSeconds is {seconds}; expected an integer of at least 1 second"
            ),
            Self::Command(command) => write!(
                formatter,
                "ssh command is {command:?}; expected [remotePath, ...remoteArgs] with a non-empty remote path"
            ),
        }
    }
}

impl std::error::Error for SshArgvError {}

/// The argv for launching a peer over the system `ssh` client, with every
/// option spawn.md calls load-bearing.
///
/// # Example
///
/// ```
/// use mango_protocol::transports::ssh::{SshArgv, ssh_argv};
///
/// let argv = ssh_argv(&SshArgv::new("build-box", ["mango-runtime", "--stdio"]))
///     .expect("a reachable host and a remote path");
/// assert_eq!(argv[0], "ssh");
/// assert_eq!(&argv[argv.len() - 3..], ["build-box", "'mango-runtime'", "'--stdio'"]);
/// ```
///
/// # Errors
///
/// [`SshArgvError`] for a host, user, port, timeout or command the preset
/// refuses — the same inputs `spec/fixtures/1/ssh-argv.json` marks `reject`.
pub fn ssh_argv(options: &SshArgv) -> Result<Vec<String>, SshArgvError> {
    let host = checked_host(&options.host)?;
    let user = options.user.as_deref().map(checked_user).transpose()?;
    let connect_timeout = checked_timeout(options.connect_timeout_seconds)?;
    let (remote_path, remote_args) = checked_command(&options.command)?;
    let port = options.port.map(checked_port).transpose()?;

    let mut argv: Vec<String> = [
        "ssh",
        // Nothing on this side can answer a prompt: a connection that would
        // ask must fail rather than hang until the handshake times out.
        "-o",
        "BatchMode=yes",
        "-o",
        &format!("ConnectTimeout={connect_timeout}"),
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=3",
        // Set explicitly: the first trust decision belongs to a person at a
        // terminal.
        "-o",
        "StrictHostKeyChecking=yes",
        // Multiplexing is unsupported on Windows OpenSSH, and ambient
        // configuration could otherwise enable it under a long-lived pipe.
        "-o",
        "ControlMaster=no",
        "-o",
        "ControlPath=none",
        // An ambient `RemoteCommand` in the user's ssh config collides with
        // the command placed after the destination ("Cannot execute
        // command-line and remote command."), so it is forced off the same way
        // multiplexing is.
        "-o",
        "RemoteCommand=none",
    ]
    .iter()
    .map(|word| (*word).to_owned())
    .collect();

    if let Some(identity_file) = &options.identity_file {
        argv.push("-o".to_owned());
        argv.push("IdentitiesOnly=yes".to_owned());
        argv.push("-i".to_owned());
        argv.push(identity_file.clone());
    }
    if let Some(port) = port {
        argv.push("-p".to_owned());
        argv.push(port.to_string());
    }
    // `-T` because stdout carries frames a tty would translate, `--` so a host
    // spelled like an option cannot become one.
    argv.push("-T".to_owned());
    argv.push("--".to_owned());
    argv.push(match user {
        Some(user) => format!("{user}@{host}"),
        None => host.to_owned(),
    });
    // ssh joins everything after the destination with spaces and hands it to
    // the target's login shell, so every word is quoted for that shell.
    argv.push(quote_remote_path(remote_path));
    argv.extend(remote_args.iter().map(|argument| single_quote(argument)));
    Ok(argv)
}

/// One sentence naming what an `ssh` exit status means, for the message a
/// launcher shows when a remote peer never completed the handshake.
///
/// # Example
///
/// ```
/// use mango_protocol::transports::spawn::ExitStatus;
/// use mango_protocol::transports::ssh::classify_ssh_exit;
///
/// let status = ExitStatus { code: Some(255), signal: None };
/// let message = classify_ssh_exit(status, "ssh: connect to host x port 22: timed out");
/// assert!(message.contains("its own failure"));
/// ```
#[must_use]
pub fn classify_ssh_exit(status: ExitStatus, stderr_tail: &str) -> String {
    if status.code == Some(SSH_OWN_FAILURE) {
        let suffix = last_non_empty_line(stderr_tail)
            .map(|detail| format!(": {detail}"))
            .unwrap_or_default();
        return format!(
            "ssh exited 255, its own failure (connection, authentication or host key), not a status from the remote command{suffix}."
        );
    }
    if status.code == Some(COMMAND_NOT_FOUND) {
        return "ssh exited 127: the remote login shell could not find the command; check the remote path and the PATH of a non-interactive shell.".to_owned();
    }
    if let Some(signal) = status.signal {
        let name =
            signal_name(signal).map_or_else(|| format!("signal {signal}"), ToOwned::to_owned);
        return format!("ssh was killed by {name} before the remote command reported a status.");
    }
    match status.code {
        None => "ssh ended without an exit status, so the launcher could not observe how the remote command finished.".to_owned(),
        Some(code) => format!("ssh exited {code}, which is the status the remote command returned."),
    }
}

fn checked_host(host: &str) -> Result<&str, SshArgvError> {
    if host.is_empty() || host.starts_with('-') || host.chars().any(char::is_whitespace) {
        return Err(SshArgvError::Host(host.to_owned()));
    }
    Ok(host)
}

fn checked_user(user: &str) -> Result<&str, SshArgvError> {
    if user.is_empty() || user.starts_with('-') || user.chars().any(char::is_whitespace) {
        return Err(SshArgvError::User(user.to_owned()));
    }
    Ok(user)
}

fn checked_port(port: u16) -> Result<u16, SshArgvError> {
    if port < PORT_MIN {
        return Err(SshArgvError::Port(port));
    }
    Ok(port)
}

fn checked_timeout(seconds: u32) -> Result<u32, SshArgvError> {
    if seconds < 1 {
        return Err(SshArgvError::ConnectTimeoutSeconds(seconds));
    }
    Ok(seconds)
}

fn checked_command(command: &[String]) -> Result<(&str, &[String]), SshArgvError> {
    match command.split_first() {
        Some((remote_path, rest)) if !remote_path.is_empty() => Ok((remote_path, rest)),
        _ => Err(SshArgvError::Command(command.to_vec())),
    }
}

/// The remote path, quoted for the target's login shell. A leading `~/` stays
/// outside the quotes so the shell still expands it.
fn quote_remote_path(remote_path: &str) -> String {
    match remote_path.strip_prefix("~/") {
        Some(rest) => format!("~/{}", single_quote(rest)),
        None => single_quote(remote_path),
    }
}

/// POSIX single quoting: everything is literal, and a quote closes and
/// reopens.
fn single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::{SshArgv, classify_ssh_exit, quote_remote_path, ssh_argv};
    use crate::transports::spawn::ExitStatus;

    #[test]
    fn every_option_spawn_md_calls_load_bearing_is_present() {
        let argv = ssh_argv(&SshArgv::new("build-box", ["mango-runtime"])).expect("a valid preset");
        for option in [
            "BatchMode=yes",
            "ConnectTimeout=10",
            "ServerAliveInterval=15",
            "ServerAliveCountMax=3",
            "StrictHostKeyChecking=yes",
            "ControlMaster=no",
            "ControlPath=none",
            "RemoteCommand=none",
        ] {
            assert!(argv.iter().any(|word| word == option), "missing {option}");
        }
        assert!(argv.contains(&"-T".to_owned()));
        assert!(argv.contains(&"--".to_owned()));
    }

    #[test]
    fn the_identity_file_comes_with_identities_only_and_before_the_port() {
        let argv = ssh_argv(
            &SshArgv::new("build-box", ["mango-runtime"])
                .with_port(2222)
                .with_identity_file("/home/u/.ssh/id_ed25519"),
        )
        .expect("a valid preset");
        let identity = argv
            .iter()
            .position(|word| word == "IdentitiesOnly=yes")
            .expect("IdentitiesOnly is set");
        let port = argv
            .iter()
            .position(|word| word == "-p")
            .expect("the port is set");
        assert!(identity < port, "{argv:?}");
    }

    #[test]
    fn a_port_of_zero_is_refused_and_says_what_was_expected() {
        // 0 is the whole of this check, because it is the one value a `u16`
        // allows that no endpoint can name. The corpus's other port case,
        // `n_port_above_the_range`, is refused by the type instead — the
        // `compile_fail` example on `with_port` is what proves that, and
        // `fixtures_ssh_argv.rs` names it as excluded for the same reason.
        let error = ssh_argv(&SshArgv::new("build-box", ["mango-runtime"]).with_port(0))
            .expect_err("a port of zero is refused");

        assert_eq!(error.reason(), "port");
        assert_eq!(
            error.to_string(),
            "ssh port is 0; expected a port of at least 1"
        );
    }

    #[test]
    fn a_leading_tilde_stays_outside_the_quotes() {
        assert_eq!(quote_remote_path("~/bin/runtime"), "~/'bin/runtime'");
        assert_eq!(quote_remote_path("/opt/runtime"), "'/opt/runtime'");
        assert_eq!(quote_remote_path("it's"), "'it'\\''s'");
    }

    #[test]
    fn ssh_own_failure_is_named_apart_from_a_remote_status() {
        let status = ExitStatus {
            code: Some(255),
            signal: None,
        };
        assert_eq!(
            classify_ssh_exit(
                status,
                "ssh: Warning\nssh: connect to host build-box port 22: Connection timed out\n\n"
            ),
            "ssh exited 255, its own failure (connection, authentication or host key), not a status from the remote command: ssh: connect to host build-box port 22: Connection timed out."
        );
        assert_eq!(
            classify_ssh_exit(status, "   \n"),
            "ssh exited 255, its own failure (connection, authentication or host key), not a status from the remote command."
        );
    }

    #[test]
    fn the_other_statuses_say_what_they_mean() {
        assert!(
            classify_ssh_exit(
                ExitStatus {
                    code: Some(127),
                    signal: None
                },
                "bash: mango: command not found"
            )
            .contains("could not find the command")
        );
        assert_eq!(
            classify_ssh_exit(
                ExitStatus {
                    code: None,
                    signal: Some(9)
                },
                ""
            ),
            "ssh was killed by SIGKILL before the remote command reported a status."
        );
        assert!(
            classify_ssh_exit(ExitStatus::default(), "")
                .contains("could not observe how the remote command finished")
        );
        assert_eq!(
            classify_ssh_exit(
                ExitStatus {
                    code: Some(3),
                    signal: None
                },
                "ignored"
            ),
            "ssh exited 3, which is the status the remote command returned."
        );
    }
}
