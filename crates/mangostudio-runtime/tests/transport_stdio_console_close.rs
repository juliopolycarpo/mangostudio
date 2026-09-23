//! Proves a Windows stdio runtime closes cooperatively when its console goes
//! away (`CTRL_CLOSE_EVENT`) after `hello`, while the hub still holds stdin
//! open.
//!
//! `GenerateConsoleCtrlEvent` can only send `CTRL_C` and `CTRL_BREAK`, and a
//! real console window is not reliably reachable from a test (the host's
//! default terminal may own it, and CI has no interactive desktop). A
//! pseudoconsole is: `ClosePseudoConsole` delivers `CTRL_CLOSE_EVENT` to every
//! attached client, exactly as closing a console window does. The child keeps
//! the hub's shape, with pipes as its standard handles and the pseudoconsole
//! only as its console.
//!
//! This binary holds the only spawning test on purpose: the child's pipe ends
//! must be inheritable, and no other test in this process may spawn a child
//! while they are, or it would inherit them too.
#![cfg(windows)]
#![allow(unsafe_code)] // Win32 has no safe binding for a pseudoconsole-attached spawn.

use std::ffi::{OsStr, OsString, c_void};
use std::io::{BufRead as _, BufReader};
use std::os::windows::ffi::OsStrExt as _;
use std::os::windows::io::{AsRawHandle as _, OwnedHandle};
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{
    HANDLE, HANDLE_FLAG_INHERIT, SetHandleInformation, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::System::Console::{COORD, ClosePseudoConsole, CreatePseudoConsole, HPCON};
use windows_sys::Win32::System::Threading::{
    CREATE_UNICODE_ENVIRONMENT, CreateProcessW, DeleteProcThreadAttributeList,
    EXTENDED_STARTUPINFO_PRESENT, GetExitCodeProcess, InitializeProcThreadAttributeList,
    LPPROC_THREAD_ATTRIBUTE_LIST, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, PROCESS_INFORMATION,
    STARTF_USESTDHANDLES, STARTUPINFOEXW, TerminateProcess, UpdateProcThreadAttribute,
    WaitForSingleObject,
};

mod support;

use support::scratch::scratch_path;

/// Same bound as `transport_stdio_spawned.rs`'s `SIGNALLED_EXIT_BOUND`, and
/// above Windows' own ~5 s `CTRL_CLOSE` grace: a runtime that ignores the
/// event is killed by Windows (a non-zero status) before this expires.
const SIGNALLED_EXIT_BOUND: Duration = Duration::from_secs(10);

#[test]
fn a_console_close_after_hello_exits_while_the_hub_keeps_stdin_open() {
    let home = scratch_path("transport-stdio-console-close");
    let (stdin_read, stdin_write) = std::io::pipe().expect("a stdin pipe");
    let (stdout_read, stdout_write) = std::io::pipe().expect("a stdout pipe");
    let null = std::fs::OpenOptions::new()
        .write(true)
        .open("NUL")
        .expect("the NUL device opens");
    let stdin_read = OwnedHandle::from(stdin_read);
    let stdout_write = OwnedHandle::from(stdout_write);
    let stderr = OwnedHandle::from(null);
    for handle in [&stdin_read, &stdout_write, &stderr] {
        make_inheritable(handle);
    }

    let console = PseudoConsole::open();
    let child = spawn_attached(&console, &[&stdin_read, &stdout_write, &stderr], &home);
    drop((stdin_read, stdout_write, stderr));

    // Held until the end of the test: the hub has not gone away.
    let _stdin = stdin_write;
    let mut stdout = BufReader::new(stdout_read);
    let mut hello = String::new();
    stdout
        .read_line(&mut hello)
        .expect("the child writes its hello frame");
    assert!(
        hello.contains("hello"),
        "expected the first stdout line to be the hello frame | received {hello:?}"
    );
    // Same window as the signal tests: let the stdin read block first.
    std::thread::sleep(Duration::from_millis(300));

    let started = Instant::now();
    console.close();
    let code = child.wait_bounded(SIGNALLED_EXIT_BOUND);
    assert_eq!(
        code,
        0,
        "expected a clean exit 0 through the runtime's own handler after CTRL_CLOSE | received \
         exit code {code:#010x} after {:?}",
        started.elapsed()
    );
}

fn make_inheritable(handle: &OwnedHandle) {
    // SAFETY: `handle` is a live handle this test owns.
    let ok = unsafe {
        SetHandleInformation(
            handle.as_raw_handle() as HANDLE,
            HANDLE_FLAG_INHERIT,
            HANDLE_FLAG_INHERIT,
        )
    };
    assert_ne!(
        ok,
        0,
        "expected SetHandleInformation to mark a pipe inheritable | received {}",
        std::io::Error::last_os_error()
    );
}

/// A pseudoconsole whose output is drained on a background thread, so
/// closing it never blocks on a full output pipe.
struct PseudoConsole {
    handle: HPCON,
    _input: std::io::PipeWriter,
}

impl PseudoConsole {
    fn open() -> Self {
        let (input_read, input_write) = std::io::pipe().expect("a console input pipe");
        let (mut output_read, output_write) = std::io::pipe().expect("a console output pipe");
        let mut handle: HPCON = 0;
        // SAFETY: both pipe ends are live for the call; the console duplicates them.
        let result = unsafe {
            CreatePseudoConsole(
                COORD { X: 80, Y: 25 },
                input_read.as_raw_handle() as HANDLE,
                output_write.as_raw_handle() as HANDLE,
                0,
                &mut handle,
            )
        };
        assert_eq!(
            result, 0,
            "expected CreatePseudoConsole to return S_OK | received HRESULT {result:#010x}"
        );
        std::thread::spawn(move || {
            let _ = std::io::copy(&mut output_read, &mut std::io::sink());
        });
        Self {
            handle,
            _input: input_write,
        }
    }

    /// Delivers `CTRL_CLOSE_EVENT` to every attached client.
    fn close(self) {
        let handle = self.handle;
        // `ClosePseudoConsole` may wait for attached clients on older builds;
        // the exit bound below is what this test measures, not this call.
        std::thread::spawn(move || {
            // SAFETY: `handle` came from `CreatePseudoConsole` and is closed once.
            unsafe { ClosePseudoConsole(handle) };
        });
    }
}

struct AttachedChild(OwnedHandle);

impl AttachedChild {
    /// Waits for the child's exit code, terminating it and failing the test
    /// with the elapsed time if `bound` expires first.
    fn wait_bounded(&self, bound: Duration) -> u32 {
        let process = self.0.as_raw_handle() as HANDLE;
        let millis = u32::try_from(bound.as_millis()).expect("the bound fits u32 milliseconds");
        // SAFETY: `process` is a live process handle this test owns.
        let waited = unsafe { WaitForSingleObject(process, millis) };
        if waited == WAIT_TIMEOUT {
            // SAFETY: as above.
            unsafe { TerminateProcess(process, 1) };
            panic!(
                "expected the console-closed stdio child to exit within {bound:?} | received: \
                 still running, terminated by the test"
            );
        }
        assert_eq!(
            waited,
            WAIT_OBJECT_0,
            "expected WaitForSingleObject to report the child exited | received {waited:#x} ({})",
            std::io::Error::last_os_error()
        );
        let mut code = 0u32;
        // SAFETY: as above; `code` is a valid out pointer.
        let ok = unsafe { GetExitCodeProcess(process, &mut code) };
        assert_ne!(
            ok,
            0,
            "expected GetExitCodeProcess to succeed | received {}",
            std::io::Error::last_os_error()
        );
        code
    }
}

/// Starts `mangostudio-runtime stdio` attached to `console`, with
/// `std_handles` (stdin, stdout, stderr) as its standard handles.
fn spawn_attached(
    console: &PseudoConsole,
    std_handles: &[&OwnedHandle; 3],
    home: &std::path::Path,
) -> AttachedChild {
    let mut size = 0usize;
    // SAFETY: a null list asks only for the required size; this call "fails" by design.
    unsafe { InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut size) };
    let mut list_storage = vec![0u8; size];
    let list: LPPROC_THREAD_ATTRIBUTE_LIST = list_storage.as_mut_ptr().cast();
    // SAFETY: `list` points to `size` writable bytes, as the first call requested.
    let ok = unsafe { InitializeProcThreadAttributeList(list, 1, 0, &mut size) };
    assert_ne!(
        ok,
        0,
        "expected InitializeProcThreadAttributeList to succeed | received {}",
        std::io::Error::last_os_error()
    );
    // SAFETY: the pseudoconsole attribute takes the HPCON value itself as lpValue.
    let ok = unsafe {
        UpdateProcThreadAttribute(
            list,
            0,
            PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize,
            console.handle as *const c_void,
            size_of::<HPCON>(),
            std::ptr::null_mut(),
            std::ptr::null(),
        )
    };
    assert_ne!(
        ok,
        0,
        "expected UpdateProcThreadAttribute(PSEUDOCONSOLE) to succeed | received {}",
        std::io::Error::last_os_error()
    );

    let mut startup = STARTUPINFOEXW::default();
    startup.StartupInfo.cb =
        u32::try_from(size_of::<STARTUPINFOEXW>()).expect("STARTUPINFOEXW fits u32");
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = std_handles[0].as_raw_handle() as HANDLE;
    startup.StartupInfo.hStdOutput = std_handles[1].as_raw_handle() as HANDLE;
    startup.StartupInfo.hStdError = std_handles[2].as_raw_handle() as HANDLE;
    startup.lpAttributeList = list;

    let binary = env!("CARGO_BIN_EXE_mangostudio-runtime");
    let mut command_line = wide_nul(OsStr::new(&format!("\"{binary}\" stdio")));
    let mut environment = environment_block(home);
    let mut information = PROCESS_INFORMATION::default();
    // SAFETY: every buffer and the attribute list outlive the call; handles are live.
    let created = unsafe {
        CreateProcessW(
            std::ptr::null(),
            command_line.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1,
            EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
            environment.as_mut_ptr().cast(),
            std::ptr::null(),
            &startup.StartupInfo,
            &mut information,
        )
    };
    let error = std::io::Error::last_os_error();
    // SAFETY: `list` was initialized above and is deleted once.
    unsafe { DeleteProcThreadAttributeList(list) };
    assert_ne!(
        created, 0,
        "expected CreateProcessW({binary} stdio) to succeed | received {error}"
    );
    // SAFETY: a successful CreateProcessW hands over one process and one thread handle.
    let (process, thread) = unsafe {
        use std::os::windows::io::FromRawHandle as _;
        (
            OwnedHandle::from_raw_handle(information.hProcess as _),
            OwnedHandle::from_raw_handle(information.hThread as _),
        )
    };
    drop(thread);
    AttachedChild(process)
}

/// This process's environment plus `MANGO_HOME`, as a UTF-16 block.
fn environment_block(home: &std::path::Path) -> Vec<u16> {
    let mut entries: Vec<(OsString, OsString)> = std::env::vars_os()
        .filter(|(key, _)| !key.eq_ignore_ascii_case("MANGO_HOME"))
        .collect();
    entries.push(("MANGO_HOME".into(), home.into()));
    let mut block = Vec::new();
    for (key, value) in entries {
        let mut entry = key;
        entry.push("=");
        entry.push(value);
        block.extend(entry.encode_wide());
        block.push(0);
    }
    block.push(0);
    block
}

fn wide_nul(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(std::iter::once(0)).collect()
}
