//! Unix process-group containment owned by a small post-fork guardian.
//!
//! The runtime process prepares every allocation, environment entry, and descriptor before
//! forking. The guardian, its parent-death watchdog, and the target then use only direct libc
//! calls. The target creates its own process group while it is still held behind a start gate;
//! the watchdog receives that group before the runtime can release `execve`. The watchdog stays
//! alive until the runtime acknowledges final capture, which closes the leader-exit gap for
//! ordinary descendants that do not retain stdout or stderr.

#![cfg(unix)]
#![allow(
    unsafe_code,
    unsafe_op_in_unsafe_fn,
    reason = "the guardian's post-fork path is deliberately limited to async-signal-safe libc calls"
)]

use std::ffi::{CString, OsStr};
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::process::ExitStatusExt;
use std::pin::Pin;
use std::process::ExitStatus;
use std::sync::{Mutex, OnceLock};
use std::task::{Context, Poll};

use tokio::io::unix::AsyncFd;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, ReadBuf};
use tokio::net::unix::pipe::{Receiver, Sender};
use tokio::task::JoinHandle;

use super::{ProcessRequest, ProcessStdin};
use crate::blocking::run_blocking;

const READY: u8 = b'R';
const RELEASE: u8 = b'G';
const FINALIZE: u8 = b'F';
const STATUS_BYTES: usize = std::mem::size_of::<libc::c_int>();
const READY_BYTES: usize = STATUS_BYTES + 1;
const TERMINAL_SESSION_CLEANUP_SECONDS: libc::time_t = 10;

pub(crate) struct GuardianChild {
    pid: libc::pid_t,
    target_pid: Option<libc::pid_t>,
    stdin: Option<Box<dyn AsyncWrite + Send + Unpin>>,
    stdout: Option<Box<dyn AsyncRead + Send + Unpin>>,
    stderr: Option<Receiver>,
    pty_control: Option<OwnedFd>,
    ready: Receiver,
    status: Receiver,
    exec_error: Receiver,
    start: Option<OwnedFd>,
    finalize: Option<OwnedFd>,
    // Keeping this endpoint alive is the parent-death lease. Dropping it makes the watchdog
    // kill the whole group, including the guardian, before any detached worker can leak it.
    _liveness: OwnedFd,
    wait: JoinHandle<io::Result<ExitStatus>>,
}

impl GuardianChild {
    pub(crate) fn resize(
        &self,
        cols: u16,
        rows: u16,
    ) -> io::Result<impl std::future::Future<Output = io::Result<()>> + Send + 'static> {
        let master = self
            .pty_control
            .as_ref()
            .ok_or_else(|| {
                io::Error::new(io::ErrorKind::Unsupported, "process has no pseudo-terminal")
            })?
            .try_clone()?;
        Ok(async move {
            run_blocking(move || {
                let size = libc::winsize {
                    ws_row: rows,
                    ws_col: cols,
                    ws_xpixel: 0,
                    ws_ypixel: 0,
                };
                // SAFETY: `master` stays open for this call, and `size` has the platform layout.
                if unsafe { libc::ioctl(master.as_raw_fd(), libc::TIOCSWINSZ, &raw const size) } < 0
                {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            })
            .await
        })
    }

    pub(super) fn id(&self) -> Option<u32> {
        u32::try_from(self.target_pid.unwrap_or(self.pid)).ok()
    }

    pub(super) async fn wait_ready(&mut self) -> io::Result<()> {
        let mut message = [0; READY_BYTES];
        self.ready.read_exact(&mut message).await?;
        if message[0] != READY {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "process guardian reported an invalid readiness byte",
            ));
        }
        let mut target = [0; STATUS_BYTES];
        target.copy_from_slice(&message[1..]);
        let target = libc::c_int::from_ne_bytes(target);
        if target <= 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "process guardian reported an invalid target process group",
            ));
        }
        self.target_pid = Some(target);
        Ok(())
    }

    pub(super) fn release_start(&mut self) -> io::Result<()> {
        let Some(start) = self.start.take() else {
            return Ok(());
        };
        write_one_parent(start.as_raw_fd(), RELEASE)
    }

    /// Closes the start gate without allowing the target to execute its requested program.
    ///
    /// This is used only after the guardian already exists but before the supervisor has handed
    /// out a public control. The target sees EOF and exits through its pre-exec failure path,
    /// while the guardian remains available for the normal status and finalization handshake.
    pub(super) fn abort_start(&mut self) {
        let _ = self.start.take();
    }

    /// Waits for the direct target's status, before the guardian tears down the remaining group.
    pub(super) async fn wait_target(&mut self) -> io::Result<ExitStatus> {
        let mut bytes = [0; STATUS_BYTES];
        self.status.read_exact(&mut bytes).await?;
        Ok(ExitStatus::from_raw(libc::c_int::from_ne_bytes(bytes)))
    }

    /// Waits for a pre-`execve` error, or EOF once `execve` closed the error pipe successfully.
    pub(super) async fn wait_exec(&mut self) -> io::Result<()> {
        let mut first = [0];
        if self.exec_error.read(&mut first).await? == 0 {
            return Ok(());
        }
        let mut bytes = [0; STATUS_BYTES];
        bytes[0] = first[0];
        if let Err(error) = self.exec_error.read_exact(&mut bytes[1..]).await {
            return Err(io::Error::other(format!(
                "process exec-error pipe ended after byte {}: {error}",
                first[0]
            )));
        }
        Err(io::Error::from_raw_os_error(libc::c_int::from_ne_bytes(
            bytes,
        )))
    }

    /// Lets the guardian terminate its group after capture has reached a bounded conclusion.
    pub(super) fn finalize(&mut self) -> io::Result<()> {
        let Some(finalize) = self.finalize.take() else {
            return Ok(());
        };
        write_one_parent(finalize.as_raw_fd(), FINALIZE)
    }

    pub(super) fn take_stdout(&mut self) -> Option<Box<dyn tokio::io::AsyncRead + Send + Unpin>> {
        self.stdout.take()
    }

    pub(super) fn take_stderr(&mut self) -> Option<Box<dyn tokio::io::AsyncRead + Send + Unpin>> {
        self.stderr
            .take()
            .map(|stderr| Box::new(stderr) as Box<dyn tokio::io::AsyncRead + Send + Unpin>)
    }

    pub(super) fn take_stdin(&mut self) -> Option<Box<dyn AsyncWrite + Send + Unpin>> {
        self.stdin.take()
    }

    /// Reaps the guardian after it has been finalized or force-killed.
    pub(super) async fn wait_guardian(&mut self) -> io::Result<()> {
        let status = (&mut self.wait).await.map_err(|error| {
            io::Error::other(format!("process guardian wait task failed: {error}"))
        })??;
        if self.pty_control.is_some() && !status.success() {
            return Err(io::Error::other(format!(
                "terminal guardian exited before session cleanup: {status}"
            )));
        }
        Ok(())
    }

    pub(super) fn interrupt(&mut self) -> io::Result<()> {
        signal_group(self.id(), libc::SIGTERM)
    }

    pub(super) fn force(&mut self) -> io::Result<()> {
        signal_group(self.id(), libc::SIGKILL)
    }
}

pub(super) fn spawn(request: &ProcessRequest) -> io::Result<GuardianChild> {
    let raw = spawn_raw(request, None)?;
    GuardianChild::from_raw(raw)
}

pub(crate) fn spawn_pty(
    request: &ProcessRequest,
    cols: u16,
    rows: u16,
) -> io::Result<GuardianChild> {
    let raw = spawn_raw(request, Some((cols, rows)))?;
    GuardianChild::from_raw(raw)
}

impl GuardianChild {
    fn from_raw(raw: RawGuardianChild) -> io::Result<Self> {
        let RawGuardianChild {
            pid,
            stdin,
            stdout,
            stderr,
            pty_control,
            ready,
            status,
            exec_error,
            start,
            finalize,
            liveness,
        } = raw;
        set_nonblocking(&ready)?;
        set_nonblocking(&status)?;
        set_nonblocking(&exec_error)?;
        set_nonblocking(&stdout)?;
        set_nonblocking(&stderr)?;
        if let Some(stdin) = &stdin {
            set_nonblocking(stdin)?;
        }

        let ready = Receiver::from_owned_fd(ready)?;
        let status = Receiver::from_owned_fd(status)?;
        let exec_error = Receiver::from_owned_fd(exec_error)?;
        let stdout: Box<dyn AsyncRead + Send + Unpin> = if pty_control.is_some() {
            Box::new(PtyReader(AsyncFd::new(stdout)?))
        } else {
            Box::new(Receiver::from_owned_fd(stdout)?)
        };
        let stderr = Receiver::from_owned_fd(stderr)?;
        let stdin = stdin
            .map(|fd| -> io::Result<Box<dyn AsyncWrite + Send + Unpin>> {
                if pty_control.is_some() {
                    Ok(Box::new(PtyWriter(AsyncFd::new(fd)?)))
                } else {
                    Ok(Box::new(Sender::from_owned_fd(fd)?))
                }
            })
            .transpose()?;
        let wait = tokio::task::spawn_blocking(move || wait_for_guardian(pid));

        Ok(Self {
            pid,
            target_pid: None,
            stdin,
            stdout: Some(stdout),
            stderr: Some(stderr),
            pty_control,
            ready,
            status,
            exec_error,
            start: Some(start),
            finalize: Some(finalize),
            _liveness: liveness,
            wait,
        })
    }
}

/// A PTY master is a character device, so Tokio's Unix pipe wrapper refuses it. `AsyncFd`
/// registers the already-nonblocking descriptor with the reactor instead.
struct PtyReader(AsyncFd<OwnedFd>);

impl AsyncRead for PtyReader {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        loop {
            let mut guard = match self.0.poll_read_ready(cx) {
                Poll::Ready(Ok(guard)) => guard,
                Poll::Ready(Err(error)) => return Poll::Ready(Err(error)),
                Poll::Pending => return Poll::Pending,
            };
            let result = guard.try_io(|inner| {
                // SAFETY: `buf` offers valid writable spare capacity; the descriptor is owned by
                // `inner` for this call and was configured nonblocking before reactor registration.
                let read = unsafe {
                    libc::read(
                        inner.get_ref().as_raw_fd(),
                        buf.unfilled_mut().as_mut_ptr().cast(),
                        buf.remaining(),
                    )
                };
                if read < 0 {
                    Err(io::Error::last_os_error())
                } else {
                    Ok(read as usize)
                }
            });
            match result {
                Ok(Ok(read)) => {
                    // SAFETY: the successful read initialized exactly `read` bytes in the buffer.
                    unsafe { buf.assume_init(read) };
                    buf.advance(read);
                    return Poll::Ready(Ok(()));
                }
                Ok(Err(error)) if error.kind() == io::ErrorKind::Interrupted => continue,
                Ok(Err(error)) => return Poll::Ready(Err(error)),
                Err(_) => continue,
            }
        }
    }
}

struct PtyWriter(AsyncFd<OwnedFd>);

impl AsyncWrite for PtyWriter {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        loop {
            let mut guard = match self.0.poll_write_ready(cx) {
                Poll::Ready(Ok(guard)) => guard,
                Poll::Ready(Err(error)) => return Poll::Ready(Err(error)),
                Poll::Pending => return Poll::Pending,
            };
            let result = guard.try_io(|inner| {
                // SAFETY: `buf` is readable for its full length and the owned fd is nonblocking.
                let written = unsafe {
                    libc::write(inner.get_ref().as_raw_fd(), buf.as_ptr().cast(), buf.len())
                };
                if written < 0 {
                    Err(io::Error::last_os_error())
                } else {
                    Ok(written as usize)
                }
            });
            match result {
                Ok(result) => return Poll::Ready(result),
                Err(_) => continue,
            }
        }
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
    fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

struct RawGuardianChild {
    pid: libc::pid_t,
    stdin: Option<OwnedFd>,
    stdout: OwnedFd,
    stderr: OwnedFd,
    pty_control: Option<OwnedFd>,
    ready: OwnedFd,
    status: OwnedFd,
    exec_error: OwnedFd,
    start: OwnedFd,
    finalize: OwnedFd,
    liveness: OwnedFd,
}

struct GuardianFds {
    terminal: bool,
    liveness_read: RawFd,
    ready_write: RawFd,
    status_write: RawFd,
    exec_error_write: RawFd,
    start_read: RawFd,
    finalize_read: RawFd,
    stdin_target: RawFd,
    stdout_target: RawFd,
    stderr_target: RawFd,
    target_ready_read: RawFd,
    target_ready_write: RawFd,
    watchdog_target_read: RawFd,
    watchdog_target_write: RawFd,
    descriptor_limit: RawFd,
}

struct ExecSpec {
    programs: Vec<CString>,
    _arguments: Vec<CString>,
    argv: Vec<*const libc::c_char>,
    _environment: Vec<CString>,
    envp: Vec<*const libc::c_char>,
    cwd: Option<CString>,
}

impl ExecSpec {
    fn from_request(request: &ProcessRequest) -> io::Result<Self> {
        let program = cstring(request.program.as_os_str(), "program")?;
        let mut arguments = Vec::with_capacity(request.args.len() + 1);
        arguments.push(program.clone());
        for argument in &request.args {
            arguments.push(cstring(argument, "argument")?);
        }
        let argv = pointer_list(&arguments);

        let environment = match &request.env {
            Some(environment) => environment
                .iter()
                .map(|(key, value)| environment_entry(key, value))
                .collect::<io::Result<Vec<_>>>()?,
            None => inherited_environment(),
        };
        let envp = pointer_list(&environment);
        let path = environment
            .iter()
            .find_map(|entry| entry.to_bytes().strip_prefix(b"PATH="));
        let programs = program_candidates(&program, path)?;
        let cwd = request
            .cwd
            .as_deref()
            .map(|cwd| cstring(cwd.as_os_str(), "cwd"))
            .transpose()?;

        Ok(Self {
            programs,
            _arguments: arguments,
            argv,
            _environment: environment,
            envp,
            cwd,
        })
    }
}

fn cstring(value: &OsStr, name: &str) -> io::Result<CString> {
    CString::new(value.as_bytes()).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("process {name} contains a NUL byte"),
        )
    })
}

fn environment_entry(key: &OsStr, value: &OsStr) -> io::Result<CString> {
    let key = key.as_bytes();
    if key.is_empty() || key.contains(&b'=') {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "process environment key must be non-empty and cannot contain '='",
        ));
    }
    let mut entry = Vec::with_capacity(key.len() + value.as_bytes().len() + 1);
    entry.extend_from_slice(key);
    entry.push(b'=');
    entry.extend_from_slice(value.as_bytes());
    CString::new(entry).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "process environment value contains a NUL byte",
        )
    })
}

fn inherited_environment() -> Vec<CString> {
    // Snapshot before fork so the target never reads process-global environment state in its
    // post-fork path. This is child execution inheritance, not host configuration parsing.
    collect_inheritable(std::env::vars_os())
}

/// Keeps every inherited entry `execve` can carry, dropping the ones it cannot.
///
/// A real OS environment holds no NUL byte, but [`environment_entry`] also rejects an empty key
/// and a key containing `=` — and `std::env::vars_os` deliberately preserves a *leading* `=`
/// as part of the name (glibc's own rule, which keeps drive-relative entries such as `=C:` whole
/// under WSL interop). Refusing to launch any child at all because one such entry exists in this
/// process's environment is not the contract; inheriting everything `execve` accepts is.
fn collect_inheritable(
    entries: impl Iterator<Item = (std::ffi::OsString, std::ffi::OsString)>,
) -> Vec<CString> {
    entries
        .filter_map(|(key, value)| environment_entry(&key, &value).ok())
        .collect()
}

fn pointer_list(strings: &[CString]) -> Vec<*const libc::c_char> {
    let mut pointers = strings
        .iter()
        .map(|value| value.as_ptr())
        .collect::<Vec<_>>();
    pointers.push(std::ptr::null());
    pointers
}

fn program_candidates(program: &CString, path: Option<&[u8]>) -> io::Result<Vec<CString>> {
    let program = program.to_bytes();
    if program.contains(&b'/') {
        return Ok(vec![
            CString::new(program).expect("a validated program has no NUL"),
        ]);
    }
    let Some(path) = path else {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "PATH is required for a program name without '/'; supply an executable path",
        ));
    };
    Ok(path
        .split(|byte| *byte == b':')
        .map(|directory| {
            let directory = if directory.is_empty() {
                b"."
            } else {
                directory
            };
            let mut candidate = Vec::with_capacity(directory.len() + program.len() + 1);
            candidate.extend_from_slice(directory);
            candidate.push(b'/');
            candidate.extend_from_slice(program);
            CString::new(candidate).expect("a validated PATH and program have no NUL")
        })
        .collect::<Vec<_>>())
}

fn raw_spawn_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn descriptor_limit() -> io::Result<RawFd> {
    // `sysconf` is called in the parent before fork. It provides a finite bound even when the
    // resource limit is `RLIM_INFINITY`, which lets the non-Linux post-fork fallback close every
    // unrelated descriptor without allocating or consulting process state.
    // SAFETY: `_SC_OPEN_MAX` has no pointer arguments.
    let limit = unsafe { libc::sysconf(libc::_SC_OPEN_MAX) };
    if limit <= 0 || limit > libc::c_long::from(RawFd::MAX) {
        return Err(io::Error::other(
            "could not determine a finite Unix descriptor limit",
        ));
    }
    Ok(limit as RawFd)
}

fn spawn_raw(request: &ProcessRequest, pty: Option<(u16, u16)>) -> io::Result<RawGuardianChild> {
    let spec = ExecSpec::from_request(request)?;
    let descriptor_limit = descriptor_limit()?;
    // Serialize descriptor creation and `fork` among supervisor launches. Platforms without
    // `pipe2(O_CLOEXEC)` use `pipe` plus `fcntl`; this lock prevents another supervisor guardian
    // from observing that brief setup interval. Every guardian also closes a strict descriptor
    // whitelist after fork, protecting it from unrelated descriptors already open in the runtime.
    let _fork_lock = raw_spawn_lock()
        .lock()
        .map_err(|_| io::Error::other("supervisor fork lock was poisoned"))?;
    let (liveness_read, liveness_write) = pipe_cloexec()?;
    let (ready_read, ready_write) = pipe_cloexec()?;
    let (status_read, status_write) = pipe_cloexec()?;
    let (exec_error_read, exec_error_write) = pipe_cloexec()?;
    let (target_ready_read, target_ready_write) = pipe_cloexec()?;
    let (watchdog_target_read, watchdog_target_write) = pipe_cloexec()?;
    let (start_read, start_write) = pipe_cloexec()?;
    let (finalize_read, finalize_write) = pipe_cloexec()?;
    let (stderr_read, pipe_stderr_write) = pipe_cloexec()?;
    let (stdin_target, stdin_parent, stdout_read, stdout_write, stderr_write, pty_control) =
        if let Some((cols, rows)) = pty {
            let (master, slave) = open_pty(cols, rows)?;
            let input = master.try_clone()?;
            let resize = master.try_clone()?;
            (
                slave.try_clone()?,
                Some(input),
                master,
                slave.try_clone()?,
                slave,
                Some(resize),
            )
        } else {
            let (stdout_read, stdout_write) = pipe_cloexec()?;
            let (stdin_target, stdin_parent) = match request.stdin {
                ProcessStdin::Bytes(_) => {
                    let (target, parent) = pipe_cloexec()?;
                    (target, Some(parent))
                }
                ProcessStdin::Null => (open_null_stdin()?, None),
            };
            (
                stdin_target,
                stdin_parent,
                stdout_read,
                stdout_write,
                pipe_stderr_write,
                None,
            )
        };
    let fds = GuardianFds {
        terminal: pty.is_some(),
        liveness_read: liveness_read.as_raw_fd(),
        ready_write: ready_write.as_raw_fd(),
        status_write: status_write.as_raw_fd(),
        exec_error_write: exec_error_write.as_raw_fd(),
        start_read: start_read.as_raw_fd(),
        finalize_read: finalize_read.as_raw_fd(),
        stdin_target: stdin_target.as_raw_fd(),
        stdout_target: stdout_write.as_raw_fd(),
        stderr_target: stderr_write.as_raw_fd(),
        target_ready_read: target_ready_read.as_raw_fd(),
        target_ready_write: target_ready_write.as_raw_fd(),
        watchdog_target_read: watchdog_target_read.as_raw_fd(),
        watchdog_target_write: watchdog_target_write.as_raw_fd(),
        descriptor_limit,
    };

    // SAFETY: all Rust-owned launch data is complete before fork. The child path calls only
    // `guardian_main`, which returns only through libc `_exit`.
    let pid = unsafe { libc::fork() };
    if pid < 0 {
        return Err(io::Error::last_os_error());
    }
    if pid == 0 {
        // SAFETY: see the fork safety invariant above.
        unsafe { guardian_main(fds, &spec) };
    }

    drop(liveness_read);
    drop(ready_write);
    drop(status_write);
    drop(exec_error_write);
    drop(target_ready_read);
    drop(target_ready_write);
    drop(watchdog_target_read);
    drop(watchdog_target_write);
    drop(start_read);
    drop(finalize_read);
    drop(stdin_target);
    drop(stdout_write);
    drop(stderr_write);
    Ok(RawGuardianChild {
        pid,
        stdin: stdin_parent,
        stdout: stdout_read,
        stderr: stderr_read,
        pty_control,
        ready: ready_read,
        status: status_read,
        exec_error: exec_error_read,
        start: start_write,
        finalize: finalize_write,
        liveness: liveness_write,
    })
}

fn open_pty(cols: u16, rows: u16) -> io::Result<(OwnedFd, OwnedFd)> {
    let mut master = -1;
    let mut slave = -1;
    let mut size = libc::winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    // SAFETY: both output pointers and the winsize are valid for the duration of the call.
    if unsafe {
        libc::openpty(
            &raw mut master,
            &raw mut slave,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &raw mut size,
        )
    } < 0
    {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: a successful openpty returned two uniquely owned descriptors.
    let (master, slave) = unsafe { (OwnedFd::from_raw_fd(master), OwnedFd::from_raw_fd(slave)) };
    set_cloexec(&master)?;
    set_cloexec(&slave)?;
    Ok((master, slave))
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn pipe_cloexec() -> io::Result<(OwnedFd, OwnedFd)> {
    let mut descriptors = [-1, -1];
    // SAFETY: the descriptor array is valid for two returned descriptors.
    if unsafe { libc::pipe2(descriptors.as_mut_ptr(), libc::O_CLOEXEC) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `pipe2` returned owned descriptors exactly once.
    Ok(unsafe {
        (
            OwnedFd::from_raw_fd(descriptors[0]),
            OwnedFd::from_raw_fd(descriptors[1]),
        )
    })
}

#[cfg(not(any(target_os = "linux", target_os = "android")))]
fn pipe_cloexec() -> io::Result<(OwnedFd, OwnedFd)> {
    let mut descriptors = [-1, -1];
    // SAFETY: the descriptor array is valid for two returned descriptors.
    if unsafe { libc::pipe(descriptors.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `pipe` returned owned descriptors exactly once.
    let (read, write) = unsafe {
        (
            OwnedFd::from_raw_fd(descriptors[0]),
            OwnedFd::from_raw_fd(descriptors[1]),
        )
    };
    set_cloexec(&read)?;
    set_cloexec(&write)?;
    Ok((read, write))
}

fn set_cloexec(fd: &OwnedFd) -> io::Result<()> {
    // SAFETY: `fd` is valid for its whole borrow.
    let flags = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_GETFD) };
    if flags < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `fd` is valid and `FD_CLOEXEC` affects only this descriptor.
    if unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETFD, flags | libc::FD_CLOEXEC) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn open_null_stdin() -> io::Result<OwnedFd> {
    const NULL: &[u8] = b"/dev/null\0";
    // SAFETY: `NULL` is NUL-terminated and immutable.
    let descriptor = unsafe { libc::open(NULL.as_ptr().cast(), libc::O_RDONLY | libc::O_CLOEXEC) };
    if descriptor < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `open` returned an owned descriptor exactly once.
    Ok(unsafe { OwnedFd::from_raw_fd(descriptor) })
}

fn set_nonblocking(fd: &OwnedFd) -> io::Result<()> {
    // SAFETY: `fd` is valid for its whole borrow.
    let flags = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_GETFL) };
    if flags < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `fd` is valid and changing flags on the parent's pipe endpoint does not change the
    // separately opened endpoint the target inherited.
    if unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn wait_for_guardian(pid: libc::pid_t) -> io::Result<ExitStatus> {
    let mut status = 0;
    loop {
        // SAFETY: `status` is valid storage and `pid` is the unreaped child created above.
        let waited = unsafe { libc::waitpid(pid, &mut status, 0) };
        if waited == pid {
            // SAFETY: `status` came directly from `waitpid`.
            return Ok(ExitStatus::from_raw(status));
        }
        if waited < 0 && io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
            continue;
        }
        return Err(io::Error::last_os_error());
    }
}

fn signal_group(pid: Option<u32>, signal: libc::c_int) -> io::Result<()> {
    let Some(pid) = pid else {
        return Ok(());
    };
    let Ok(pid) = i32::try_from(pid) else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "process id exceeds the Unix signal range",
        ));
    };
    // SAFETY: a negative pid targets the guardian's process group.
    if unsafe { libc::kill(-pid, signal) } == 0 {
        return Ok(());
    }
    match io::Error::last_os_error().raw_os_error() {
        Some(libc::ESRCH) => Ok(()),
        _ => Err(io::Error::last_os_error()),
    }
}

unsafe fn guardian_main(fds: GuardianFds, spec: &ExecSpec) -> ! {
    // Do this before either nested fork. A second guardian can otherwise retain this guardian's
    // liveness writer, and a parent death would leave the first watchdog waiting on that sibling.
    unsafe {
        close_except(
            &[
                fds.liveness_read,
                fds.ready_write,
                fds.status_write,
                fds.exec_error_write,
                fds.start_read,
                fds.finalize_read,
                fds.stdin_target,
                fds.stdout_target,
                fds.stderr_target,
                fds.target_ready_read,
                fds.target_ready_write,
                fds.watchdog_target_read,
                fds.watchdog_target_write,
            ],
            fds.descriptor_limit,
        )
    };
    if unsafe { libc::setpgid(0, 0) } != 0 {
        unsafe { libc::_exit(127) };
    }
    let guardian_pgid = unsafe { libc::getpid() };

    let watchdog = unsafe { libc::fork() };
    if watchdog < 0 {
        kill_guardian_group_and_exit(guardian_pgid);
    }
    if watchdog == 0 {
        watchdog_main(fds, guardian_pgid);
    }
    unsafe { libc::close(fds.liveness_read) };
    unsafe { libc::close(fds.watchdog_target_read) };

    let target = unsafe { libc::fork() };
    if target < 0 {
        unsafe { libc::kill(watchdog, libc::SIGKILL) };
        kill_guardian_group_and_exit(guardian_pgid);
    }
    if target == 0 {
        target_main(fds, spec);
    }
    unsafe { libc::close(fds.target_ready_write) };
    let Some(target_pgid) = (unsafe { read_status_raw(fds.target_ready_read) }) else {
        kill_target_and_guardian_and_exit(target, guardian_pgid, fds.terminal);
    };
    unsafe { libc::close(fds.target_ready_read) };
    if target_pgid != target || !unsafe { write_status_raw(fds.watchdog_target_write, target_pgid) }
    {
        kill_target_and_guardian_and_exit(target, guardian_pgid, fds.terminal);
    }
    unsafe { libc::close(fds.watchdog_target_write) };
    unsafe {
        close_except(
            &[fds.ready_write, fds.status_write, fds.finalize_read],
            fds.descriptor_limit,
        )
    };
    if !write_ready_raw(fds.ready_write, target_pgid) {
        kill_target_and_guardian_and_exit(target, guardian_pgid, fds.terminal);
    }
    unsafe { libc::close(fds.ready_write) };

    // `waitid(WNOWAIT)` leaves the target as this guardian's zombie child until final cleanup.
    // The target remains the process-group leader during that interval, so a recycled numeric PID
    // can never redirect a later `kill(-target_pgid, ...)` at an unrelated process.
    let status = wait_unreaped_raw(target);
    if !write_status_raw(fds.status_write, status) {
        kill_target_and_guardian_and_exit(target_pgid, guardian_pgid, fds.terminal);
    }
    unsafe { libc::close(fds.status_write) };
    // The parent either acknowledges bounded capture or disappears. In both cases, terminate
    // every ordinary descendant before the guardian exits. The watchdog stays alive during this
    // wait, so a runtime SIGKILL cannot open a leader-exit cleanup gap.
    if read_one_raw(fds.finalize_read) != Some(FINALIZE) {
        kill_target_and_guardian_and_exit(target_pgid, guardian_pgid, fds.terminal);
    }
    unsafe { libc::close(fds.finalize_read) };
    unsafe { libc::kill(-target_pgid, libc::SIGKILL) };
    if fds.terminal && !unsafe { kill_session_members(target_pgid) } {
        unsafe { libc::_exit(127) };
    }
    let _ = unsafe { wait_raw(target) };
    if !fds.terminal
        || cfg!(not(any(
            target_os = "linux",
            target_os = "android",
            target_os = "macos"
        )))
    {
        wait_group_empty(target_pgid);
    }
    unsafe { libc::kill(watchdog, libc::SIGKILL) };
    let _ = unsafe { wait_raw(watchdog) };
    unsafe { libc::_exit(0) }
}

unsafe fn watchdog_main(fds: GuardianFds, guardian_pgid: libc::pid_t) -> ! {
    unsafe {
        close_except(
            &[fds.liveness_read, fds.watchdog_target_read],
            fds.descriptor_limit,
        )
    };
    let Some(target_pgid) = (unsafe { read_status_raw(fds.watchdog_target_read) }) else {
        kill_guardian_group_and_exit(guardian_pgid);
    };
    unsafe { libc::close(fds.watchdog_target_read) };
    loop {
        let mut byte = 0;
        let read = unsafe { libc::read(fds.liveness_read, (&raw mut byte).cast(), 1) };
        if read == 0 {
            kill_target_and_guardian_and_exit(target_pgid, guardian_pgid, fds.terminal);
        }
        if read < 0 && unsafe { errno_raw() } == libc::EINTR {
            continue;
        }
        if read < 0 {
            kill_target_and_guardian_and_exit(target_pgid, guardian_pgid, fds.terminal);
        }
    }
}

unsafe fn target_main(fds: GuardianFds, spec: &ExecSpec) -> ! {
    unsafe {
        close_except(
            &[
                fds.start_read,
                fds.exec_error_write,
                fds.stdin_target,
                fds.stdout_target,
                fds.stderr_target,
                fds.target_ready_write,
            ],
            fds.descriptor_limit,
        )
    };
    if fds.terminal {
        if unsafe { libc::setsid() } < 0
            || unsafe { libc::ioctl(fds.stdin_target, libc::c_ulong::from(libc::TIOCSCTTY), 0) } < 0
        {
            exec_failed_and_exit(fds.exec_error_write, unsafe { errno_raw() });
        }
    } else if unsafe { libc::setpgid(0, 0) } != 0 {
        exec_failed_and_exit(fds.exec_error_write, unsafe { errno_raw() });
    }
    if !unsafe { write_status_raw(fds.target_ready_write, libc::getpid()) } {
        unsafe { libc::_exit(127) };
    }
    unsafe { libc::close(fds.target_ready_write) };
    if read_one_raw(fds.start_read) != Some(RELEASE) {
        unsafe { libc::_exit(127) };
    }
    unsafe { libc::close(fds.start_read) };
    if unsafe { dup_stdio(fds.stdin_target, fds.stdout_target, fds.stderr_target) }.is_err() {
        exec_failed_and_exit(fds.exec_error_write, unsafe { errno_raw() });
    }
    if let Some(cwd) = &spec.cwd
        && unsafe { libc::chdir(cwd.as_ptr()) } != 0
    {
        exec_failed_and_exit(fds.exec_error_write, unsafe { errno_raw() });
    }
    let mut error = libc::ENOENT;
    for program in &spec.programs {
        unsafe { libc::execve(program.as_ptr(), spec.argv.as_ptr(), spec.envp.as_ptr()) };
        error = unsafe { errno_raw() };
        if error != libc::ENOENT && error != libc::ENOTDIR {
            break;
        }
    }
    exec_failed_and_exit(fds.exec_error_write, error)
}

unsafe fn exec_failed_and_exit(exec_error: RawFd, error: libc::c_int) -> ! {
    let _ = unsafe { write_status_raw(exec_error, error) };
    unsafe { libc::_exit(127) }
}

unsafe fn dup_stdio(stdin: RawFd, stdout: RawFd, stderr: RawFd) -> Result<(), ()> {
    for (source, target) in [(stdin, 0), (stdout, 1), (stderr, 2)] {
        if source != target && unsafe { libc::dup2(source, target) } < 0 {
            return Err(());
        }
    }
    for descriptor in [stdin, stdout, stderr] {
        if descriptor > 2 {
            unsafe { libc::close(descriptor) };
        }
    }
    Ok(())
}

/// Closes everything except `keep`, using only syscalls after fork.
unsafe fn close_except(keep: &[RawFd], descriptor_limit: RawFd) {
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        if unsafe { close_except_with_close_range(keep, descriptor_limit) } {
            return;
        }
    }
    unsafe { close_except_one_by_one(keep, descriptor_limit) };
}

#[cfg(any(target_os = "linux", target_os = "android"))]
unsafe fn close_except_with_close_range(keep: &[RawFd], descriptor_limit: RawFd) -> bool {
    let mut cursor = 0;
    let mut sorted = [-1; 14];
    let mut count = 0;
    for descriptor in keep {
        if *descriptor < 0 || *descriptor >= descriptor_limit {
            continue;
        }
        if count == sorted.len() {
            return false;
        }
        let mut position = count;
        while position > 0 && sorted[position - 1] > *descriptor {
            position -= 1;
        }
        if (position > 0 && sorted[position - 1] == *descriptor)
            || (position < count && sorted[position] == *descriptor)
        {
            continue;
        }
        let mut move_from = count;
        while move_from > position {
            sorted[move_from] = sorted[move_from - 1];
            move_from -= 1;
        }
        sorted[position] = *descriptor;
        count += 1;
    }
    for descriptor in &sorted[..count] {
        if cursor < *descriptor && !unsafe { close_range_raw(cursor, *descriptor - 1) } {
            return false;
        }
        cursor = *descriptor + 1;
    }
    cursor >= descriptor_limit || unsafe { close_range_raw(cursor, descriptor_limit - 1) }
}

#[cfg(any(target_os = "linux", target_os = "android"))]
unsafe fn close_range_raw(start: RawFd, end: RawFd) -> bool {
    if start > end {
        return true;
    }
    // SAFETY: Linux's `close_range` system call accepts inclusive unsigned descriptor bounds.
    let result = unsafe {
        libc::syscall(
            libc::SYS_close_range,
            start as libc::c_uint,
            end as libc::c_uint,
            0 as libc::c_uint,
        )
    };
    result == 0
}

unsafe fn close_except_one_by_one(keep: &[RawFd], descriptor_limit: RawFd) {
    for descriptor in 0..descriptor_limit {
        if !keep.contains(&descriptor) {
            unsafe { libc::close(descriptor) };
        }
    }
}

unsafe fn write_ready_raw(descriptor: RawFd, target_pgid: libc::pid_t) -> bool {
    let mut message = [0; READY_BYTES];
    message[0] = READY;
    message[1..].copy_from_slice(&target_pgid.to_ne_bytes());
    loop {
        let written = unsafe { libc::write(descriptor, message.as_ptr().cast(), message.len()) };
        if written == READY_BYTES as libc::ssize_t {
            return true;
        }
        if written < 0 && unsafe { errno_raw() } == libc::EINTR {
            continue;
        }
        return false;
    }
}

unsafe fn read_status_raw(descriptor: RawFd) -> Option<libc::c_int> {
    let mut status = 0;
    let mut offset = 0;
    while offset < STATUS_BYTES {
        let read = unsafe {
            libc::read(
                descriptor,
                (&raw mut status).cast::<u8>().add(offset).cast(),
                STATUS_BYTES - offset,
            )
        };
        if read > 0 {
            offset += read as usize;
            continue;
        }
        if read < 0 && unsafe { errno_raw() } == libc::EINTR {
            continue;
        }
        return None;
    }
    Some(status)
}

unsafe fn wait_unreaped_raw(pid: libc::pid_t) -> libc::c_int {
    // SAFETY: `siginfo_t` is an all-zeroable C output structure that `waitid` fills on success.
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    loop {
        let waited = unsafe {
            libc::waitid(
                libc::P_PID,
                pid as libc::id_t,
                &raw mut info,
                libc::WEXITED | libc::WNOWAIT,
            )
        };
        if waited == 0 {
            let status = unsafe { info.si_status() };
            return match info.si_code {
                libc::CLD_EXITED => status << 8,
                libc::CLD_KILLED => status,
                libc::CLD_DUMPED => status | 0x80,
                _ => 127 << 8,
            };
        }
        if unsafe { errno_raw() } == libc::EINTR {
            continue;
        }
        return 127 << 8;
    }
}

unsafe fn wait_raw(pid: libc::pid_t) -> libc::c_int {
    let mut status = 0;
    loop {
        let waited = unsafe { libc::waitpid(pid, &mut status, 0) };
        if waited == pid {
            return status;
        }
        if waited < 0 && unsafe { errno_raw() } == libc::EINTR {
            continue;
        }
        return 127 << 8;
    }
}

/// Waits until the target process group has no remaining members after the forced kill.
///
/// The target leader is kept unreaped until the final handshake so its numeric process-group ID
/// cannot be recycled while the guardian still owns cleanup. Reaping it here is therefore safe:
/// the immediately following group probe either observes remaining ordinary descendants or the
/// kernel reports `ESRCH` once the group is empty. Descendants which deliberately create a new
/// session are outside this guardian's containment contract.
unsafe fn wait_group_empty(process_group: libc::pid_t) {
    loop {
        // SAFETY: process_group is the target group ID reported by the target itself and remains
        // owned by this guardian until the group has been killed and observed empty.
        if unsafe { libc::kill(-process_group, 0) } == 0 {
            unsafe { pause_between_group_probes() };
            continue;
        }
        let error = unsafe { errno_raw() };
        if error == libc::EINTR {
            continue;
        }
        if error == libc::ESRCH {
            return;
        }
        // EPERM still means that a member exists. All processes in this group originated from
        // the request, but treating any other transient kernel result as live avoids publishing
        // terminal cleanup before the group has actually disappeared.
        unsafe { pause_between_group_probes() };
    }
}

/// Kills every live member of the terminal's session, including job-control groups that do not
/// share the shell's process group. The leader stays unreaped while this runs, pinning its SID.
/// A process that deliberately creates another session is outside terminal containment.
unsafe fn kill_session_members(session: libc::pid_t) -> bool {
    let mut now = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    if unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &raw mut now) } < 0 {
        return false;
    }
    let deadline = now.tv_sec.saturating_add(TERMINAL_SESSION_CLEANUP_SECONDS);
    loop {
        if unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &raw mut now) } < 0
            || now.tv_sec >= deadline
        {
            return false;
        }
        let Some(live) = (unsafe { kill_session_members_once(session) }) else {
            return false;
        };
        if !live {
            return true;
        }
        unsafe { pause_between_group_probes() };
    }
}

#[cfg(any(target_os = "linux", target_os = "android"))]
unsafe fn kill_session_members_once(session: libc::pid_t) -> Option<bool> {
    let directory = unsafe {
        libc::open(
            c"/proc".as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    };
    if directory < 0 {
        return None;
    }
    let mut live = false;
    let mut buffer = [0_u8; 8192];
    loop {
        let size = unsafe {
            libc::syscall(
                libc::SYS_getdents64,
                directory,
                buffer.as_mut_ptr(),
                buffer.len(),
            )
        };
        if size == 0 {
            break;
        }
        if size < 0 {
            if unsafe { errno_raw() } == libc::EINTR {
                continue;
            }
            unsafe { libc::close(directory) };
            return None;
        }
        let mut offset = 0;
        while offset < size as usize {
            if offset + 19 > size as usize {
                unsafe { libc::close(directory) };
                return None;
            }
            let length = usize::from(u16::from_ne_bytes([
                buffer[offset + 16],
                buffer[offset + 17],
            ]));
            if length < 20 || offset + length > size as usize {
                unsafe { libc::close(directory) };
                return None;
            }
            let name = &buffer[offset + 19..offset + length];
            if let Some(pid) = parse_proc_pid(name)
                && pid != session
                && unsafe { libc::getsid(pid) } == session
            {
                let pinned = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
                if pinned < 0 {
                    let error = unsafe { errno_raw() };
                    if matches!(error, libc::ENOSYS | libc::EPERM) {
                        // Older kernels and seccomp profiles can lack pidfds. Recheck the
                        // process birth time and session immediately before signaling it.
                        let Some(state) = (unsafe { proc_pid_state(directory, name) }) else {
                            unsafe { libc::close(directory) };
                            return None;
                        };
                        if state.running {
                            live = true;
                            if !unsafe {
                                kill_unpinned_linux_pid(
                                    directory,
                                    name,
                                    pid,
                                    session,
                                    state.start_time,
                                )
                            } {
                                unsafe { libc::close(directory) };
                                return None;
                            }
                        }
                    } else if error != libc::ESRCH {
                        unsafe { libc::close(directory) };
                        return None;
                    }
                } else {
                    let pinned = pinned as RawFd;
                    let member = unsafe { libc::getsid(pid) } == session;
                    let state = if member {
                        unsafe { proc_pid_state(directory, name) }
                    } else {
                        Some(ProcPidState {
                            running: false,
                            start_time: 0,
                        })
                    };
                    let Some(state) = state else {
                        unsafe { libc::close(pinned) };
                        unsafe { libc::close(directory) };
                        return None;
                    };
                    if state.running {
                        live = true;
                        if !unsafe {
                            finish_pidfd_signal(
                                kill_pinned_linux_pid(pinned),
                                directory,
                                name,
                                pid,
                                session,
                                state.start_time,
                            )
                        } {
                            unsafe { libc::close(pinned) };
                            unsafe { libc::close(directory) };
                            return None;
                        }
                    }
                    unsafe { libc::close(pinned) };
                }
            }
            offset += length;
        }
    }
    unsafe { libc::close(directory) };
    Some(live)
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn parse_proc_pid(name: &[u8]) -> Option<libc::pid_t> {
    if !name.first()?.is_ascii_digit() {
        return None;
    }
    let mut pid = 0_i32;
    for byte in name {
        if *byte == 0 {
            return Some(pid);
        }
        if !byte.is_ascii_digit() {
            return None;
        }
        pid = pid.checked_mul(10)?.checked_add(i32::from(*byte - b'0'))?;
    }
    None
}

#[cfg(any(target_os = "linux", target_os = "android"))]
#[derive(Clone, Copy)]
struct ProcPidState {
    running: bool,
    start_time: u64,
}

#[cfg(any(target_os = "linux", target_os = "android"))]
unsafe fn proc_pid_state(directory: RawFd, name: &[u8]) -> Option<ProcPidState> {
    let mut path = [0_u8; 32];
    let end = name.iter().position(|byte| *byte == 0)?;
    if end + b"/stat\0".len() > path.len() {
        return None;
    }
    path[..end].copy_from_slice(&name[..end]);
    path[end..end + b"/stat\0".len()].copy_from_slice(b"/stat\0");
    let file = unsafe {
        libc::openat(
            directory,
            path.as_ptr().cast(),
            libc::O_RDONLY | libc::O_CLOEXEC,
        )
    };
    if file < 0 {
        return (unsafe { errno_raw() } == libc::ENOENT).then_some(ProcPidState {
            running: false,
            start_time: 0,
        });
    }
    let mut stat = [0_u8; 512];
    let read = unsafe { libc::read(file, stat.as_mut_ptr().cast(), stat.len()) };
    unsafe { libc::close(file) };
    if read <= 0 {
        return None;
    }
    parse_proc_pid_state(&stat[..read as usize])
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn parse_proc_pid_state(stat: &[u8]) -> Option<ProcPidState> {
    let end = stat.iter().rposition(|byte| *byte == b')')?;
    let mut fields = stat
        .get(end + 1..)?
        .split(|byte| byte.is_ascii_whitespace())
        .filter(|field| !field.is_empty());
    let state = *fields.next()?.first()?;
    let start_time = fields.nth(18)?;
    let mut parsed = 0_u64;
    for byte in start_time {
        if !byte.is_ascii_digit() {
            return None;
        }
        parsed = parsed
            .checked_mul(10)?
            .checked_add(u64::from(*byte - b'0'))?;
    }
    Some(ProcPidState {
        running: !matches!(state, b'Z' | b'X'),
        start_time: parsed,
    })
}

#[cfg(any(target_os = "linux", target_os = "android"))]
unsafe fn kill_unpinned_linux_pid(
    directory: RawFd,
    name: &[u8],
    pid: libc::pid_t,
    session: libc::pid_t,
    start_time: u64,
) -> bool {
    let Some(state) = (unsafe { proc_pid_state(directory, name) }) else {
        return false;
    };
    if !state.running || state.start_time != start_time {
        return true;
    }
    let observed_session = unsafe { libc::getsid(pid) };
    if observed_session != session {
        return observed_session > 0 || unsafe { errno_raw() } == libc::ESRCH;
    }
    // Unlike a pidfd, this leaves a narrow PID-reuse race between the final SID check and kill.
    // The session leader stays unreaped and pins its SID, limiting accidental cross-session hits.
    let result = unsafe { libc::kill(pid, libc::SIGKILL) };
    result == 0 || unsafe { errno_raw() } == libc::ESRCH
}

#[cfg(any(target_os = "linux", target_os = "android"))]
unsafe fn kill_pinned_linux_pid(pinned: RawFd) -> Result<(), libc::c_int> {
    let result = unsafe {
        libc::syscall(
            libc::SYS_pidfd_send_signal,
            pinned,
            libc::SIGKILL,
            std::ptr::null::<libc::siginfo_t>(),
            0,
        )
    };
    if result == 0 {
        return Ok(());
    }
    let error = unsafe { errno_raw() };
    if error == libc::ESRCH {
        return Ok(());
    }
    Err(error)
}

#[cfg(any(target_os = "linux", target_os = "android"))]
unsafe fn finish_pidfd_signal(
    attempt: Result<(), libc::c_int>,
    directory: RawFd,
    name: &[u8],
    pid: libc::pid_t,
    session: libc::pid_t,
    start_time: u64,
) -> bool {
    match attempt {
        Ok(()) => true,
        Err(libc::ENOSYS | libc::EPERM) => unsafe {
            kill_unpinned_linux_pid(directory, name, pid, session, start_time)
        },
        Err(_) => false,
    }
}

#[cfg(target_os = "macos")]
unsafe fn kill_session_members_once(session: libc::pid_t) -> Option<bool> {
    // libproc is a thin kernel wrapper here, but Apple does not formally promise these calls are
    // async-signal-safe. Keep all storage on this guardian's stack and avoid allocator use.
    let mut pids = [0_i32; 65_536];
    let count = unsafe {
        libc::proc_listallpids(
            pids.as_mut_ptr().cast(),
            i32::try_from(std::mem::size_of_val(&pids)).ok()?,
        )
    };
    if count <= 0 || count as usize >= pids.len() {
        return None;
    }
    let mut live = false;
    for pid in pids[..count as usize].iter().copied() {
        if pid <= 0 || pid == session || unsafe { libc::getsid(pid) } != session {
            continue;
        }
        let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::uninit();
        let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
        if unsafe {
            libc::proc_pidinfo(
                pid,
                libc::PROC_PIDTBSDINFO,
                0,
                info.as_mut_ptr().cast(),
                size,
            )
        } != size
        {
            if unsafe { libc::getsid(pid) } == session {
                return None;
            }
            continue;
        }
        let info = unsafe { info.assume_init() };
        if info.pbi_status == libc::SZOMB {
            continue;
        }
        live = true;
        // macOS has no public pidfd equivalent. Recheck SID immediately before signaling this
        // process, though PID reuse between the check and kill remains possible.
        if unsafe { libc::getsid(pid) } == session
            && unsafe { libc::kill(pid, libc::SIGKILL) } < 0
            && unsafe { errno_raw() } != libc::ESRCH
        {
            return None;
        }
    }
    Some(live)
}

#[cfg(not(any(target_os = "linux", target_os = "android", target_os = "macos")))]
unsafe fn kill_session_members_once(_session: libc::pid_t) -> Option<bool> {
    // Other Unix targets retain the existing process-group containment behavior.
    Some(false)
}

/// Waits between group probes in [`wait_group_empty`].
///
/// `nanosleep` is async-signal-safe, which is what this post-`fork` guardian is restricted to, and
/// the interval matches the Windows Job path's empty-group poll. A bare `spin_loop` hint is only a
/// pause instruction, not a wait: a descendant that takes tens of milliseconds to die — or that
/// sits in uninterruptible sleep, or answers `EPERM` — would pin a core for that entire interval,
/// while the supervisor blocks in `wait_guardian` holding one of its bounded live-child permits.
unsafe fn pause_between_group_probes() {
    let interval = libc::timespec {
        tv_sec: 0,
        tv_nsec: 10_000_000,
    };
    // SAFETY: `interval` is a fully initialised `timespec` that outlives the call, and a null
    // remainder pointer is the documented way to discard an unslept interval after a signal.
    unsafe { libc::nanosleep(&raw const interval, std::ptr::null_mut()) };
}

unsafe fn kill_guardian_group_and_exit(guardian_pgid: libc::pid_t) -> ! {
    unsafe { libc::kill(-guardian_pgid, libc::SIGKILL) };
    unsafe { libc::_exit(127) }
}

unsafe fn kill_target_and_guardian_and_exit(
    target_pgid: libc::pid_t,
    guardian_pgid: libc::pid_t,
    terminal: bool,
) -> ! {
    unsafe { libc::kill(-target_pgid, libc::SIGKILL) };
    if terminal {
        let _ = unsafe { kill_session_members(target_pgid) };
    }
    unsafe { libc::kill(-guardian_pgid, libc::SIGKILL) };
    unsafe { libc::_exit(127) }
}

fn write_one_parent(descriptor: RawFd, byte: u8) -> io::Result<()> {
    loop {
        // SAFETY: the byte reference is valid and the descriptor is an owned pipe endpoint.
        let written = unsafe { libc::write(descriptor, (&raw const byte).cast(), 1) };
        if written == 1 {
            return Ok(());
        }
        if written < 0 && io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
            continue;
        }
        return Err(io::Error::last_os_error());
    }
}

unsafe fn write_status_raw(descriptor: RawFd, status: libc::c_int) -> bool {
    loop {
        let written = unsafe {
            libc::write(
                descriptor,
                (&raw const status).cast(),
                std::mem::size_of::<libc::c_int>(),
            )
        };
        if written == STATUS_BYTES as libc::ssize_t {
            return true;
        }
        if written < 0 && unsafe { errno_raw() } == libc::EINTR {
            continue;
        }
        return false;
    }
}

unsafe fn read_one_raw(descriptor: RawFd) -> Option<u8> {
    let mut byte = 0;
    loop {
        let read = unsafe { libc::read(descriptor, (&raw mut byte).cast(), 1) };
        if read == 1 {
            return Some(byte);
        }
        if read < 0 && unsafe { errno_raw() } == libc::EINTR {
            continue;
        }
        return None;
    }
}

#[cfg(any(target_os = "linux", target_os = "android"))]
unsafe fn errno_raw() -> libc::c_int {
    // SAFETY: libc exposes this thread-local errno location on Linux and Android.
    unsafe { *libc::__errno_location() }
}

#[cfg(any(
    target_os = "macos",
    target_os = "ios",
    target_os = "freebsd",
    target_os = "openbsd"
))]
unsafe fn errno_raw() -> libc::c_int {
    // SAFETY: libc exposes this thread-local errno location on BSD-derived Unix targets.
    unsafe { *libc::__error() }
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;

    use super::collect_inheritable;

    #[cfg(any(target_os = "linux", target_os = "android"))]
    #[test]
    fn proc_pid_parser_accepts_only_bounded_decimal_entries() {
        use super::parse_proc_pid;

        assert_eq!(parse_proc_pid(b"1234\0"), Some(1234));
        assert_eq!(parse_proc_pid(b".\0"), None);
        assert_eq!(parse_proc_pid(b"12x\0"), None);
        assert_eq!(parse_proc_pid(b"999999999999\0"), None);
        assert_eq!(parse_proc_pid(b"12"), None);
    }

    #[cfg(any(target_os = "linux", target_os = "android"))]
    #[test]
    fn proc_stat_parser_uses_birth_time_after_last_command_parenthesis() {
        let stat =
            b"123 (shell ) child) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 987654 20\n";
        let parsed = super::parse_proc_pid_state(stat).expect("valid proc stat");
        assert!(parsed.running);
        assert_eq!(parsed.start_time, 987654);
    }

    #[cfg(any(target_os = "linux", target_os = "android"))]
    #[test]
    fn unpinned_linux_session_member_is_killed_with_matching_birth_time() {
        use std::os::fd::AsRawFd;
        use std::os::unix::process::{CommandExt, ExitStatusExt};

        let mut command = std::process::Command::new("/bin/sleep");
        command.arg("60");
        // SAFETY: only the direct libc setsid syscall runs between fork and exec.
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut child = command.spawn().expect("spawn isolated session member");
        let pid = child.id() as libc::pid_t;
        let directory = std::fs::File::open("/proc").expect("open proc directory");
        let name = format!("{pid}\0");
        // SAFETY: the test child is alive and the /proc descriptor remains open.
        let state = unsafe { super::proc_pid_state(directory.as_raw_fd(), name.as_bytes()) }
            .expect("read child identity");
        let stale_identity = unsafe {
            super::kill_unpinned_linux_pid(
                directory.as_raw_fd(),
                name.as_bytes(),
                pid,
                pid,
                state.start_time + 1,
            )
        };
        let stale_child_alive = child.try_wait().expect("check child").is_none();
        let killed = unsafe {
            super::kill_unpinned_linux_pid(
                directory.as_raw_fd(),
                name.as_bytes(),
                pid,
                pid,
                state.start_time,
            )
        };
        if !killed {
            let _ = child.kill();
        }
        let status = child.wait().expect("reap child");
        assert!(stale_identity, "stale identity needs no signal");
        assert!(stale_child_alive, "stale identity must not signal child");
        assert!(killed, "fallback signals the matching session member");
        assert_eq!(status.signal(), Some(libc::SIGKILL));
    }

    #[cfg(any(target_os = "linux", target_os = "android"))]
    #[test]
    fn unavailable_pidfd_signal_falls_back_to_checked_pid_signal() {
        use std::os::fd::AsRawFd;
        use std::os::unix::process::{CommandExt, ExitStatusExt};

        for error in [libc::EPERM, libc::ENOSYS] {
            let mut command = std::process::Command::new("/bin/sleep");
            command.arg("60");
            // SAFETY: only the direct libc setsid syscall runs between fork and exec.
            unsafe {
                command.pre_exec(|| {
                    if libc::setsid() < 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
            let mut child = command.spawn().expect("spawn isolated session member");
            let pid = child.id() as libc::pid_t;
            let directory = std::fs::File::open("/proc").expect("open proc directory");
            let name = format!("{pid}\0");
            let state = unsafe { super::proc_pid_state(directory.as_raw_fd(), name.as_bytes()) }
                .expect("read child identity");

            // Inject the syscall result without installing a process-wide seccomp profile.
            let fatal = unsafe {
                super::finish_pidfd_signal(
                    Err(libc::EIO),
                    directory.as_raw_fd(),
                    name.as_bytes(),
                    pid,
                    pid,
                    state.start_time,
                )
            };
            let alive_after_fatal = child.try_wait().expect("check child").is_none();
            let killed = unsafe {
                super::finish_pidfd_signal(
                    Err(error),
                    directory.as_raw_fd(),
                    name.as_bytes(),
                    pid,
                    pid,
                    state.start_time,
                )
            };
            if !killed {
                let _ = child.kill();
            }
            let status = child.wait().expect("reap child");
            assert!(!fatal, "unrelated pidfd errors must remain cleanup errors");
            assert!(alive_after_fatal, "unrelated errors must not signal by PID");
            assert!(killed, "pidfd_send_signal errno={error} must fall back");
            assert_eq!(status.signal(), Some(libc::SIGKILL));
        }
    }

    /// Regression test: this snapshot used to `.expect("OS environment has no NUL")` on every
    /// entry, so a single name `environment_entry` refuses — a leading `=`, which
    /// `std::env::vars_os` keeps as part of the name, or an empty one — panicked the supervisor
    /// task and turned every command on the host into `SupervisorUnavailable`, blaming a NUL
    /// byte that was never there.
    #[test]
    fn unrepresentable_inherited_names_are_dropped_rather_than_panicking() {
        let entries = [
            ("=C:", "C:\\work"),
            ("", "empty name"),
            ("PATH", "/usr/bin"),
        ]
        .map(|(key, value)| (OsString::from(key), OsString::from(value)));

        let inherited = collect_inheritable(entries.into_iter());

        let rendered: Vec<_> = inherited
            .iter()
            .map(|entry| entry.to_str().expect("test entries are UTF-8").to_owned())
            .collect();
        assert_eq!(
            rendered,
            vec!["PATH=/usr/bin".to_owned()],
            "expected only entries execve can carry | received the refused names too"
        );
    }
}
