//! Linux process-group containment owned by a small post-fork guardian.
//!
//! The runtime process prepares every allocation, environment entry, and descriptor before
//! forking. The guardian, its parent-death watchdog, and the target then use only direct libc
//! calls. In particular, the guardian becomes a process-group leader before it forks the target,
//! so the target can never exist outside the group the watchdog kills on parent death.

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
use std::process::ExitStatus;

use tokio::io::{AsyncReadExt, AsyncWrite};
use tokio::net::unix::pipe::{Receiver, Sender};
use tokio::task::JoinHandle;

use super::{ProcessRequest, ProcessStdin};

const READY: u8 = b'R';
const RELEASE: u8 = b'G';

pub(super) struct GuardianChild {
    pid: libc::pid_t,
    stdin: Option<Sender>,
    stdout: Option<Receiver>,
    stderr: Option<Receiver>,
    ready: Receiver,
    start: Option<OwnedFd>,
    // Keeping this endpoint alive is the parent-death lease. Dropping it makes the watchdog
    // kill the whole group, including the guardian, before any detached worker can leak it.
    _liveness: OwnedFd,
    wait: JoinHandle<io::Result<ExitStatus>>,
}

impl GuardianChild {
    pub(super) fn id(&self) -> Option<u32> {
        u32::try_from(self.pid).ok()
    }

    pub(super) async fn wait_ready(&mut self) -> io::Result<()> {
        let mut byte = [0];
        self.ready.read_exact(&mut byte).await?;
        if byte == [READY] {
            Ok(())
        } else {
            Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "process guardian reported an invalid readiness byte",
            ))
        }
    }

    pub(super) fn release_start(&mut self) -> io::Result<()> {
        let Some(start) = self.start.take() else {
            return Ok(());
        };
        write_one(start.as_raw_fd(), RELEASE)
    }

    pub(super) fn take_stdout(&mut self) -> Option<Box<dyn tokio::io::AsyncRead + Send + Unpin>> {
        self.stdout
            .take()
            .map(|stdout| Box::new(stdout) as Box<dyn tokio::io::AsyncRead + Send + Unpin>)
    }

    pub(super) fn take_stderr(&mut self) -> Option<Box<dyn tokio::io::AsyncRead + Send + Unpin>> {
        self.stderr
            .take()
            .map(|stderr| Box::new(stderr) as Box<dyn tokio::io::AsyncRead + Send + Unpin>)
    }

    pub(super) fn take_stdin(&mut self) -> Option<Box<dyn AsyncWrite + Send + Unpin>> {
        self.stdin
            .take()
            .map(|stdin| Box::new(stdin) as Box<dyn AsyncWrite + Send + Unpin>)
    }

    pub(super) async fn wait(&mut self) -> io::Result<ExitStatus> {
        (&mut self.wait).await.map_err(|error| {
            io::Error::other(format!("process guardian wait task failed: {error}"))
        })?
    }

    pub(super) fn interrupt(&mut self) -> io::Result<()> {
        signal_group(self.id(), libc::SIGTERM)
    }

    pub(super) fn force(&mut self) -> io::Result<()> {
        signal_group(self.id(), libc::SIGKILL)
    }
}

pub(super) fn spawn(request: &ProcessRequest) -> io::Result<GuardianChild> {
    let raw = spawn_raw(request)?;
    GuardianChild::from_raw(raw)
}

impl GuardianChild {
    fn from_raw(raw: RawGuardianChild) -> io::Result<Self> {
        set_nonblocking(&raw.ready)?;
        set_nonblocking(&raw.stdout)?;
        set_nonblocking(&raw.stderr)?;
        if let Some(stdin) = &raw.stdin {
            set_nonblocking(stdin)?;
        }

        let ready = Receiver::from_owned_fd(raw.ready)?;
        let stdout = Receiver::from_owned_fd(raw.stdout)?;
        let stderr = Receiver::from_owned_fd(raw.stderr)?;
        let stdin = raw.stdin.map(Sender::from_owned_fd).transpose()?;
        let pid = raw.pid;
        let wait = tokio::task::spawn_blocking(move || wait_for_guardian(pid));

        Ok(Self {
            pid,
            stdin,
            stdout: Some(stdout),
            stderr: Some(stderr),
            ready,
            start: Some(raw.start),
            _liveness: raw.liveness,
            wait,
        })
    }
}

struct RawGuardianChild {
    pid: libc::pid_t,
    stdin: Option<OwnedFd>,
    stdout: OwnedFd,
    stderr: OwnedFd,
    ready: OwnedFd,
    start: OwnedFd,
    liveness: OwnedFd,
}

struct GuardianFds {
    liveness_read: RawFd,
    liveness_write: RawFd,
    ready_read: RawFd,
    ready_write: RawFd,
    start_read: RawFd,
    start_write: RawFd,
    stdin_target: RawFd,
    stdin_parent: RawFd,
    stdout_target: RawFd,
    stdout_parent: RawFd,
    stderr_target: RawFd,
    stderr_parent: RawFd,
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
    // post-fork path. OS environment entries cannot contain a NUL byte.
    std::env::vars_os()
        .map(|(key, value)| environment_entry(&key, &value).expect("OS environment has no NUL"))
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

fn spawn_raw(request: &ProcessRequest) -> io::Result<RawGuardianChild> {
    let spec = ExecSpec::from_request(request)?;
    let (liveness_read, liveness_write) = pipe_cloexec()?;
    let (ready_read, ready_write) = pipe_cloexec()?;
    let (start_read, start_write) = pipe_cloexec()?;
    let (stdout_read, stdout_write) = pipe_cloexec()?;
    let (stderr_read, stderr_write) = pipe_cloexec()?;
    let (stdin_target, stdin_parent) = match request.stdin {
        ProcessStdin::Bytes(_) => {
            let (target, parent) = pipe_cloexec()?;
            (target, Some(parent))
        }
        ProcessStdin::Null => (open_null_stdin()?, None),
    };
    let fds = GuardianFds {
        liveness_read: liveness_read.as_raw_fd(),
        liveness_write: liveness_write.as_raw_fd(),
        ready_read: ready_read.as_raw_fd(),
        ready_write: ready_write.as_raw_fd(),
        start_read: start_read.as_raw_fd(),
        start_write: start_write.as_raw_fd(),
        stdin_target: stdin_target.as_raw_fd(),
        stdin_parent: stdin_parent.as_ref().map_or(-1, AsRawFd::as_raw_fd),
        stdout_target: stdout_write.as_raw_fd(),
        stdout_parent: stdout_read.as_raw_fd(),
        stderr_target: stderr_write.as_raw_fd(),
        stderr_parent: stderr_read.as_raw_fd(),
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
    drop(start_read);
    drop(stdin_target);
    drop(stdout_write);
    drop(stderr_write);
    Ok(RawGuardianChild {
        pid,
        stdin: stdin_parent,
        stdout: stdout_read,
        stderr: stderr_read,
        ready: ready_read,
        start: start_write,
        liveness: liveness_write,
    })
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
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "parent-death process containment requires atomic O_CLOEXEC pipes on this Unix target",
    ))
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
    close_many(&[
        fds.liveness_write,
        fds.ready_read,
        fds.start_write,
        fds.stdin_parent,
        fds.stdout_parent,
        fds.stderr_parent,
    ]);
    if unsafe { libc::setpgid(0, 0) } != 0 {
        unsafe { libc::_exit(127) };
    }
    let pgid = unsafe { libc::getpid() };

    let watchdog = unsafe { libc::fork() };
    if watchdog < 0 {
        kill_group_and_exit(pgid);
    }
    if watchdog == 0 {
        watchdog_main(fds, pgid);
    }
    unsafe { libc::close(fds.liveness_read) };

    let target = unsafe { libc::fork() };
    if target < 0 {
        unsafe { libc::kill(watchdog, libc::SIGKILL) };
        kill_group_and_exit(pgid);
    }
    if target == 0 {
        target_main(fds, spec);
    }
    close_many(&[
        fds.start_read,
        fds.stdin_target,
        fds.stdout_target,
        fds.stderr_target,
    ]);
    if write_one(fds.ready_write, READY).is_err() {
        kill_group_and_exit(pgid);
    }
    unsafe { libc::close(fds.ready_write) };

    let status = wait_raw(target);
    unsafe { libc::kill(watchdog, libc::SIGKILL) };
    let _ = wait_raw(watchdog);
    exit_with_target_status(status);
}

unsafe fn watchdog_main(fds: GuardianFds, pgid: libc::pid_t) -> ! {
    close_many(&[
        fds.ready_write,
        fds.start_read,
        fds.stdin_target,
        fds.stdout_target,
        fds.stderr_target,
        0,
        1,
        2,
    ]);
    loop {
        let mut byte = 0;
        let read = unsafe { libc::read(fds.liveness_read, (&raw mut byte).cast(), 1) };
        if read == 0 {
            kill_group_and_exit(pgid);
        }
        if read < 0 && errno() == libc::EINTR {
            continue;
        }
        if read < 0 {
            kill_group_and_exit(pgid);
        }
    }
}

unsafe fn target_main(fds: GuardianFds, spec: &ExecSpec) -> ! {
    close_many(&[
        fds.ready_write,
        fds.liveness_read,
        fds.stdin_parent,
        fds.stdout_parent,
        fds.stderr_parent,
    ]);
    if read_one(fds.start_read) != Some(RELEASE) {
        unsafe { libc::_exit(127) };
    }
    unsafe { libc::close(fds.start_read) };
    if dup_stdio(fds.stdin_target, fds.stdout_target, fds.stderr_target).is_err() {
        unsafe { libc::_exit(127) };
    }
    if let Some(cwd) = &spec.cwd
        && unsafe { libc::chdir(cwd.as_ptr()) } != 0
    {
        unsafe { libc::_exit(127) };
    }
    for program in &spec.programs {
        unsafe { libc::execve(program.as_ptr(), spec.argv.as_ptr(), spec.envp.as_ptr()) };
        let error = errno();
        if error != libc::ENOENT && error != libc::ENOTDIR {
            break;
        }
    }
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

unsafe fn close_many(descriptors: &[RawFd]) {
    for descriptor in descriptors {
        if *descriptor >= 0 {
            unsafe { libc::close(*descriptor) };
        }
    }
}

unsafe fn wait_raw(pid: libc::pid_t) -> libc::c_int {
    let mut status = 0;
    loop {
        let waited = unsafe { libc::waitpid(pid, &mut status, 0) };
        if waited == pid {
            return status;
        }
        if waited < 0 && errno() == libc::EINTR {
            continue;
        }
        return 127 << 8;
    }
}

unsafe fn exit_with_target_status(status: libc::c_int) -> ! {
    if libc::WIFEXITED(status) {
        unsafe { libc::_exit(libc::WEXITSTATUS(status)) };
    }
    if libc::WIFSIGNALED(status) {
        let signal = libc::WTERMSIG(status);
        unsafe { libc::kill(libc::getpid(), signal) };
        unsafe { libc::_exit(128 + signal) };
    }
    unsafe { libc::_exit(127) }
}

unsafe fn kill_group_and_exit(pgid: libc::pid_t) -> ! {
    unsafe { libc::kill(-pgid, libc::SIGKILL) };
    unsafe { libc::_exit(127) }
}

fn write_one(descriptor: RawFd, byte: u8) -> io::Result<()> {
    // SAFETY: the byte reference is valid and the descriptor is an owned pipe endpoint.
    let written = unsafe { libc::write(descriptor, (&raw const byte).cast(), 1) };
    if written == 1 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

unsafe fn read_one(descriptor: RawFd) -> Option<u8> {
    let mut byte = 0;
    loop {
        let read = unsafe { libc::read(descriptor, (&raw mut byte).cast(), 1) };
        if read == 1 {
            return Some(byte);
        }
        if read < 0 && errno() == libc::EINTR {
            continue;
        }
        return None;
    }
}

fn errno() -> libc::c_int {
    io::Error::last_os_error().raw_os_error().unwrap_or(0)
}
