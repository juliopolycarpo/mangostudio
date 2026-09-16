//! The spawn launcher of `spec/transports/spawn.md`: start a child process
//! and speak [stdio](super::stdio) through its pipes. SSH, WSL and container
//! launches are this transport with a different argv in front.
//!
//! The launcher observes and reports; it never guesses why a child failed. It
//! exposes the exit status, a bounded tail of stderr and a termination
//! sequence, and leaves the classification to the caller — see
//! [`super::ssh::classify_ssh_exit`] for what a wrapper that knows more does
//! with those observations.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fmt;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::AsyncReadExt;
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{mpsc, watch};

use crate::frame::Frame;
use crate::port::{Inbound, Port, PortRx, PortTx, SendOutcome};

use super::ndjson::{NdjsonPort, NdjsonRx, NdjsonTx};

/// Reference size of the stderr tail a launcher keeps (spawn.md, Launching).
pub const DEFAULT_STDERR_TAIL_BYTES: usize = 16 * 1024;

/// Reference grace periods of the termination sequence (spawn.md, Termination).
pub const DEFAULT_TERMINATE_GRACE: Duration = Duration::from_secs(2);
/// How long `SIGTERM` has to work before `SIGKILL`.
pub const DEFAULT_KILL_GRACE: Duration = Duration::from_secs(2);
/// How long [`LaunchedPeer::terminate`] waits for the exit once `SIGKILL` has
/// been sent, before giving up (spawn.md, Termination step 4).
pub const DEFAULT_EXIT_GRACE: Duration = Duration::from_secs(2);

/// How long [`LaunchedPeer::start_error`] waits for an exit that has not
/// landed yet.
pub const DEFAULT_START_ERROR_GRACE: Duration = Duration::from_millis(250);

/// Variables a child is allowed to inherit (spawn.md, Launching).
const ENV_ALLOWLIST: [&str; 11] = [
    "PATH",
    "HOME",
    "USERPROFILE",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "TMPDIR",
    "LANG",
    "TERM",
    "SHELL",
    "XDG_RUNTIME_DIR",
];

/// Locale variables are a family, not a fixed list.
const LOCALE_PREFIX: &str = "LC_";

/// Secret-shaped names, stripped even when they survived the allowlist.
const SECRET_SUFFIXES: [&str; 3] = ["_TOKEN", "_SECRET", "_KEY"];
const SECRET_SUBSTRING: &str = "PASSWORD";

/// What a launcher hands every chunk of the child's stderr to, on top of the
/// bounded tail it always keeps.
pub type StderrReader = Arc<dyn Fn(&[u8]) + Send + Sync>;

/// How the child ended: an exit code, or the signal that killed it.
///
/// # Example
///
/// ```
/// use mango_protocol::transports::spawn::ExitStatus;
///
/// let clean = ExitStatus { code: Some(0), signal: None };
/// assert_eq!(clean.to_string(), "exit status 0");
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ExitStatus {
    /// The status the child returned, when it returned one.
    pub code: Option<i32>,
    /// The POSIX signal that killed it, when one did. Always `None` on
    /// Windows, which has no signals.
    pub signal: Option<i32>,
}

impl fmt::Display for ExitStatus {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match (self.code, self.signal) {
            (Some(code), _) => write!(formatter, "exit status {code}"),
            (None, Some(signal)) => match signal_name(signal) {
                Some(name) => write!(formatter, "killed by {name}"),
                None => write!(formatter, "killed by signal {signal}"),
            },
            (None, None) => formatter.write_str("no exit status at all"),
        }
    }
}

/// The name of a signal a launcher may see, for a message an operator reads.
///
/// # Example
///
/// ```
/// use mango_protocol::transports::spawn::signal_name;
///
/// assert_eq!(signal_name(9), Some("SIGKILL"));
/// assert_eq!(signal_name(64), None);
/// ```
#[must_use]
pub const fn signal_name(signal: i32) -> Option<&'static str> {
    match signal {
        1 => Some("SIGHUP"),
        2 => Some("SIGINT"),
        3 => Some("SIGQUIT"),
        6 => Some("SIGABRT"),
        9 => Some("SIGKILL"),
        13 => Some("SIGPIPE"),
        15 => Some("SIGTERM"),
        _ => None,
    }
}

/// What a launch that never reached a handshake left behind, in the one shape
/// a caller needs to say why: the child's status, whether it ever became a
/// process, and the last thing it said.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct SpawnStartError {
    /// How the child ended, or `None` when the exit had not landed inside the
    /// grace. The pipes closing and the exit are not ordered, so "not known
    /// yet" is a state of its own rather than an exit with no code.
    pub exit: Option<ExitStatus>,
    /// Why the command never became a process — [`std::io::ErrorKind::NotFound`]
    /// for spawn.md's `ENOENT`, [`std::io::ErrorKind::PermissionDenied`] for
    /// its `EACCES` — and `None` whenever a child was created, however badly
    /// it then behaved. A remote shell that prints `ENOENT` for its own
    /// reasons never lands here: this is the launcher's own observation, not a
    /// reading of the child's bytes.
    pub spawn_error: Option<std::io::ErrorKind>,
    /// Last non-empty line of the stderr tail; empty when the child said
    /// nothing.
    pub stderr_line: String,
}

/// An argv that could not name a command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpawnArgvError {
    argv: Vec<String>,
}

impl fmt::Display for SpawnArgvError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "spawn argv is {:?}; expected [command, ...args] with a non-empty command",
            self.argv
        )
    }
}

impl std::error::Error for SpawnArgvError {}

/// How a child is launched.
///
/// # Example
///
/// ```
/// use mango_protocol::transports::spawn::SpawnOptions;
///
/// let options = SpawnOptions::new(["mango-runtime", "--stdio"]);
/// assert!(options.windows_hide);
/// ```
pub struct SpawnOptions {
    /// The command and its arguments. Never a shell string: arguments that
    /// come from configuration or from a user stay data at every layer.
    pub argv: Vec<String>,
    /// The child's working directory; this process's when absent.
    pub cwd: Option<PathBuf>,
    /// The child's whole environment. [`sanitized_env`] when absent.
    pub env: Option<BTreeMap<String, String>>,
    /// Largest line the port's decoder accepts; the 16 MiB default of §11
    /// when absent.
    pub max_frame_bytes: Option<usize>,
    /// How much of the child's stderr to keep for an error report.
    pub stderr_tail_bytes: usize,
    /// How long end of stdin has to work before `SIGTERM`.
    pub terminate_grace: Duration,
    /// How long `SIGTERM` has to work before `SIGKILL`.
    pub kill_grace: Duration,
    /// How long [`LaunchedPeer::terminate`] waits for the exit once `SIGKILL`
    /// has been sent, before giving up and resolving `None`. A child stuck in
    /// `D` state, or a process whose kill did not take, may never exit at
    /// all — this bounds the wait so a shutdown awaiting `terminate` is
    /// delayed but never blocked forever. [`LaunchedPeer::exited`] is
    /// unaffected: it keeps waiting for the real exit.
    pub exit_grace: Duration,
    /// Called with every stderr chunk, for a launcher that streams
    /// diagnostics on as it reads them.
    pub on_stderr: Option<StderrReader>,
    /// Hide the child's console window on Windows. A peer that speaks NDJSON
    /// on stdio has nothing to show, and a wrapper launched through a console
    /// host would otherwise flash a window at whoever is watching.
    pub windows_hide: bool,
}

impl fmt::Debug for SpawnOptions {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SpawnOptions")
            .field("argv", &self.argv)
            .field("cwd", &self.cwd)
            .field("env", &self.env.as_ref().map(BTreeMap::len))
            .field("max_frame_bytes", &self.max_frame_bytes)
            .field("stderr_tail_bytes", &self.stderr_tail_bytes)
            .field("terminate_grace", &self.terminate_grace)
            .field("kill_grace", &self.kill_grace)
            .field("exit_grace", &self.exit_grace)
            .field("on_stderr", &self.on_stderr.is_some())
            .field("windows_hide", &self.windows_hide)
            .finish()
    }
}

impl SpawnOptions {
    /// The reference launch of spawn.md for one argv.
    ///
    /// # Example
    ///
    /// ```
    /// use mango_protocol::transports::spawn::SpawnOptions;
    ///
    /// let options = SpawnOptions::new(["bun", "runtime.ts"]);
    /// assert_eq!(options.argv, ["bun", "runtime.ts"]);
    /// ```
    #[must_use]
    pub fn new<I, S>(argv: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Self {
            argv: argv.into_iter().map(Into::into).collect(),
            cwd: None,
            env: None,
            max_frame_bytes: None,
            stderr_tail_bytes: DEFAULT_STDERR_TAIL_BYTES,
            terminate_grace: DEFAULT_TERMINATE_GRACE,
            kill_grace: DEFAULT_KILL_GRACE,
            exit_grace: DEFAULT_EXIT_GRACE,
            on_stderr: None,
            windows_hide: true,
        }
    }

    /// Runs the child in `cwd`.
    ///
    /// # Example
    ///
    /// ```
    /// use mango_protocol::transports::spawn::SpawnOptions;
    ///
    /// let options = SpawnOptions::new(["mango-runtime"]).with_cwd("/srv/project");
    /// assert!(options.cwd.is_some());
    /// ```
    #[must_use]
    pub fn with_cwd(mut self, cwd: impl Into<PathBuf>) -> Self {
        self.cwd = Some(cwd.into());
        self
    }

    /// Gives the child exactly this environment.
    ///
    /// # Example
    ///
    /// ```
    /// use mango_protocol::transports::spawn::{SpawnOptions, sanitized_env};
    ///
    /// let env = sanitized_env([("MANGO_MODE".to_owned(), "serve".to_owned())]);
    /// let options = SpawnOptions::new(["mango-runtime"]).with_env(env);
    /// assert!(options.env.is_some());
    /// ```
    #[must_use]
    pub fn with_env(mut self, env: BTreeMap<String, String>) -> Self {
        self.env = Some(env);
        self
    }

    /// Sets the frame limit the child's port enforces.
    ///
    /// # Panics
    ///
    /// Panics when `max_frame_bytes` is below
    /// [`crate::codec::ndjson::MIN_MAX_FRAME_BYTES`], naming both.
    ///
    /// # Example
    ///
    /// ```
    /// use mango_protocol::transports::spawn::SpawnOptions;
    ///
    /// let options = SpawnOptions::new(["mango-runtime"]).with_max_frame_bytes(1 << 20);
    /// assert_eq!(options.max_frame_bytes, Some(1 << 20));
    /// ```
    #[must_use]
    pub fn with_max_frame_bytes(mut self, max_frame_bytes: usize) -> Self {
        self.max_frame_bytes = Some(crate::codec::limits::check_max_frame_bytes(max_frame_bytes));
        self
    }

    /// Sets how long [`LaunchedPeer::terminate`] waits for the exit once
    /// `SIGKILL` has been sent, before giving up and resolving `None`.
    ///
    /// # Example
    ///
    /// ```
    /// use std::time::Duration;
    /// use mango_protocol::transports::spawn::SpawnOptions;
    ///
    /// let options = SpawnOptions::new(["mango-runtime"]).with_exit_grace(Duration::from_secs(5));
    /// assert_eq!(options.exit_grace, Duration::from_secs(5));
    /// ```
    #[must_use]
    pub fn with_exit_grace(mut self, exit_grace: Duration) -> Self {
        self.exit_grace = exit_grace;
        self
    }

    /// Streams the child's stderr on as it arrives, on top of the bounded
    /// tail the launcher always keeps.
    ///
    /// # Example
    ///
    /// ```
    /// use std::sync::Arc;
    /// use mango_protocol::transports::spawn::SpawnOptions;
    ///
    /// let options = SpawnOptions::new(["mango-runtime"])
    ///     .with_on_stderr(Arc::new(|chunk: &[u8]| eprint!("{}", String::from_utf8_lossy(chunk))));
    /// assert!(options.on_stderr.is_some());
    /// ```
    #[must_use]
    pub fn with_on_stderr(mut self, on_stderr: StderrReader) -> Self {
        self.on_stderr = Some(on_stderr);
        self
    }
}

/// The environment a launched child inherits: an allowlist of the variables a
/// program needs to run, with secret-shaped names removed, plus whatever the
/// application adds on purpose.
///
/// Names are matched case-insensitively because Windows spells its variables
/// in mixed case (`Path`, `SystemRoot`); the original spelling is what the
/// child receives.
///
/// A variable this process cannot spell as UTF-8 is dropped rather than
/// repaired. POSIX environments are bytes, and a lossy `PATH` is a `PATH` that
/// resolves somewhere else: a child that is told nothing fails visibly, where
/// a child handed a mangled one may run the wrong program. The caller's own
/// entries are unaffected — they are already strings.
///
/// # Example
///
/// ```
/// use mango_protocol::transports::spawn::sanitized_env;
///
/// let env = sanitized_env([("MANGO_TOKEN".to_owned(), "secret".to_owned())]);
/// // The allowlist is read from this process; what the caller adds is kept.
/// assert_eq!(env.get("MANGO_TOKEN").map(String::as_str), Some("secret"));
/// assert!(!env.contains_key("AWS_SECRET_ACCESS_KEY"));
/// ```
#[must_use]
pub fn sanitized_env<I>(extra: I) -> BTreeMap<String, String>
where
    I: IntoIterator<Item = (String, String)>,
{
    sanitized_env_from(utf8_vars(std::env::vars_os()), extra)
}

/// The variables of an environment that can be spelled as UTF-8.
///
/// [`std::env::vars`] would do this by panicking on the first byte sequence
/// that cannot: one unrelated variable, set by something else entirely, would
/// take down a launch that never wanted to read it.
fn utf8_vars<I>(source: I) -> impl Iterator<Item = (String, String)>
where
    I: IntoIterator<Item = (OsString, OsString)>,
{
    source
        .into_iter()
        .filter_map(|(name, value)| Some((name.into_string().ok()?, value.into_string().ok()?)))
}

/// [`sanitized_env`] over an explicit source, so a test can see what the rule
/// keeps without depending on the process it runs in.
///
/// # Example
///
/// ```
/// use mango_protocol::transports::spawn::sanitized_env_from;
///
/// let source = [
///     ("PATH".to_owned(), "/usr/bin".to_owned()),
///     ("AWS_SECRET_ACCESS_KEY".to_owned(), "shh".to_owned()),
///     ("EDITOR".to_owned(), "vi".to_owned()),
/// ];
/// let env = sanitized_env_from(source, []);
/// assert_eq!(env.get("PATH").map(String::as_str), Some("/usr/bin"));
/// assert!(!env.contains_key("AWS_SECRET_ACCESS_KEY"), "secret-shaped");
/// assert!(!env.contains_key("EDITOR"), "not on the allowlist");
/// ```
#[must_use]
pub fn sanitized_env_from<S, E>(source: S, extra: E) -> BTreeMap<String, String>
where
    S: IntoIterator<Item = (String, String)>,
    E: IntoIterator<Item = (String, String)>,
{
    let mut kept = BTreeMap::new();
    for (name, value) in source {
        let upper = name.to_uppercase();
        if !ENV_ALLOWLIST.contains(&upper.as_str()) && !upper.starts_with(LOCALE_PREFIX) {
            continue;
        }
        if is_secret_shaped(&upper) {
            continue;
        }
        kept.insert(name, value);
    }
    kept.extend(extra);
    kept
}

fn is_secret_shaped(upper: &str) -> bool {
    SECRET_SUFFIXES.iter().any(|suffix| upper.ends_with(suffix)) || upper.contains(SECRET_SUBSTRING)
}

/// Starts a child process and speaks stdio through its pipes.
///
/// stdout is the frame stream, stdin is the frame stream in the other
/// direction, and stderr goes to a bounded tail plus
/// [`SpawnOptions::on_stderr`]. A child that cannot start — spawn.md's
/// `ENOENT` and `EACCES` — still produces a port, one that reports its
/// closure straight away; [`LaunchedPeer::start_error`] carries the reason.
///
/// The launcher owns the child's lifetime whichever side ended the port: a
/// refused line or a stdout the child closed ends the session, and a child
/// that then ignores the end of its stdin is still escalated.
///
/// # Example
///
/// ```no_run
/// # #[tokio::main(flavor = "current_thread")]
/// # async fn main() {
/// use mango_protocol::frame::PeerInfo;
/// use mango_protocol::session::{Session, SessionOptions};
/// use mango_protocol::transports::spawn::{SpawnOptions, spawn_port};
///
/// let (port, peer) = spawn_port(SpawnOptions::new(["mango-runtime", "--stdio"]))
///     .expect("an argv naming a command");
/// let identity = PeerInfo { name: "hub".into(), version: "1".into(), role: "hub".into() };
/// let (session, _driver) = Session::spawn(port, SessionOptions::new(identity));
///
/// if session.ready().await.is_err() {
///     let why = peer.start_error(None).await;
///     eprintln!("the runtime never started: {}", why.stderr_line);
/// }
/// // Closing the session ends the child's stdin, which is step 1 of the
/// // termination sequence; `terminate` then waits for the child and escalates
/// // only if it stays.
/// session.close(mango_protocol::close_codes::RELEASED, None).await;
/// peer.terminate().await;
/// # }
/// ```
///
/// # Errors
///
/// [`SpawnArgvError`] when `argv` names no command. Everything else — a
/// command that does not exist, one this user may not run — is reported
/// through the port and [`LaunchedPeer::start_error`], because by then there
/// is a session waiting to be told why it never came up.
///
/// # Panics
///
/// Panics when `options.max_frame_bytes` is `Some` value below
/// [`crate::codec::ndjson::MIN_MAX_FRAME_BYTES`], naming both.
/// [`SpawnOptions::with_max_frame_bytes`] already refuses this on the builder
/// path, but the field is `pub`, so this is the check for a caller that
/// assigned it directly — checked before the command is started, not after,
/// so a sub-floor value never leaves a child running with nothing left to
/// signal it.
pub fn spawn_port(options: SpawnOptions) -> Result<(SpawnPort, LaunchedPeer), SpawnArgvError> {
    if let Some(max_frame_bytes) = options.max_frame_bytes {
        let _ = crate::codec::limits::check_max_frame_bytes(max_frame_bytes);
    }
    let command = match options.argv.first() {
        Some(command) if !command.is_empty() => command.clone(),
        _ => {
            return Err(SpawnArgvError {
                argv: options.argv.clone(),
            });
        }
    };

    let tail = Arc::new(Mutex::new(BoundedTail::new(options.stderr_tail_bytes)));
    let (exit_tx, exit_rx) = watch::channel(None);
    let (kill_tx, kill_rx) = mpsc::unbounded_channel();

    let launch = match start(&command, &options) {
        Ok(child) => child,
        Err(error) => {
            // A command that never became a process: the port reports the
            // closure so a session opened over it fails its handshake with
            // something to say, and the tail carries the launcher's own words.
            append_line(&tail, &format!("{error}"));
            let _ = exit_tx.send(Some(ExitStatus::default()));
            // One terminator for the launch, not one each: the port and the
            // peer run the same sequence, and for a child that never started
            // that sequence is "nothing to escalate against".
            let terminator = Arc::new(Terminator::unspawned());
            let peer = LaunchedPeer {
                pid: None,
                exit: exit_rx,
                tail,
                spawn_error: Some(error.kind()),
                kill: kill_tx,
                terminator: Arc::clone(&terminator),
            };
            let why = peer.stderr_tail().trim().to_owned();
            return Ok((SpawnPort::unspawned(why, terminator), peer));
        }
    };

    let Launched {
        pid,
        stdin,
        stdout,
        child,
        stderr,
    } = launch;

    if let Some(stderr) = stderr {
        tokio::spawn(drain_stderr(stderr, Arc::clone(&tail), options.on_stderr));
    }
    tokio::spawn(reap(child, pid, kill_rx, exit_tx));

    let terminator = Arc::new(Terminator::new(
        kill_tx.clone(),
        exit_rx.clone(),
        options.terminate_grace,
        options.kill_grace,
        options.exit_grace,
    ));
    let port = NdjsonPort::new(stdout, stdin);
    let port = match options.max_frame_bytes {
        Some(limit) => port.with_max_frame_bytes(limit),
        None => port,
    };

    Ok((
        SpawnPort::live(port, Arc::clone(&terminator)),
        LaunchedPeer {
            pid: Some(pid),
            exit: exit_rx,
            tail,
            spawn_error: None,
            kill: kill_tx,
            terminator,
        },
    ))
}

/// A child that started, taken apart into the pieces the launcher wires up.
struct Launched {
    pid: u32,
    stdin: ChildStdin,
    stdout: ChildStdout,
    stderr: Option<tokio::process::ChildStderr>,
    child: Child,
}

fn start(command: &str, options: &SpawnOptions) -> std::io::Result<Launched> {
    let mut builder = Command::new(command);
    builder
        .args(&options.argv[1..])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env_clear();
    match &options.env {
        Some(env) => builder.envs(env),
        None => builder.envs(sanitized_env([])),
    };
    if let Some(cwd) = &options.cwd {
        builder.current_dir(cwd);
    }
    #[cfg(windows)]
    if options.windows_hide {
        // `CREATE_NO_WINDOW`: the child gets no console of its own.
        builder.creation_flags(0x0800_0000);
    }

    let mut child = builder.spawn()?;
    let pid = child.id().unwrap_or_default();
    let stdin = child.stdin.take().expect("stdin was piped");
    let stdout = child.stdout.take().expect("stdout was piped");
    let stderr = child.stderr.take();
    Ok(Launched {
        pid,
        stdin,
        stdout,
        stderr,
        child,
    })
}

/// Keeps the child's stderr in the bounded tail, and hands every chunk to the
/// caller's own reader if it asked for one. Diagnostics are best effort: a
/// broken stderr never fails the session.
async fn drain_stderr(
    mut stderr: tokio::process::ChildStderr,
    tail: Arc<Mutex<BoundedTail>>,
    on_stderr: Option<StderrReader>,
) {
    let mut chunk = vec![0_u8; 8 * 1024];
    while let Ok(count) = stderr.read(&mut chunk).await {
        if count == 0 {
            return;
        }
        let bytes = &chunk[..count];
        if let Ok(mut tail) = tail.lock() {
            tail.append(bytes);
        }
        if let Some(on_stderr) = &on_stderr {
            on_stderr(bytes);
        }
    }
}

/// Owns the child until it exits, delivering whatever signals the termination
/// sequence asks for on the way.
///
/// One task rather than a shared handle: `Child::wait` needs the child
/// exclusively, and a signal that had to wait for the reaper's lock would
/// arrive after the grace period it belongs to.
async fn reap(
    mut child: Child,
    pid: u32,
    mut kill: mpsc::UnboundedReceiver<KillRequest>,
    exit: watch::Sender<Option<ExitStatus>>,
) {
    loop {
        tokio::select! {
            // `Child::wait` is cancel-safe, so losing this race to a signal
            // request leaves the child exactly where it was.
            status = child.wait() => {
                let _ = exit.send(Some(status.map_or_else(|_| ExitStatus::default(), exit_status)));
                return;
            }
            request = kill.recv() => match request {
                Some(request) => deliver(&mut child, pid, request),
                // Nothing can ask for a signal any more; the child is still
                // this task's to reap.
                None => {
                    let status = child.wait().await;
                    let _ = exit.send(Some(
                        status.map_or_else(|_| ExitStatus::default(), exit_status),
                    ));
                    return;
                }
            },
        }
    }
}

/// The two steps of the termination sequence a launcher can ask for.
#[derive(Debug, Clone, Copy)]
enum KillRequest {
    /// Step 2: ask the child to leave.
    Terminate,
    /// Step 3: make it leave.
    Kill,
}

fn deliver(child: &mut Child, pid: u32, request: KillRequest) {
    match request {
        // Windows has no POSIX signals, so asking and making collapse into
        // terminating the process (spawn.md, Termination).
        KillRequest::Kill => {
            let _ = child.start_kill();
        }
        KillRequest::Terminate => terminate_gently(child, pid),
    }
}

#[cfg(unix)]
fn terminate_gently(_child: &mut Child, pid: u32) {
    let Ok(pid) = i32::try_from(pid) else {
        return;
    };
    // A child that already exited is reaped by this very task, so the id
    // cannot have been recycled while the signal is being sent.
    let _ = nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(pid),
        nix::sys::signal::Signal::SIGTERM,
    );
}

#[cfg(not(unix))]
fn terminate_gently(child: &mut Child, _pid: u32) {
    let _ = child.start_kill();
}

fn exit_status(status: std::process::ExitStatus) -> ExitStatus {
    #[cfg(unix)]
    let signal = std::os::unix::process::ExitStatusExt::signal(&status);
    #[cfg(not(unix))]
    let signal = None;
    ExitStatus {
        code: status.code(),
        signal,
    }
}

/// What an escalation settled on, for a caller that asks after `start` has
/// already run — or is running — rather than driving `escalate` itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TerminationOutcome {
    /// The escalation has not settled yet.
    Pending,
    /// The child exited before the exit grace ran out.
    Exited(ExitStatus),
    /// The exit grace ran out after `SIGKILL`; the child had not exited.
    GaveUp,
}

/// Runs the termination sequence once, however many callers ask for it.
#[derive(Debug)]
struct Terminator {
    kill: Option<mpsc::UnboundedSender<KillRequest>>,
    exit: Option<watch::Receiver<Option<ExitStatus>>>,
    terminate_grace: Duration,
    kill_grace: Duration,
    exit_grace: Duration,
    started: Mutex<bool>,
    /// What `start`'s background escalation found, so `terminate` reads the
    /// one escalation that ran instead of racing a second wait against it.
    outcome: watch::Sender<TerminationOutcome>,
}

impl Terminator {
    fn new(
        kill: mpsc::UnboundedSender<KillRequest>,
        exit: watch::Receiver<Option<ExitStatus>>,
        terminate_grace: Duration,
        kill_grace: Duration,
        exit_grace: Duration,
    ) -> Self {
        let (outcome, _) = watch::channel(TerminationOutcome::Pending);
        Self {
            kill: Some(kill),
            exit: Some(exit),
            terminate_grace,
            kill_grace,
            exit_grace,
            started: Mutex::new(false),
            outcome,
        }
    }

    /// A terminator for a child that never started: there is nothing to
    /// escalate against, so the outcome is already known — the same
    /// `ExitStatus::default()` sentinel the launch path put on the exit
    /// watch, not a grace that ran out.
    fn unspawned() -> Self {
        let (outcome, _) = watch::channel(TerminationOutcome::Exited(ExitStatus::default()));
        Self {
            kill: None,
            exit: None,
            terminate_grace: Duration::ZERO,
            kill_grace: Duration::ZERO,
            exit_grace: Duration::ZERO,
            started: Mutex::new(true),
            outcome,
        }
    }

    /// Escalates in the background, so a port close is not held up by a child
    /// that takes its whole grace to leave. The TypeScript launcher does the
    /// same with a floating promise.
    fn start(self: &Arc<Self>) {
        {
            let Ok(mut started) = self.started.lock() else {
                return;
            };
            if *started {
                return;
            }
            *started = true;
        }
        let terminator = Arc::clone(self);
        tokio::spawn(async move {
            let outcome = match terminator.escalate().await {
                Some(status) => TerminationOutcome::Exited(status),
                None => TerminationOutcome::GaveUp,
            };
            let _ = terminator.outcome.send(outcome);
        });
    }

    /// End of stdin, then `SIGTERM`, then `SIGKILL`, each bounded by its own
    /// grace. `None` once the exit grace runs out after `SIGKILL` — spawn.md
    /// step 4's "a launcher that gives up": this reports that the child had
    /// not exited, and never invents an exit status for it.
    async fn escalate(&self) -> Option<ExitStatus> {
        let (Some(kill), Some(exit)) = (self.kill.as_ref(), self.exit.as_ref()) else {
            return Some(ExitStatus::default());
        };
        let mut exit = exit.clone();
        // Step 1 already happened: whoever closed the port ended the child's
        // stdin, and a conforming peer treats that as the session ending.
        if let Some(status) = settled_within(&mut exit, self.terminate_grace).await {
            return Some(status);
        }
        let _ = kill.send(KillRequest::Terminate);
        if let Some(status) = settled_within(&mut exit, self.kill_grace).await {
            return Some(status);
        }
        let _ = kill.send(KillRequest::Kill);
        settled_within(&mut exit, self.exit_grace).await
    }

    /// Waits for the escalation this terminator ran to settle, and reads what
    /// it found. Safe to call before, during or after `start`: an unspawned
    /// terminator already knows its answer, and a live one blocks until its
    /// own background escalation records one — never running a second
    /// escalation of its own.
    async fn outcome(&self) -> Option<ExitStatus> {
        let mut outcome = self.outcome.subscribe();
        loop {
            match *outcome.borrow_and_update() {
                TerminationOutcome::Exited(status) => return Some(status),
                TerminationOutcome::GaveUp => return None,
                TerminationOutcome::Pending => {}
            }
            if outcome.changed().await.is_err() {
                // The sender lives as long as this `Terminator`, and `self`
                // borrows it for the whole call — this arm is unreachable in
                // practice, not a real "gave up before starting".
                return None;
            }
        }
    }
}

/// The exit status if it lands inside `grace`; `None` when the grace ran out
/// or the watch's sender is gone — both read the same to a caller waiting for
/// an exit that is not coming.
async fn settled_within(
    exit: &mut watch::Receiver<Option<ExitStatus>>,
    grace: Duration,
) -> Option<ExitStatus> {
    tokio::time::timeout(grace, wait_for_exit(exit))
        .await
        .ok()
        .flatten()
}

/// The exit status once the watch reports one; `None` when its sender is gone
/// without ever sending one.
async fn wait_for_exit(exit: &mut watch::Receiver<Option<ExitStatus>>) -> Option<ExitStatus> {
    loop {
        if let Some(status) = *exit.borrow_and_update() {
            return Some(status);
        }
        if exit.changed().await.is_err() {
            return None;
        }
    }
}

/// A peer this launcher started: everything it observed about the child, and
/// the sequence that ends it.
///
/// The port is handed out separately because it moves into a
/// [`crate::session::Session`]; what the launcher learned by running a child
/// stays here.
#[derive(Debug)]
pub struct LaunchedPeer {
    pid: Option<u32>,
    exit: watch::Receiver<Option<ExitStatus>>,
    tail: Arc<Mutex<BoundedTail>>,
    spawn_error: Option<std::io::ErrorKind>,
    kill: mpsc::UnboundedSender<KillRequest>,
    terminator: Arc<Terminator>,
}

impl LaunchedPeer {
    /// The child's process id; `None` when the child never started.
    ///
    /// # Example
    ///
    /// ```no_run
    /// # #[tokio::main(flavor = "current_thread")]
    /// # async fn main() {
    /// use mango_protocol::transports::spawn::{SpawnOptions, spawn_port};
    ///
    /// let (_port, peer) = spawn_port(SpawnOptions::new(["mango-runtime"])).expect("an argv");
    /// println!("{:?}", peer.pid());
    /// # }
    /// ```
    #[must_use]
    pub fn pid(&self) -> Option<u32> {
        self.pid
    }

    /// The last `stderr_tail_bytes` the child wrote, decoded as UTF-8.
    ///
    /// Read it next to [`LaunchedPeer::exited`]; the very last chunk of a
    /// child that died mid-write is best effort, as any tail of a pipe is.
    ///
    /// # Example
    ///
    /// ```no_run
    /// # #[tokio::main(flavor = "current_thread")]
    /// # async fn main() {
    /// use mango_protocol::transports::spawn::{SpawnOptions, spawn_port};
    ///
    /// let (_port, peer) = spawn_port(SpawnOptions::new(["mango-runtime"])).expect("an argv");
    /// let status = peer.exited().await;
    /// if status.code != Some(0) {
    ///     eprintln!("the child left with {status}, saying: {}", peer.stderr_tail());
    /// }
    /// # }
    /// ```
    #[must_use]
    pub fn stderr_tail(&self) -> String {
        self.tail
            .lock()
            .map_or_else(|_| String::new(), |tail| tail.text())
    }

    /// Waits for the child to exit and says how it ended. A child that never
    /// started reports no status at all; [`LaunchedPeer::stderr_tail`] carries
    /// the reason.
    ///
    /// # Example
    ///
    /// ```no_run
    /// # #[tokio::main(flavor = "current_thread")]
    /// # async fn main() {
    /// use mango_protocol::transports::spawn::{SpawnOptions, spawn_port};
    ///
    /// let (port, peer) = spawn_port(SpawnOptions::new(["mango-runtime"])).expect("an argv");
    /// // Closing the port ends the child's stdin, which is what a conforming
    /// // peer leaves on; this then resolves without a signal being needed.
    /// drop(port);
    /// let status = peer.exited().await;
    /// println!("{:?} {:?}", status.code, status.signal);
    /// # }
    /// ```
    pub async fn exited(&self) -> ExitStatus {
        let mut exit = self.exit.clone();
        // `None` only when the watch's sender is gone without ever recording
        // an exit — the reaper task ending without sending, which no path
        // through this launcher takes but `wait_for_exit`'s signature does
        // not rule out. `exited` is unbounded on purpose: it is the one call
        // that waits for the real exit, so a lost sender still resolves
        // rather than reporting a grace that was never asked for here.
        wait_for_exit(&mut exit).await.unwrap_or_default()
    }

    /// Why a launch that never reached a handshake failed, read once the child
    /// has had `grace` (250 ms by default) to report how it ended.
    ///
    /// A refused launch is nearly always gone already — a wrapper that could
    /// not start its target exits at once — but the pipe closing and the exit
    /// are not ordered, and a caller reading the status before it lands would
    /// see nothing at all.
    ///
    /// # Example
    ///
    /// ```no_run
    /// # #[tokio::main(flavor = "current_thread")]
    /// # async fn main() {
    /// use mango_protocol::transports::spawn::{SpawnOptions, spawn_port};
    ///
    /// let (_port, peer) = spawn_port(SpawnOptions::new(["mango-runtime"])).expect("an argv");
    /// // `None` takes the default grace; the launcher's own reading of why
    /// // the command never became a process, not the child's bytes.
    /// let refused = peer.start_error(None).await;
    /// if refused.spawn_error == Some(std::io::ErrorKind::NotFound) {
    ///     eprintln!("no such command: {}", refused.stderr_line);
    /// }
    /// # }
    /// ```
    pub async fn start_error(&self, grace: Option<Duration>) -> SpawnStartError {
        let mut exit = self.exit.clone();
        let grace = grace.unwrap_or(DEFAULT_START_ERROR_GRACE);
        SpawnStartError {
            exit: settled_within(&mut exit, grace).await,
            spawn_error: self.spawn_error,
            stderr_line: last_non_empty_line(&self.stderr_tail()).unwrap_or_default(),
        }
    }

    /// Runs the termination sequence and resolves once the child has exited,
    /// or `None` once the exit grace has run out after `SIGKILL` without the
    /// child leaving. The escalation itself runs once and is not repeated,
    /// but a call after it gave up rechecks the exit watch rather than
    /// replaying the stale answer: a child that outlived every grace and
    /// left afterwards has an exit status now, matching the TypeScript
    /// launcher, whose `terminate()` does not cache `undefined` either.
    /// `None` from this call means the grace had run out *and* the child
    /// still had not exited by the time this call was made — an unspawned
    /// child (one that never became a process) still resolves
    /// `Some(ExitStatus::default())`, the same sentinel
    /// [`LaunchedPeer::exited`] reports for it, because there is nothing
    /// there to time out on. Safe to call more than once, and safe to call
    /// after the port already started the sequence on its own.
    ///
    /// Step 1 of spawn.md's sequence — ending the child's stdin — belongs to
    /// whoever holds the port, because that is who owns the writable half:
    /// closing the session closes the port, which ends stdin and starts this
    /// sequence on its own. Calling this without closing the session first
    /// still ends the child, but by way of `SIGTERM` once the first grace has
    /// run out rather than by the end of file a conforming peer would have
    /// left on.
    ///
    /// [`LaunchedPeer::exited`] is the call to await for the real exit; it
    /// has no deadline and never gives up.
    ///
    /// # Example
    ///
    /// ```no_run
    /// # #[tokio::main(flavor = "current_thread")]
    /// # async fn main() {
    /// use mango_protocol::transports::spawn::{SpawnOptions, spawn_port};
    ///
    /// let (port, peer) = spawn_port(SpawnOptions::new(["mango-runtime"])).expect("an argv");
    /// // Step 1 belongs to the port: dropping it ends the child's stdin, so
    /// // a conforming child leaves before any signal is reached for.
    /// drop(port);
    /// match peer.terminate().await {
    ///     Some(status) => println!("the child left with {status}"),
    ///     None => println!("the child had not exited"),
    /// }
    /// # }
    /// ```
    pub async fn terminate(&self) -> Option<ExitStatus> {
        self.terminator.start();
        match self.terminator.outcome().await {
            Some(status) => Some(status),
            // `GaveUp` is what the escalation recorded when its own grace
            // ran out; it says nothing about now. A plain, non-blocking
            // `borrow` is deliberate here — this must never wait, or a
            // caller who already saw one `None` could hang on a second call
            // forever, exactly what `exit_grace` exists to bound against.
            None => *self.exit.borrow(),
        }
    }

    /// Sends `SIGKILL` (on Windows, terminates) without waiting out the
    /// graces, for a caller that has already decided the child is not coming
    /// back.
    ///
    /// # Example
    ///
    /// ```no_run
    /// # #[tokio::main(flavor = "current_thread")]
    /// # async fn main() {
    /// use mango_protocol::transports::spawn::{SpawnOptions, spawn_port};
    ///
    /// let (_port, peer) = spawn_port(SpawnOptions::new(["mango-runtime"])).expect("an argv");
    /// peer.kill();
    /// let status = peer.exited().await;
    /// println!("{status}");
    /// # }
    /// ```
    pub fn kill(&self) {
        let _ = self.kill.send(KillRequest::Kill);
    }
}

/// The last line of a diagnostic that says anything, which is where a program
/// that failed to start puts its reason.
///
/// # Example
///
/// ```
/// use mango_protocol::transports::spawn::last_non_empty_line;
///
/// assert_eq!(last_non_empty_line("starting\nconfig missing\n"), Some("config missing".into()));
/// assert_eq!(last_non_empty_line("  \n"), None);
/// ```
#[must_use]
pub fn last_non_empty_line(text: &str) -> Option<String> {
    text.lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(ToOwned::to_owned)
}

/// The port the launcher hands out: the NDJSON port over the child's pipes,
/// plus the termination sequence the child's lifetime depends on.
///
/// Closing it starts that sequence, and so does the port closing on its own:
/// a refused line or a stdout the child ended means the session is over either
/// way, and the child has to follow.
#[derive(Debug)]
pub struct SpawnPort {
    kind: PortKind,
    terminator: Arc<Terminator>,
}

#[derive(Debug)]
enum PortKind {
    /// A child that started; its stdout and stdin carry the frames.
    Live(Box<NdjsonPort<ChildStdout, ChildStdin>>),
    /// A child that never started. Every write is a broken pipe and the one
    /// closure says why.
    Unspawned(String),
}

impl SpawnPort {
    fn live(port: NdjsonPort<ChildStdout, ChildStdin>, terminator: Arc<Terminator>) -> Self {
        Self {
            kind: PortKind::Live(Box::new(port)),
            terminator,
        }
    }

    fn unspawned(why: String, terminator: Arc<Terminator>) -> Self {
        Self {
            kind: PortKind::Unspawned(if why.is_empty() {
                "the child process never started".to_owned()
            } else {
                why
            }),
            terminator,
        }
    }
}

impl Port for SpawnPort {
    type Tx = SpawnPortTx;
    type Rx = SpawnPortRx;

    fn max_frame_bytes(&self) -> Option<usize> {
        match &self.kind {
            PortKind::Live(port) => port.max_frame_bytes(),
            PortKind::Unspawned(_) => None,
        }
    }

    fn split(self) -> (Self::Tx, Self::Rx) {
        match self.kind {
            PortKind::Live(port) => {
                let (tx, rx) = port.split();
                (
                    SpawnPortTx {
                        inner: Some(tx),
                        terminator: Arc::clone(&self.terminator),
                    },
                    SpawnPortRx {
                        inner: Some(rx),
                        closure: None,
                        terminator: self.terminator,
                    },
                )
            }
            PortKind::Unspawned(why) => (
                SpawnPortTx {
                    inner: None,
                    terminator: Arc::clone(&self.terminator),
                },
                SpawnPortRx {
                    inner: None,
                    closure: Some(why),
                    terminator: self.terminator,
                },
            ),
        }
    }
}

/// The send half of a [`SpawnPort`].
#[derive(Debug)]
pub struct SpawnPortTx {
    inner: Option<NdjsonTx<ChildStdin>>,
    terminator: Arc<Terminator>,
}

impl PortTx for SpawnPortTx {
    async fn send(&mut self, frame: Frame) -> SendOutcome {
        match self.inner.as_mut() {
            Some(inner) => inner.send(frame).await,
            None => SendOutcome::Closed,
        }
    }

    async fn close(self, code: u16, reason: Option<String>) {
        if let Some(inner) = self.inner {
            // The farewell and the end of the child's stdin: step 1 of the
            // termination sequence.
            inner.close(code, reason).await;
        }
        self.terminator.start();
    }
}

/// The receive half of a [`SpawnPort`].
#[derive(Debug)]
pub struct SpawnPortRx {
    inner: Option<NdjsonRx<ChildStdout, ChildStdin>>,
    /// Why a child that never started has nothing to deliver; taken once.
    closure: Option<String>,
    terminator: Arc<Terminator>,
}

impl PortRx for SpawnPortRx {
    async fn recv(&mut self) -> Option<Inbound> {
        let Some(inner) = self.inner.as_mut() else {
            return self.closure.take().map(|why| {
                Inbound::Closed(crate::port::PortClosure::Closed {
                    code: None,
                    reason: Some(why),
                })
            });
        };
        let item = inner.recv().await;
        if matches!(item, Some(Inbound::Closed(_))) {
            // The child ended its stdout, or said something nobody could
            // read. Either way the session is over and the child follows.
            self.terminator.start();
        }
        item
    }
}

/// The last N bytes written to it, so a diagnostic never grows without bound.
#[derive(Debug)]
struct BoundedTail {
    bytes: Vec<u8>,
    limit: usize,
}

impl BoundedTail {
    fn new(limit: usize) -> Self {
        Self {
            bytes: Vec::new(),
            limit: limit.max(1),
        }
    }

    fn append(&mut self, chunk: &[u8]) {
        self.bytes.extend_from_slice(chunk);
        if self.bytes.len() > self.limit {
            let excess = self.bytes.len() - self.limit;
            self.bytes.drain(..excess);
        }
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.bytes).into_owned()
    }
}

fn append_line(tail: &Arc<Mutex<BoundedTail>>, text: &str) {
    if let Ok(mut tail) = tail.lock() {
        tail.append(format!("\n{text}\n").as_bytes());
    }
}

#[cfg(test)]
mod tests {
    use super::{
        BoundedTail, ExitStatus, LaunchedPeer, SpawnOptions, Terminator, last_non_empty_line,
        sanitized_env_from, signal_name, spawn_port,
    };
    use crate::port::{Inbound, Port, PortClosure, PortRx};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use tokio::sync::{mpsc, watch};

    #[test]
    fn an_argv_without_a_command_is_refused() {
        let error = spawn_port(SpawnOptions::new(Vec::<String>::new()))
            .expect_err("an empty argv names no command");
        assert!(error.to_string().contains("expected [command, ...args]"));

        let error =
            spawn_port(SpawnOptions::new([""])).expect_err("an empty command names no command");
        assert!(
            error.to_string().contains("spawn argv is [\"\"]"),
            "{error}"
        );
    }

    #[test]
    fn the_allowlist_keeps_what_a_program_needs_and_drops_the_rest() {
        let source = [
            ("PATH".to_owned(), "/usr/bin".to_owned()),
            ("LC_ALL".to_owned(), "C".to_owned()),
            ("EDITOR".to_owned(), "vi".to_owned()),
        ];
        let env = sanitized_env_from(source, []);
        assert_eq!(env.get("PATH").map(String::as_str), Some("/usr/bin"));
        assert_eq!(env.get("LC_ALL").map(String::as_str), Some("C"));
        assert!(!env.contains_key("EDITOR"));
    }

    #[test]
    fn a_secret_shaped_name_is_dropped_though_the_allowlist_would_keep_it() {
        // The allowlist runs first, so a name it does not hold is gone before
        // the secret rule is asked about it: `XDG_RUNTIME_DIR_TOKEN` proves
        // nothing about that rule. `LC_*` is the one family kept by prefix, so
        // it is where the rule still has work to do — delete `is_secret_shaped`
        // and `LC_API_KEY` reaches the child.
        //
        // Windows spells its variables in mixed case, so the match is made on
        // the upper-cased name and the original spelling is what survives.
        let source = [
            ("Path".to_owned(), "C:\\bin".to_owned()),
            ("LC_API_KEY".to_owned(), "shh".to_owned()),
            ("Lc_Password".to_owned(), "shh".to_owned()),
            ("XDG_RUNTIME_DIR_TOKEN".to_owned(), "shh".to_owned()),
        ];
        let env = sanitized_env_from(source, []);
        assert_eq!(env.get("Path").map(String::as_str), Some("C:\\bin"));
        assert!(
            !env.contains_key("LC_API_KEY"),
            "the allowlist keeps LC_*; the secret rule is what drops this one"
        );
        assert!(!env.contains_key("Lc_Password"), "matched upper-cased");
        assert!(
            !env.contains_key("XDG_RUNTIME_DIR_TOKEN"),
            "not on the allowlist at all"
        );
    }

    #[test]
    fn what_the_application_adds_on_purpose_survives() {
        let env = sanitized_env_from([], [("MANGO_TOKEN".to_owned(), "deliberate".to_owned())]);
        assert_eq!(
            env.get("MANGO_TOKEN").map(String::as_str),
            Some("deliberate")
        );
    }

    #[test]
    #[should_panic(expected = "max_frame_bytes is 512; expected at least 4096")]
    fn with_max_frame_bytes_below_the_floor_panics_naming_both() {
        let _ = SpawnOptions::new(["mango-runtime"]).with_max_frame_bytes(512);
    }

    #[test]
    #[should_panic(expected = "max_frame_bytes is 512; expected at least 4096")]
    fn spawn_port_panics_on_a_sub_floor_ceiling_before_starting_the_child() {
        // `max_frame_bytes` assigned directly, the way a caller who skips
        // `with_max_frame_bytes` would — the field is `pub`, so nothing but
        // this check stops it. A command that names no real process on this
        // system: if the check ever moves back to after the child starts,
        // this reaches the "command never became a process" branch instead
        // of panicking, and the test fails with "did not panic" rather than
        // silently passing on the old, buggy ordering.
        let mut options = SpawnOptions::new(["mango-no-such-command-exists-anywhere"]);
        options.max_frame_bytes = Some(512);
        let _ = spawn_port(options);
    }

    #[tokio::test]
    async fn escalate_gives_up_once_the_exit_grace_runs_out() {
        let (kill_tx, _kill_rx) = mpsc::unbounded_channel();
        let (exit_tx, exit_rx) = watch::channel(None);
        // Held for the whole test: dropping it would make `wait_for_exit` see
        // a gone sender, which reads the same as a grace running out but
        // proves nothing about the deadline this test exists to check.
        let _exit_tx = exit_tx;
        let terminator = Terminator::new(
            kill_tx,
            exit_rx,
            Duration::from_millis(10),
            Duration::from_millis(10),
            Duration::from_millis(20),
        );

        match tokio::time::timeout(Duration::from_millis(200), terminator.escalate()).await {
            Ok(None) => {}
            Ok(Some(status)) => panic!("expected Ok(None), received Ok(Some({status}))"),
            Err(_) => panic!("expected Ok(None), received Err(Elapsed)"),
        }
    }

    #[tokio::test]
    async fn terminate_rechecks_the_exit_watch_after_giving_up() {
        let (kill_tx, _kill_rx) = mpsc::unbounded_channel();
        let (exit_tx, exit_rx) = watch::channel(None);
        let terminator = Arc::new(Terminator::new(
            kill_tx.clone(),
            exit_rx.clone(),
            Duration::from_millis(10),
            Duration::from_millis(10),
            Duration::from_millis(20),
        ));
        let peer = LaunchedPeer {
            pid: Some(1),
            exit: exit_rx,
            tail: Arc::new(Mutex::new(BoundedTail::new(0))),
            spawn_error: None,
            kill: kill_tx,
            terminator,
        };

        // No exit ever lands inside the graces: the escalation gives up and
        // caches `GaveUp`.
        assert_eq!(
            tokio::time::timeout(Duration::from_millis(200), peer.terminate())
                .await
                .expect("terminate must not hang past its own graces"),
            None
        );

        // The child leaves *after* the grace — late, but it did leave.
        let late = ExitStatus {
            code: Some(0),
            signal: None,
        };
        let _ = exit_tx.send(Some(late));

        assert_eq!(
            tokio::time::timeout(Duration::from_millis(200), peer.terminate())
                .await
                .expect("a second terminate() call must not hang either"),
            Some(late),
            "a late exit must be visible to a caller who asks terminate() again"
        );
    }

    #[test]
    fn a_tail_keeps_only_its_last_bytes() {
        let mut tail = BoundedTail::new(4);
        tail.append(b"abcdefg");
        assert_eq!(tail.text(), "defg");
    }

    /// A tail cut at a byte budget routinely lands mid sequence, and a child
    /// may write bytes that are not UTF-8 at all. spawn.md says the tail is
    /// decoded lossily and reported anyway; losing it is the failure.
    #[test]
    fn a_tail_that_is_not_valid_utf8_is_still_reported() {
        let mut tail = BoundedTail::new(16);
        tail.append("permission denied: \u{1f96d}".as_bytes());
        // Cut the four-byte mango in half, exactly as a byte budget would.
        let mut split = BoundedTail::new(16);
        split.append(&"caf\u{e9} \u{1f96d}".as_bytes()[..8]);

        assert!(tail.text().contains("denied"), "{}", tail.text());
        assert!(
            split.text().contains('\u{fffd}'),
            "a half sequence becomes the replacement character: {:?}",
            split.text()
        );

        let mut raw = BoundedTail::new(8);
        raw.append(&[0xff, 0xfe, b'o', b'k']);
        assert!(raw.text().ends_with("ok"), "{:?}", raw.text());
    }

    #[test]
    fn the_last_line_that_says_anything_is_the_reason() {
        assert_eq!(
            last_non_empty_line("starting\nconfig missing\n\n  \n"),
            Some("config missing".to_owned())
        );
        assert_eq!(last_non_empty_line(""), None);
    }

    #[test]
    fn an_exit_says_how_the_child_ended() {
        assert_eq!(
            ExitStatus {
                code: Some(3),
                signal: None
            }
            .to_string(),
            "exit status 3"
        );
        assert_eq!(
            ExitStatus {
                code: None,
                signal: Some(9)
            }
            .to_string(),
            "killed by SIGKILL"
        );
        assert_eq!(ExitStatus::default().to_string(), "no exit status at all");
        assert_eq!(signal_name(15), Some("SIGTERM"));
    }

    #[tokio::test]
    async fn a_command_that_does_not_exist_closes_the_port_and_says_why() {
        let (port, peer) = spawn_port(SpawnOptions::new(["mango-no-such-command-exists-anywhere"]))
            .expect("the argv names a command, even one nothing answers to");

        let (_tx, mut rx) = port.split();
        match rx.recv().await {
            Some(Inbound::Closed(PortClosure::Closed { code, reason })) => {
                assert_eq!(code, None, "a failed launch is not a close code");
                assert!(reason.is_some(), "the closure carries the reason");
            }
            other => panic!("expected a closure, got {other:?}"),
        }
        assert_eq!(rx.recv().await, None);

        let why = peer.start_error(Some(Duration::from_millis(50))).await;
        assert_eq!(why.spawn_error, Some(std::io::ErrorKind::NotFound));
        assert!(peer.pid().is_none(), "no process was ever created");
        assert!(
            !why.stderr_line.is_empty(),
            "the launcher's own observation is in the tail"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_variable_that_is_not_utf8_is_dropped_rather_than_read() {
        // POSIX environments are bytes. `std::env::vars` panics on the first
        // one that is not UTF-8, so a variable nothing here would have kept —
        // set by something else entirely — used to take the launch with it.
        use super::utf8_vars;
        use std::ffi::OsString;
        use std::os::unix::ffi::OsStringExt;

        let source = [
            (OsString::from("PATH"), OsString::from("/usr/bin")),
            (
                OsString::from("EDITOR"),
                OsString::from_vec(vec![0xff, 0xfe]),
            ),
            (
                OsString::from_vec(vec![0xff, 0xfe]),
                OsString::from("anything"),
            ),
        ];

        let kept: Vec<_> = utf8_vars(source).collect();
        assert_eq!(kept, vec![("PATH".to_owned(), "/usr/bin".to_owned())]);
    }
}
