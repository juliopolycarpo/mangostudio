//! Unix process-group containment owned by a small post-fork guardian.
//!
//! The runtime process prepares every allocation, environment entry, and descriptor before
//! forking. The guardian, its parent-death watchdog, and the target then use only direct libc
//! calls. The guardian becomes a process-group leader before it forks the target, so the target
//! can never exist outside the group the watchdog kills on parent death. The watchdog stays alive
//! until the runtime acknowledges final capture, which closes the leader-exit gap for ordinary
//! descendants that do not retain stdout or stderr.

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
use std::sync::{Mutex, OnceLock};

use tokio::io::{AsyncReadExt, AsyncWrite};
use tokio::net::unix::pipe::{Receiver, Sender};
use tokio::task::JoinHandle;

use super::{ProcessRequest, ProcessStdin};

const READY: u8 = b'R';
const RELEASE: u8 = b'G';
const FINALIZE: u8 = b'F';
const STATUS_BYTES: usize = std::mem::size_of::<libc::c_int>();

pub(super) struct GuardianChild {
    pid: libc::pid_t,
    stdin: Option<Sender>,
    stdout: Option<Receiver>,
    stderr: Option<Receiver>,
    ready: Receiver,
    status: Receiver,
    start: Option<OwnedFd>,
    finalize: Option<OwnedFd>,
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
        write_one_parent(start.as_raw_fd(), RELEASE)
    }

    /// Waits for the direct target's status, before the guardian tears down the remaining group.
    pub(super) async fn wait_target(&mut self) -> io::Result<ExitStatus> {
        let mut bytes = [0; STATUS_BYTES];
        self.status.read_exact(&mut bytes).await?;
        Ok(ExitStatus::from_raw(libc::c_int::from_ne_bytes(bytes)))
    }

    /// Lets the guardian terminate its group after capture has reached a bounded conclusion.
    pub(super) fn finalize(&mut self) -> io::Result<()> {
        let Some(finalize) = self.finalize.take() else {
            return Ok(());
        };
        write_one_parent(finalize.as_raw_fd(), FINALIZE)
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

    /// Reaps the guardian after it has been finalized or force-killed.
    pub(super) async fn wait_guardian(&mut self) -> io::Result<()> {
        (&mut self.wait)
            .await
            .map_err(|error| {
                io::Error::other(format!("process guardian wait task failed: {error}"))
            })?
            .map(|_| ())
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
        let RawGuardianChild {
            pid,
            stdin,
            stdout,
            stderr,
            ready,
            status,
            start,
            finalize,
            liveness,
        } = raw;
        set_nonblocking(&ready)?;
        set_nonblocking(&status)?;
        set_nonblocking(&stdout)?;
        set_nonblocking(&stderr)?;
        if let Some(stdin) = &stdin {
            set_nonblocking(stdin)?;
        }

        let ready = Receiver::from_owned_fd(ready)?;
        let status = Receiver::from_owned_fd(status)?;
        let stdout = Receiver::from_owned_fd(stdout)?;
        let stderr = Receiver::from_owned_fd(stderr)?;
        let stdin = stdin.map(Sender::from_owned_fd).transpose()?;
        let wait = tokio::task::spawn_blocking(move || wait_for_guardian(pid));

        Ok(Self {
            pid,
            stdin,
            stdout: Some(stdout),
            stderr: Some(stderr),
            ready,
            status,
            start: Some(start),
            finalize: Some(finalize),
            _liveness: liveness,
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
    status: OwnedFd,
    start: OwnedFd,
    finalize: OwnedFd,
    liveness: OwnedFd,
}

struct GuardianFds {
    liveness_read: RawFd,
    ready_write: RawFd,
    status_write: RawFd,
    start_read: RawFd,
    finalize_read: RawFd,
    stdin_target: RawFd,
    stdout_target: RawFd,
    stderr_target: RawFd,
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
    // OS environment entries cannot contain a NUL byte.
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

fn spawn_raw(request: &ProcessRequest) -> io::Result<RawGuardianChild> {
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
    let (start_read, start_write) = pipe_cloexec()?;
    let (finalize_read, finalize_write) = pipe_cloexec()?;
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
        ready_write: ready_write.as_raw_fd(),
        status_write: status_write.as_raw_fd(),
        start_read: start_read.as_raw_fd(),
        finalize_read: finalize_read.as_raw_fd(),
        stdin_target: stdin_target.as_raw_fd(),
        stdout_target: stdout_write.as_raw_fd(),
        stderr_target: stderr_write.as_raw_fd(),
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
        ready: ready_read,
        status: status_read,
        start: start_write,
        finalize: finalize_write,
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

#[cfg(not(any(target_os = "linux", target_os = "android")))]
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
                fds.start_read,
                fds.finalize_read,
                fds.stdin_target,
                fds.stdout_target,
                fds.stderr_target,
            ],
            fds.descriptor_limit,
        )
    };
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
    unsafe {
        close_except(
            &[fds.ready_write, fds.status_write, fds.finalize_read],
            fds.descriptor_limit,
        )
    };
    if !write_one_raw(fds.ready_write, READY) {
        kill_group_and_exit(pgid);
    }
    unsafe { libc::close(fds.ready_write) };

    let status = wait_raw(target);
    if !write_status_raw(fds.status_write, status) {
        kill_group_and_exit(pgid);
    }
    unsafe { libc::close(fds.status_write) };
    // The parent either acknowledges bounded capture or disappears. In both cases, terminate
    // every ordinary descendant before the guardian itself exits. The watchdog remains alive
    // during this wait, so a runtime SIGKILL cannot open a leader-exit cleanup gap.
    if read_one_raw(fds.finalize_read) != Some(FINALIZE) {
        kill_group_and_exit(pgid);
    }
    kill_group_and_exit(pgid)
}

unsafe fn watchdog_main(fds: GuardianFds, pgid: libc::pid_t) -> ! {
    unsafe { close_except(&[fds.liveness_read], fds.descriptor_limit) };
    loop {
        let mut byte = 0;
        let read = unsafe { libc::read(fds.liveness_read, (&raw mut byte).cast(), 1) };
        if read == 0 {
            kill_group_and_exit(pgid);
        }
        if read < 0 && unsafe { errno_raw() } == libc::EINTR {
            continue;
        }
        if read < 0 {
            kill_group_and_exit(pgid);
        }
    }
}

unsafe fn target_main(fds: GuardianFds, spec: &ExecSpec) -> ! {
    unsafe {
        close_except(
            &[
                fds.start_read,
                fds.stdin_target,
                fds.stdout_target,
                fds.stderr_target,
            ],
            fds.descriptor_limit,
        )
    };
    if read_one_raw(fds.start_read) != Some(RELEASE) {
        unsafe { libc::_exit(127) };
    }
    unsafe { libc::close(fds.start_read) };
    if unsafe { dup_stdio(fds.stdin_target, fds.stdout_target, fds.stderr_target) }.is_err() {
        unsafe { libc::_exit(127) };
    }
    if let Some(cwd) = &spec.cwd
        && unsafe { libc::chdir(cwd.as_ptr()) } != 0
    {
        unsafe { libc::_exit(127) };
    }
    for program in &spec.programs {
        unsafe { libc::execve(program.as_ptr(), spec.argv.as_ptr(), spec.envp.as_ptr()) };
        let error = unsafe { errno_raw() };
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
    let mut sorted = [-1; 8];
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

unsafe fn kill_group_and_exit(pgid: libc::pid_t) -> ! {
    unsafe { libc::kill(-pgid, libc::SIGKILL) };
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

unsafe fn write_one_raw(descriptor: RawFd, byte: u8) -> bool {
    loop {
        let written = unsafe { libc::write(descriptor, (&raw const byte).cast(), 1) };
        if written == 1 {
            return true;
        }
        if written < 0 && unsafe { errno_raw() } == libc::EINTR {
            continue;
        }
        return false;
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
