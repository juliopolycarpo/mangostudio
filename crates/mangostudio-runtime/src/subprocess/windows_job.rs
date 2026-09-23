//! Windows Job-based process-tree containment.
//!
//! A child joins its non-inheritable Job in the same `CreateProcessW` call that
//! creates it. This closes the parent-death window that a suspended spawn and
//! later `AssignProcessToJobObject` would leave open.
#![allow(
    unsafe_code,
    reason = "the Job, extended startup attributes, and explicit HANDLE ownership have no safe \
              binding on Windows; every call is documented with its ownership and pointer invariant"
)]
#![deny(clippy::undocumented_unsafe_blocks)]
#![deny(clippy::cast_ptr_alignment)]

use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString, c_void};
use std::io;
use std::mem::{size_of, size_of_val};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::os::windows::process::ExitStatusExt;
use std::path::Path;
use std::process::ExitStatus;
use std::ptr;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncWrite};
use windows_sys::Win32::Foundation::{
    ERROR_INSUFFICIENT_BUFFER, ERROR_MORE_DATA, GENERIC_READ, HANDLE, HANDLE_FLAG_INHERIT,
    INVALID_HANDLE_VALUE, SetHandleInformation, WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::Globalization::{
    CSTR_EQUAL, CSTR_GREATER_THAN, CSTR_LESS_THAN, CompareStringOrdinal,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
};
use windows_sys::Win32::System::Console::{
    COORD, ClosePseudoConsole, CreatePseudoConsole, HPCON, ResizePseudoConsole,
};
use windows_sys::Win32::System::JobObjects::{
    CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_BASIC_PROCESS_ID_LIST,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectBasicProcessIdList,
    JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
    TerminateJobObject,
};
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::Threading::{
    CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, CreateProcessW, DeleteProcThreadAttributeList,
    EXTENDED_STARTUPINFO_PRESENT, GetExitCodeProcess, InitializeProcThreadAttributeList,
    LPPROC_THREAD_ATTRIBUTE_LIST, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
    PROC_THREAD_ATTRIBUTE_JOB_LIST, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, PROCESS_INFORMATION,
    ResumeThread, STARTF_USESTDHANDLES, STARTUPINFOEXW, UpdateProcThreadAttribute,
    WaitForSingleObject,
};

use super::{ProcessRequest, ProcessStdin};
use crate::blocking::run_blocking;

const JOB_EXIT_CODE: u32 = 1;
const JOB_EMPTY_POLL: Duration = Duration::from_millis(10);

/// A process created atomically inside a kill-on-close Job.
pub(crate) struct WindowsJobChild {
    pid: u32,
    process: Arc<Handle>,
    job: Arc<Handle>,
    thread: Option<Handle>,
    stdin: Option<tokio::fs::File>,
    stdout: Option<tokio::fs::File>,
    stderr: Option<tokio::fs::File>,
    pty: Option<Arc<PseudoConsole>>,
}

impl WindowsJobChild {
    pub(super) fn resize(
        &self,
        cols: u16,
        rows: u16,
    ) -> io::Result<impl std::future::Future<Output = io::Result<()>> + Send + 'static> {
        let pty = self.pty.as_ref().ok_or_else(|| {
            io::Error::new(io::ErrorKind::Unsupported, "process has no pseudo-console")
        })?;
        let pty = Arc::clone(pty);
        let size = console_size(cols, rows)?;
        Ok(async move {
            run_blocking(move || {
                // SAFETY: the cloned `pty` remains live for the call and `size` is a valid COORD.
                let result = unsafe { ResizePseudoConsole(pty.0, size) };
                if result < 0 {
                    Err(io::Error::from_raw_os_error(result))
                } else {
                    Ok(())
                }
            })
            .await
        })
    }

    pub(super) fn id(&self) -> Option<u32> {
        Some(self.pid)
    }

    pub(super) async fn wait_ready(&mut self) -> io::Result<()> {
        Ok(())
    }

    pub(super) fn release_start(&mut self) -> io::Result<()> {
        let Some(thread) = self.thread.take() else {
            return Ok(());
        };
        // SAFETY: this is the owned primary-thread handle returned by CreateProcessW. The target
        // was atomically placed in `job` before it was suspended, so resuming it cannot create an
        // uncontained process. `u32::MAX` is the documented failure sentinel.
        if unsafe { ResumeThread(thread.raw()) } == u32::MAX {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    pub(super) async fn wait_exec(&mut self) -> io::Result<()> {
        Ok(())
    }

    pub(super) fn take_stdout(&mut self) -> Option<Box<dyn AsyncRead + Send + Unpin>> {
        self.stdout
            .take()
            .map(|stdout| Box::new(stdout) as Box<dyn AsyncRead + Send + Unpin>)
    }

    pub(super) fn take_stderr(&mut self) -> Option<Box<dyn AsyncRead + Send + Unpin>> {
        self.stderr
            .take()
            .map(|stderr| Box::new(stderr) as Box<dyn AsyncRead + Send + Unpin>)
    }

    pub(super) fn take_stdin(&mut self) -> Option<Box<dyn AsyncWrite + Send + Unpin>> {
        self.stdin
            .take()
            .map(|stdin| Box::new(stdin) as Box<dyn AsyncWrite + Send + Unpin>)
    }

    pub(super) async fn wait_target(&mut self) -> io::Result<ExitStatus> {
        loop {
            if let Some(status) = poll_process(&self.process)? {
                return Ok(status);
            }
            tokio::time::sleep(JOB_EMPTY_POLL).await;
        }
    }

    /// Ends remaining descendants once capture has reached its bounded conclusion.
    pub(super) fn finalize(&mut self) -> io::Result<()> {
        terminate_job(&self.job)
    }

    /// Waits until the Job is empty, which proves every descendant has exited.
    pub(super) async fn wait_guardian(&mut self) -> io::Result<()> {
        let job = Arc::clone(&self.job);
        tokio::task::spawn_blocking(move || wait_for_job_empty(&job))
            .await
            .map_err(|error| {
                io::Error::other(format!("Windows Job cleanup task failed: {error}"))
            })?
    }

    /// Console control delivery is not safe for arbitrary detached child consoles.
    pub(super) fn interrupt(&mut self) -> io::Result<()> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "graceful interruption is unsupported for Windows Job-contained processes",
        ))
    }

    pub(super) fn force(&mut self) -> io::Result<()> {
        terminate_job(&self.job)
    }
}

/// Creates a child atomically associated with a non-inheritable kill-on-close Job.
pub(super) fn spawn(request: &ProcessRequest) -> io::Result<WindowsJobChild> {
    let job = Arc::new(create_killing_job()?);
    let pipes = ChildPipes::from_request(request)?;
    // A batch file is run by cmd.exe, which does not understand the MSVC quoting below; it gets
    // its own interpreter path and cmd.exe-safe command line (see `super::batch`).
    let (application, mut command_line) = if super::batch::is_batch(&request.program) {
        let launch = super::batch::BatchLaunch::new(request)?;
        (
            Some(wide_nul(launch.interpreter.as_os_str(), "program")?),
            wide_nul(OsStr::new(&launch.command_line), "command line")?,
        )
    } else {
        (
            application_name(request.program.as_os_str())?,
            command_line(request)?,
        )
    };
    let current_directory = request.cwd.as_deref().map(path_wide_nul).transpose()?;
    let environment = request.env.as_ref().map(environment_block).transpose()?;

    let jobs = [job.raw()];
    let inherited_handles = pipes.inherited_handles();
    let mut attributes = AttributeList::new(2)?;
    attributes.update(
        PROC_THREAD_ATTRIBUTE_JOB_LIST as usize,
        jobs.as_ptr().cast(),
        size_of_val(&jobs),
    )?;
    attributes.update(
        PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
        inherited_handles.as_ptr().cast(),
        size_of_val(&inherited_handles),
    )?;

    let mut startup = STARTUPINFOEXW::default();
    startup.StartupInfo.cb = u32::try_from(size_of::<STARTUPINFOEXW>())
        .expect("STARTUPINFOEXW size fits in a Win32 u32");
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = inherited_handles[0];
    startup.StartupInfo.hStdOutput = inherited_handles[1];
    startup.StartupInfo.hStdError = inherited_handles[2];
    startup.lpAttributeList = attributes.pointer();

    let environment_pointer = environment
        .as_ref()
        .map_or(ptr::null(), |block| block.as_ptr().cast::<c_void>());
    let current_directory_pointer = current_directory.as_ref().map_or(ptr::null(), Vec::as_ptr);
    let mut information = PROCESS_INFORMATION::default();
    let flags = CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT;

    // Inheritance is enabled here and revoked immediately below, so the three endpoints are
    // capturable by an unrelated `CreateProcessW` for this call alone rather than for the whole
    // of pipe creation, command-line encoding, and attribute-list setup. See
    // `ChildPipes::set_child_inheritable`.
    pipes.set_child_inheritable(true)?;
    // SAFETY: every UTF-16 buffer is NUL-terminated and remains live for this call; the command
    // line is writable; the Job and stdio backing handles remain owned by `job` and `pipes`; and
    // `attributes` owns the initialized attribute list plus its aligned backing storage.
    let created = unsafe {
        CreateProcessW(
            application.as_ref().map_or(ptr::null(), Vec::as_ptr),
            command_line.as_mut_ptr(),
            ptr::null(),
            ptr::null(),
            1,
            flags,
            environment_pointer,
            current_directory_pointer,
            &startup.StartupInfo,
            &mut information,
        )
    };
    // Captured before the revoke below, which would otherwise overwrite the thread's last error.
    let create_error = io::Error::last_os_error();
    // Best effort: these endpoints are closed a few statements below in either outcome, and a
    // failure to revoke must not mask why the spawn itself failed.
    let _ = pipes.set_child_inheritable(false);
    if created == 0 {
        return Err(create_error);
    }

    // SAFETY: a successful CreateProcessW transfers one owned process and primary-thread handle.
    // The primary thread remains suspended until the supervisor has completed its last pre-effect
    // cancellation check, so retain it until `release_start` resumes it.
    let (process, thread) = unsafe {
        (
            Handle::from_raw(information.hProcess),
            Handle::from_raw(information.hThread),
        )
    };
    let ParentPipes {
        stdin,
        stdout,
        stderr,
    } = pipes.into_parent();

    Ok(WindowsJobChild {
        pid: information.dwProcessId,
        process: Arc::new(process),
        job,
        thread: Some(thread),
        stdin,
        stdout: Some(stdout),
        stderr: Some(stderr),
        pty: None,
    })
}

/// Starts a ConPTY target atomically inside the same kill-on-close Job used by bounded children.
pub(super) fn spawn_pty(
    request: &ProcessRequest,
    cols: u16,
    rows: u16,
) -> io::Result<WindowsJobChild> {
    let job = Arc::new(create_killing_job()?);
    let Pipe {
        parent: stdin,
        child: conpty_input,
    } = create_pipe(false)?;
    let Pipe {
        parent: stdout,
        child: conpty_output,
    } = create_pipe(true)?;
    let pty = Arc::new(PseudoConsole::new(
        console_size(cols, rows)?,
        &conpty_input,
        &conpty_output,
    )?);
    // The child creation still needs these handles live. Microsoft closes the originals only
    // after CreateProcessW has attached the pseudo-console to the target.
    let application = application_name(request.program.as_os_str())?;
    let mut command_line = command_line(request)?;
    let current_directory = request.cwd.as_deref().map(path_wide_nul).transpose()?;
    let environment = request.env.as_ref().map(environment_block).transpose()?;
    let jobs = [job.raw()];
    let mut attributes = AttributeList::new(2)?;
    attributes.update(
        PROC_THREAD_ATTRIBUTE_JOB_LIST as usize,
        jobs.as_ptr().cast(),
        size_of_val(&jobs),
    )?;
    // The ConPTY attribute takes the opaque HPCON value as lpValue, unlike the Job-list
    // attribute, which takes a pointer to an array of HANDLEs.
    attributes.update(
        PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize,
        pty.0 as *const c_void,
        size_of::<HPCON>(),
    )?;
    let mut startup = STARTUPINFOEXW::default();
    startup.StartupInfo.cb =
        u32::try_from(size_of::<STARTUPINFOEXW>()).expect("STARTUPINFOEXW fits u32");
    // Keep the inherited standard console handles out of the child. ConPTY supplies its own.
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.lpAttributeList = attributes.pointer();
    let environment_pointer = environment
        .as_ref()
        .map_or(ptr::null(), |block| block.as_ptr().cast::<c_void>());
    let current_directory_pointer = current_directory.as_ref().map_or(ptr::null(), Vec::as_ptr);
    let mut information = PROCESS_INFORMATION::default();
    let flags = CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT;
    // SAFETY: all UTF-16 buffers and both process attributes remain live throughout CreateProcessW;
    // the Job and ConPTY are owned by this scope and move to the child wrapper on success.
    let created = unsafe {
        CreateProcessW(
            application.as_ref().map_or(ptr::null(), Vec::as_ptr),
            command_line.as_mut_ptr(),
            ptr::null(),
            ptr::null(),
            0,
            flags,
            environment_pointer,
            current_directory_pointer,
            &startup.StartupInfo,
            &mut information,
        )
    };
    let create_error = io::Error::last_os_error();
    drop(conpty_input);
    drop(conpty_output);
    if created == 0 {
        return Err(create_error);
    }
    // SAFETY: a successful CreateProcessW transfers one process and primary-thread handle.
    let (process, thread) = unsafe {
        (
            Handle::from_raw(information.hProcess),
            Handle::from_raw(information.hThread),
        )
    };
    Ok(WindowsJobChild {
        pid: information.dwProcessId,
        process: Arc::new(process),
        job,
        thread: Some(thread),
        stdin: Some(tokio::fs::File::from_std(stdin.into_file())),
        stdout: Some(tokio::fs::File::from_std(stdout.into_file())),
        stderr: None,
        pty: Some(pty),
    })
}

fn console_size(cols: u16, rows: u16) -> io::Result<COORD> {
    let x = i16::try_from(cols).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("terminal columns {cols} exceed ConPTY maximum {}", i16::MAX),
        )
    })?;
    let y = i16::try_from(rows).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("terminal rows {rows} exceed ConPTY maximum {}", i16::MAX),
        )
    })?;
    if x == 0 || y == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("terminal size {cols}x{rows} requires nonzero columns and rows"),
        ));
    }
    Ok(COORD { X: x, Y: y })
}

struct PseudoConsole(HPCON);

impl PseudoConsole {
    fn new(size: COORD, input: &Handle, output: &Handle) -> io::Result<Self> {
        let mut handle = 0;
        // SAFETY: both pipe handles remain open for this call and `handle` is writable output.
        let result =
            unsafe { CreatePseudoConsole(size, input.raw(), output.raw(), 0, &mut handle) };
        if result < 0 {
            Err(io::Error::from_raw_os_error(result))
        } else {
            Ok(Self(handle))
        }
    }
}

impl Drop for PseudoConsole {
    fn drop(&mut self) {
        // SAFETY: CreatePseudoConsole gave this wrapper unique ownership of the HPCON.
        unsafe { ClosePseudoConsole(self.0) };
    }
}

struct Handle(OwnedHandle);

impl Handle {
    /// `raw` is a newly created Win32 handle whose ownership transfers to this wrapper.
    unsafe fn from_raw(raw: HANDLE) -> Self {
        // SAFETY: the caller transfers the unique ownership documented above.
        Self(unsafe { OwnedHandle::from_raw_handle(raw) })
    }

    fn raw(&self) -> HANDLE {
        self.0.as_raw_handle()
    }

    fn into_file(self) -> std::fs::File {
        self.0.into()
    }
}

struct ParentPipes {
    stdin: Option<tokio::fs::File>,
    stdout: tokio::fs::File,
    stderr: tokio::fs::File,
}

struct ChildPipes {
    stdin: Handle,
    stdout: Handle,
    stderr: Handle,
    parent_stdin: Option<Handle>,
    parent_stdout: Handle,
    parent_stderr: Handle,
}

impl ChildPipes {
    fn from_request(request: &ProcessRequest) -> io::Result<Self> {
        let (stdin, parent_stdin) = match request.stdin {
            ProcessStdin::Null => (null_stdin()?, None),
            ProcessStdin::Bytes(_) => {
                let pipe = create_pipe(false)?;
                (pipe.child, Some(pipe.parent))
            }
        };
        let stdout = create_pipe(true)?;
        let stderr = create_pipe(true)?;

        Ok(Self {
            stdin,
            stdout: stdout.child,
            stderr: stderr.child,
            parent_stdin,
            parent_stdout: stdout.parent,
            parent_stderr: stderr.parent,
        })
    }

    fn inherited_handles(&self) -> [HANDLE; 3] {
        [self.stdin.raw(), self.stdout.raw(), self.stderr.raw()]
    }

    /// Marks exactly the three endpoints this child inherits, for exactly the window `spawn`
    /// needs them.
    ///
    /// Inheritance on Windows is a property of the handle, not of the call that uses it: every
    /// handle marked inheritable is captured by every concurrent `CreateProcessW` in this process
    /// that requests inheritance without an explicit handle list — `std::process::Command` is one.
    /// The attribute handle list below bounds what *this* child receives; it cannot stop an
    /// unrelated spawn elsewhere from capturing these. Keeping them non-inheritable outside the
    /// call is what does, and it matters most for stdout and stderr: a leaked write endpoint keeps
    /// the pipe's write side open in a process that never reads it, so this parent's reader never
    /// observes EOF and a clean exit is published as a drain timeout instead.
    fn set_child_inheritable(&self, inheritable: bool) -> io::Result<()> {
        set_inheritable(&self.stdin, inheritable)?;
        set_inheritable(&self.stdout, inheritable)?;
        set_inheritable(&self.stderr, inheritable)
    }

    fn into_parent(self) -> ParentPipes {
        ParentPipes {
            stdin: self
                .parent_stdin
                .map(|handle| tokio::fs::File::from_std(handle.into_file())),
            stdout: tokio::fs::File::from_std(self.parent_stdout.into_file()),
            stderr: tokio::fs::File::from_std(self.parent_stderr.into_file()),
        }
    }
}

struct Pipe {
    parent: Handle,
    child: Handle,
}

fn create_pipe(parent_reads: bool) -> io::Result<Pipe> {
    let mut read = ptr::null_mut();
    let mut write = ptr::null_mut();
    // SAFETY: both output pointers are valid for this call. A null security descriptor requests
    // default security and, deliberately, two *non*-inheritable endpoints: `spawn` turns
    // inheritance on for the child endpoint alone, and only across its `CreateProcessW` call.
    if unsafe { CreatePipe(&mut read, &mut write, ptr::null(), 0) } == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: successful CreatePipe returns exactly two owned handles.
    let (read, write) = unsafe { (Handle::from_raw(read), Handle::from_raw(write)) };
    let (parent, child) = if parent_reads {
        (read, write)
    } else {
        (write, read)
    };
    Ok(Pipe { parent, child })
}

fn null_stdin() -> io::Result<Handle> {
    let name = [u16::from(b'N'), u16::from(b'U'), u16::from(b'L'), 0];
    // SAFETY: `name` is NUL-terminated. A null security descriptor requests default security and,
    // deliberately, a *non*-inheritable handle: `spawn` turns inheritance on only across its
    // `CreateProcessW` call, where the exact attribute handle list limits it to this handle.
    let handle = unsafe {
        CreateFileW(
            name.as_ptr(),
            GENERIC_READ,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            ptr::null(),
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        Err(io::Error::last_os_error())
    } else {
        // SAFETY: CreateFileW returned one owned, valid handle.
        Ok(unsafe { Handle::from_raw(handle) })
    }
}

fn create_killing_job() -> io::Result<Handle> {
    // SAFETY: null values request an unnamed Job with the default security descriptor.
    let job = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
    if job.is_null() {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: CreateJobObjectW returned a uniquely owned Job handle.
    let job = unsafe { Handle::from_raw(job) };
    set_inheritable(&job, false)?;

    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    // SAFETY: `limits` has the exact layout and lifetime required by this information class.
    if unsafe {
        SetInformationJobObject(
            job.raw(),
            JobObjectExtendedLimitInformation,
            ptr::addr_of!(limits).cast(),
            u32::try_from(size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>())
                .expect("Job limit structure size fits in a Win32 u32"),
        )
    } == 0
    {
        Err(io::Error::last_os_error())
    } else {
        Ok(job)
    }
}

fn set_inheritable(handle: &Handle, inheritable: bool) -> io::Result<()> {
    // SAFETY: `handle` remains owned and valid for the call.
    if unsafe { SetHandleInformation(handle.raw(), HANDLE_FLAG_INHERIT, u32::from(inheritable)) }
        == 0
    {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

struct AttributeList {
    storage: Box<[usize]>,
}

impl AttributeList {
    fn new(count: u32) -> io::Result<Self> {
        let mut bytes = 0_usize;
        // SAFETY: the documented probe passes a null list and receives its byte requirement.
        let result =
            unsafe { InitializeProcThreadAttributeList(ptr::null_mut(), count, 0, &mut bytes) };
        let probe_error = io::Error::last_os_error();
        if result != 0
            || probe_error.raw_os_error()
                != Some(i32::try_from(ERROR_INSUFFICIENT_BUFFER).expect("Win32 error fits i32"))
            || bytes == 0
        {
            return Err(if result != 0 {
                io::Error::other("attribute-list size probe unexpectedly succeeded")
            } else {
                probe_error
            });
        }
        let words = bytes
            .checked_add(size_of::<usize>() - 1)
            .ok_or_else(|| io::Error::other("process attribute list is too large"))?
            / size_of::<usize>();
        let mut storage = vec![0_usize; words].into_boxed_slice();
        let mut initialized_bytes = words * size_of::<usize>();
        // SAFETY: `usize` storage is correctly aligned, stable, and large enough for the probed
        // byte size. It remains owned until `DeleteProcThreadAttributeList` runs in Drop.
        if unsafe {
            InitializeProcThreadAttributeList(
                storage.as_mut_ptr().cast(),
                count,
                0,
                &mut initialized_bytes,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(Self { storage })
    }

    fn update(&mut self, attribute: usize, value: *const c_void, bytes: usize) -> io::Result<()> {
        // SAFETY: the list is initialized; `value` points to `bytes` stable readable bytes through
        // CreateProcessW; and the selected attributes accept HANDLE arrays of these exact sizes.
        if unsafe {
            UpdateProcThreadAttribute(
                self.pointer(),
                0,
                attribute,
                value,
                bytes,
                ptr::null_mut(),
                ptr::null(),
            )
        } == 0
        {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }

    fn pointer(&self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        self.storage.as_ptr().cast_mut().cast()
    }
}

impl Drop for AttributeList {
    fn drop(&mut self) {
        // SAFETY: construction succeeds only after initialization and this is the sole owner.
        unsafe { DeleteProcThreadAttributeList(self.pointer()) };
    }
}

fn poll_process(process: &Handle) -> io::Result<Option<ExitStatus>> {
    // A zero-timeout wait keeps this future cancellation-safe. Repeated unsupported interrupt
    // requests can cancel the surrounding select without leaving one blocking OS waiter behind
    // for each request.
    // SAFETY: the Arc retained by WindowsJobChild keeps this process handle valid for the poll.
    let result = unsafe { WaitForSingleObject(process.raw(), 0) };
    if result == WAIT_TIMEOUT {
        return Ok(None);
    }
    if result == WAIT_FAILED {
        return Err(io::Error::last_os_error());
    }
    if result != WAIT_OBJECT_0 {
        return Err(io::Error::other(format!(
            "polling Windows process returned unexpected code {result}"
        )));
    }
    let mut exit_code = 0;
    // SAFETY: the completed process handle remains valid for this query.
    if unsafe { GetExitCodeProcess(process.raw(), &mut exit_code) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(Some(ExitStatus::from_raw(exit_code)))
}

fn terminate_job(job: &Handle) -> io::Result<()> {
    // SAFETY: the WindowsJobChild retains the Job handle throughout supervision.
    if unsafe { TerminateJobObject(job.raw(), JOB_EXIT_CODE) } == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn wait_for_job_empty(job: &Handle) -> io::Result<()> {
    let mut words = vec![0_usize; 64];
    loop {
        let byte_len = u32::try_from(size_of_val(words.as_slice()))
            .map_err(|_| io::Error::other("Windows Job process list is too large"))?;
        let mut required = 0_u32;
        // SAFETY: `words` is aligned, writable storage for a process-ID list and remains valid for
        // the query. A successful call writes only this information class's documented layout.
        if unsafe {
            QueryInformationJobObject(
                job.raw(),
                JobObjectBasicProcessIdList,
                words.as_mut_ptr().cast(),
                byte_len,
                &mut required,
            )
        } != 0
        {
            // SAFETY: QueryInformationJobObject populated the beginning of this aligned backing
            // storage with a JOBOBJECT_BASIC_PROCESS_ID_LIST on success.
            let list = unsafe { &*words.as_ptr().cast::<JOBOBJECT_BASIC_PROCESS_ID_LIST>() };
            if list.NumberOfAssignedProcesses == 0 {
                return Ok(());
            }
            std::thread::sleep(JOB_EMPTY_POLL);
            continue;
        }

        let error = io::Error::last_os_error();
        if error.raw_os_error()
            != Some(i32::try_from(ERROR_MORE_DATA).expect("Win32 error fits i32"))
        {
            return Err(error);
        }
        let required_words = usize::try_from(required)
            .map_err(|_| io::Error::other("Windows Job process list size does not fit usize"))?
            .div_ceil(size_of::<usize>());
        let next_len = words.len().saturating_mul(2).max(required_words);
        if next_len <= words.len() {
            return Err(io::Error::other("Windows Job process list is too large"));
        }
        words.resize(next_len, 0);
    }
}

fn command_line(request: &ProcessRequest) -> io::Result<Vec<u16>> {
    let mut output = Vec::new();
    append_command_argument(&mut output, request.program.as_os_str(), "program")?;
    for argument in &request.args {
        append_command_argument(&mut output, argument, "argument")?;
    }
    output.push(0);
    Ok(output)
}

fn append_command_argument(output: &mut Vec<u16>, value: &OsStr, name: &str) -> io::Result<()> {
    let value = wide(value, name)?;
    if !output.is_empty() {
        output.push(u16::from(b' '));
    }
    let quote = value.is_empty() || value.iter().any(|unit| matches!(*unit, 0x09 | 0x20 | 0x22));
    if !quote {
        output.extend(value);
        return Ok(());
    }

    output.push(u16::from(b'"'));
    let mut backslashes = 0_usize;
    for unit in value {
        if unit == u16::from(b'\\') {
            backslashes += 1;
            continue;
        }
        if unit == u16::from(b'"') {
            output.extend(std::iter::repeat_n(u16::from(b'\\'), backslashes * 2 + 1));
            output.push(unit);
            backslashes = 0;
            continue;
        }
        output.extend(std::iter::repeat_n(u16::from(b'\\'), backslashes));
        output.push(unit);
        backslashes = 0;
    }
    output.extend(std::iter::repeat_n(u16::from(b'\\'), backslashes * 2));
    output.push(u16::from(b'"'));
    Ok(())
}

fn environment_block(environment: &BTreeMap<OsString, OsString>) -> io::Result<Vec<u16>> {
    let mut entries = environment
        .iter()
        .map(|(key, value)| Ok((environment_key(key)?, wide(value, "environment value")?)))
        .collect::<io::Result<Vec<_>>>()?;
    entries.sort_by(|(left, _), (right, _)| case_insensitive_wide_cmp(left, right));
    for pair in entries.windows(2) {
        if case_insensitive_wide_cmp(&pair[0].0, &pair[1].0) == Ordering::Equal {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "process environment contains duplicate case-insensitive key {:?}",
                    String::from_utf16_lossy(&pair[1].0)
                ),
            ));
        }
    }

    let mut block = Vec::new();
    for (key, value) in entries {
        block.extend(key);
        block.push(u16::from(b'='));
        block.extend(value);
        block.push(0);
    }
    block.push(0);
    if block.len() == 1 {
        block.push(0);
    }
    Ok(block)
}

fn environment_key(key: &OsStr) -> io::Result<Vec<u16>> {
    let key = wide(key, "environment key")?;
    if key.is_empty() || key.contains(&u16::from(b'=')) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "process environment key must be non-empty and cannot contain '='",
        ));
    }
    Ok(key)
}

fn case_insensitive_wide_cmp(left: &[u16], right: &[u16]) -> Ordering {
    let left_length = i32::try_from(left.len()).expect("an allocated UTF-16 string fits i32");
    let right_length = i32::try_from(right.len()).expect("an allocated UTF-16 string fits i32");
    // SAFETY: the slices remain readable for their supplied UTF-16-unit lengths. Windows uses
    // this ordinal comparison for case-insensitive environment names, including non-ASCII keys.
    match unsafe {
        CompareStringOrdinal(left.as_ptr(), left_length, right.as_ptr(), right_length, 1)
    } {
        CSTR_LESS_THAN => Ordering::Less,
        CSTR_EQUAL => Ordering::Equal,
        CSTR_GREATER_THAN => Ordering::Greater,
        _ => left.cmp(right),
    }
}

fn path_wide_nul(path: &Path) -> io::Result<Vec<u16>> {
    wide_nul(path.as_os_str(), "cwd")
}

fn application_name(value: &OsStr) -> io::Result<Option<Vec<u16>>> {
    // A null `lpApplicationName` makes CreateProcessW resolve a bare executable through PATH;
    // the mutable command line still carries the exact program token. Supplying a non-null bare
    // name asks Windows to open that literal path and breaks commands such as `git` and `gh`.
    let has_path_separator = value
        .encode_wide()
        .any(|unit| unit == u16::from(b'\\') || unit == u16::from(b'/'));
    if has_path_separator {
        wide_nul(value, "program").map(Some)
    } else {
        Ok(None)
    }
}

fn wide_nul(value: &OsStr, name: &str) -> io::Result<Vec<u16>> {
    let mut value = wide(value, name)?;
    value.push(0);
    Ok(value)
}

fn wide(value: &OsStr, name: &str) -> io::Result<Vec<u16>> {
    let value = value.encode_wide().collect::<Vec<_>>();
    if value.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("process {name} contains a NUL code unit"),
        ));
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::ffi::{OsStr, OsString};
    use std::time::Duration;

    use super::{
        ChildPipes, HANDLE, HANDLE_FLAG_INHERIT, application_name, command_line, environment_block,
        spawn_pty,
    };
    use crate::subprocess::{ProcessRequest, ProcessStdin};

    #[tokio::test]
    async fn conpty_target_waits_for_explicit_release() {
        let request = ProcessRequest::new("cmd.exe", ["/C", "exit", "0"]);
        let mut child = crate::blocking::run_blocking(move || spawn_pty(&request, 80, 24))
            .await
            .expect("ConPTY child starts suspended");
        child.wait_ready().await.expect("child is ready");
        assert!(
            tokio::time::timeout(Duration::from_millis(500), child.wait_target())
                .await
                .is_err(),
            "ConPTY child executed before the launch gate released it"
        );
        child.release_start().expect("launch gate resumes child");
        let status = tokio::time::timeout(Duration::from_secs(5), child.wait_target())
            .await
            .expect("released child exits")
            .expect("native status is observed");
        child.finalize().expect("Job is terminated");
        child.wait_guardian().await.expect("Job is empty");
        crate::blocking::run_blocking(move || drop(child)).await;
        assert_eq!(status.code(), Some(0));
    }

    /// Whether Windows would hand `handle` to a child of an inheriting `CreateProcessW`.
    fn is_inheritable(handle: HANDLE) -> bool {
        let mut flags = 0_u32;
        // SAFETY: `handle` is one of the endpoints owned by the `ChildPipes` the caller still
        // holds, so it stays valid for this query.
        let queried =
            unsafe { windows_sys::Win32::Foundation::GetHandleInformation(handle, &raw mut flags) };
        assert!(
            queried != 0,
            "GetHandleInformation failed | {}",
            std::io::Error::last_os_error()
        );
        flags & HANDLE_FLAG_INHERIT != 0
    }

    /// The child endpoints must be inheritable only while `spawn` is inside `CreateProcessW`.
    ///
    /// Inheritance is a property of the handle, so any concurrent `CreateProcessW` in this
    /// process that inherits without an explicit handle list — `std::process::Command` does —
    /// captures whatever is marked inheritable at that instant. A captured stdout or stderr write
    /// endpoint keeps the pipe's write side open in a process that never reads it, so the
    /// supervisor's reader never observes EOF and publishes a clean exit as a drain timeout.
    #[test]
    fn child_endpoints_are_inheritable_only_across_the_spawn_call() {
        let request = ProcessRequest::new("fixture.exe", ["argument"])
            .with_stdin(ProcessStdin::Bytes(b"input".to_vec()));
        let pipes = ChildPipes::from_request(&request).expect("child pipes are created");

        for (stream, handle) in ["stdin", "stdout", "stderr"]
            .into_iter()
            .zip(pipes.inherited_handles())
        {
            assert!(
                !is_inheritable(handle),
                "{stream} endpoint is inheritable before the spawn call | expected inheritance to \
                 be off until CreateProcessW"
            );
        }

        pipes
            .set_child_inheritable(true)
            .expect("inheritance is enabled for the spawn call");
        for (stream, handle) in ["stdin", "stdout", "stderr"]
            .into_iter()
            .zip(pipes.inherited_handles())
        {
            assert!(
                is_inheritable(handle),
                "{stream} endpoint is not inheritable during the spawn call | the child would \
                 receive an invalid standard handle"
            );
        }

        pipes
            .set_child_inheritable(false)
            .expect("inheritance is revoked after the spawn call");
        for (stream, handle) in ["stdin", "stdout", "stderr"]
            .into_iter()
            .zip(pipes.inherited_handles())
        {
            assert!(
                !is_inheritable(handle),
                "{stream} endpoint is still inheritable after the spawn call | an unrelated \
                 CreateProcessW would capture it"
            );
        }
    }

    #[test]
    fn command_line_quotes_windows_arguments() {
        let request = ProcessRequest::new("fixture.exe", ["plain", "has space", ""]);

        let mut expected = "fixture.exe plain \"has space\" \"\""
            .encode_utf16()
            .collect::<Vec<_>>();
        expected.push(0);

        assert_eq!(
            command_line(&request).expect("command line should encode"),
            expected
        );
    }

    #[test]
    fn command_line_escapes_backslashes_before_a_quote() {
        let request = ProcessRequest::new("fixture.exe", [r#"one\"two"#]);
        let encoded = command_line(&request).expect("command line should encode");
        let rendered = String::from_utf16_lossy(&encoded);

        assert_eq!(rendered, "fixture.exe \"one\\\\\\\"two\"\0");
    }

    #[test]
    fn bare_programs_use_windows_path_search() {
        assert!(
            application_name(OsStr::new("git"))
                .expect("bare program has no invalid characters")
                .is_none()
        );
        assert!(
            application_name(OsStr::new(r"C:\\tools\\git.exe"))
                .expect("explicit path is valid")
                .is_some()
        );
    }

    #[test]
    fn empty_environment_has_required_double_nul_terminator() {
        assert_eq!(
            environment_block(&BTreeMap::new()).expect("empty block should encode"),
            [0, 0]
        );
    }

    #[test]
    fn environment_rejects_case_insensitive_duplicate_keys() {
        let environment = BTreeMap::from([
            (OsString::from("Path"), OsString::from("first")),
            (OsString::from("PATH"), OsString::from("second")),
        ]);

        let error = environment_block(&environment).expect_err("Windows environment keys collide");

        assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);
        assert!(error.to_string().contains("duplicate case-insensitive key"));
    }

    #[test]
    fn environment_rejects_non_ascii_casefold_duplicate_keys() {
        let environment = BTreeMap::from([
            (OsString::from("VÄR"), OsString::from("first")),
            (OsString::from("vär"), OsString::from("second")),
        ]);

        let error = environment_block(&environment).expect_err("Windows environment keys collide");

        assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);
    }
}
