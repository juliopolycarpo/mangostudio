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
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
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
    PROC_THREAD_ATTRIBUTE_JOB_LIST, PROCESS_INFORMATION, ResumeThread, STARTF_USESTDHANDLES,
    STARTUPINFOEXW, UpdateProcThreadAttribute, WaitForSingleObject,
};

use super::{ProcessRequest, ProcessStdin};

const JOB_EXIT_CODE: u32 = 1;
const JOB_EMPTY_POLL: Duration = Duration::from_millis(10);

/// A process created atomically inside a kill-on-close Job.
pub(super) struct WindowsJobChild {
    pid: u32,
    process: Arc<Handle>,
    job: Arc<Handle>,
    thread: Option<Handle>,
    stdin: Option<tokio::fs::File>,
    stdout: Option<tokio::fs::File>,
    stderr: Option<tokio::fs::File>,
}

impl WindowsJobChild {
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
    let application = wide_nul(request.program.as_os_str(), "program")?;
    let mut command_line = command_line(request)?;
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

    // SAFETY: every UTF-16 buffer is NUL-terminated and remains live for this call; the command
    // line is writable; the Job and stdio backing handles remain owned by `job` and `pipes`; and
    // `attributes` owns the initialized attribute list plus its aligned backing storage.
    if unsafe {
        CreateProcessW(
            application.as_ptr(),
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
    } == 0
    {
        return Err(io::Error::last_os_error());
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
    })
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
    let attributes = inheritable_attributes();
    let mut read = ptr::null_mut();
    let mut write = ptr::null_mut();
    // SAFETY: output pointers and SECURITY_ATTRIBUTES are valid for this call. Both handles are
    // immediately adopted, then only the child endpoint is retained in the attribute handle list.
    if unsafe { CreatePipe(&mut read, &mut write, &attributes, 0) } == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: successful CreatePipe returns exactly two owned handles.
    let (read, write) = unsafe { (Handle::from_raw(read), Handle::from_raw(write)) };
    let (parent, child) = if parent_reads {
        (read, write)
    } else {
        (write, read)
    };
    set_inheritable(&parent, false)?;
    Ok(Pipe { parent, child })
}

fn null_stdin() -> io::Result<Handle> {
    let name = [u16::from(b'N'), u16::from(b'U'), u16::from(b'L'), 0];
    let attributes = inheritable_attributes();
    // SAFETY: `name` is NUL-terminated and the supplied security attributes make the child
    // endpoint inheritable. The exact attribute handle list limits inheritance to this handle.
    let handle = unsafe {
        CreateFileW(
            name.as_ptr(),
            GENERIC_READ,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            &attributes,
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

fn inheritable_attributes() -> SECURITY_ATTRIBUTES {
    SECURITY_ATTRIBUTES {
        nLength: u32::try_from(size_of::<SECURITY_ATTRIBUTES>())
            .expect("SECURITY_ATTRIBUTES size fits in a Win32 u32"),
        lpSecurityDescriptor: ptr::null_mut(),
        bInheritHandle: 1,
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
    use std::ffi::OsString;

    use super::{command_line, environment_block};
    use crate::subprocess::ProcessRequest;

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
