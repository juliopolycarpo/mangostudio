//! Windows halves of the lock protocol's two platform questions: is a pid
//! still alive, and what does this machine call itself. Neither has a safe
//! binding — `nix` is Unix-only — so this is one of this crate's two
//! narrowly-scoped `unsafe` modules (the other is `owner_only`'s own
//! private `platform` implementation, `owner_only/windows.rs`), mirroring
//! `mango-protocol`'s own `transports/ipc/windows/security.rs`: every call
//! below carries a SAFETY comment, and nothing outside this file needs to.
#![allow(
    unsafe_code,
    reason = "OpenProcess/GetExitCodeProcess and GetComputerNameExW have no safe binding on \
              Windows; every call is documented with what makes it sound"
)]
// `clippy::all` (the workspace's own lint level) does not include this
// restriction lint, so nothing in the repo's own gate would have caught a
// `SAFETY`-less `unsafe` block here. Denying it locally, only in the two
// modules that actually contain `unsafe`, gates the invariant the module
// doc above promises rather than resting it on review.
#![deny(clippy::undocumented_unsafe_blocks)]

use std::io;

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
use windows_sys::Win32::Networking::WinSock::{GetHostNameW, WSADATA, WSAGetLastError, WSAStartup};
use windows_sys::Win32::Storage::FileSystem::SYNCHRONIZE;
use windows_sys::Win32::System::Threading::{
    OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, WaitForSingleObject,
};

/// A `HANDLE` closed when it goes out of scope, so an early return (a
/// process this call could not open, an `OpenProcess` failure) can never
/// leak the handle a later branch would have closed.
struct OwnedHandle(HANDLE);

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        // SAFETY: `self.0` was returned by a successful `OpenProcess` above
        // and is closed exactly once, here, by the value that uniquely owns
        // it.
        unsafe {
            CloseHandle(self.0);
        }
    }
}

/// Whether `pid` names a still-running process.
///
/// `OpenProcess` failing with `ERROR_ACCESS_DENIED` is Windows' analogue of
/// Unix's `EPERM` from `kill(pid, 0)`: the process exists and this account
/// simply cannot query it, which is "alive" for lock-reclaim purposes. Any
/// other failure (`ERROR_INVALID_PARAMETER` chief among them) means no such
/// process, mirroring `runtime-home.ts`'s pid check on the platform it
/// actually runs on.
///
/// Liveness itself is `WaitForSingleObject(handle, 0)`, not
/// `GetExitCodeProcess` compared against `STILL_ACTIVE`: a process handle
/// signals exactly once, at process exit, so a zero-timeout wait answers
/// "has this happened yet" directly. `GetExitCodeProcess` answers a
/// different question — what the exit code *was* — and `STILL_ACTIVE` is
/// itself a real, obtainable exit code (`259`): a process that legitimately
/// exited with status 259 would read back as eternally alive under that
/// comparison, which would make every lock it ever held unreclaimable.
pub(super) fn is_process_alive(pid: u32) -> bool {
    // SAFETY: `pid` is an arbitrary `u32` read back from a lock file, which
    // is exactly what `OpenProcess` is for — it validates the id itself and
    // returns a null handle rather than doing anything unsound with a bad
    // one. `SYNCHRONIZE` is requested alongside the query right because
    // `WaitForSingleObject` below needs it on the handle itself: without
    // it the wait fails with `ERROR_ACCESS_DENIED` (surfaced as
    // `WAIT_FAILED`, not `WAIT_OBJECT_0`), which the conservative branch
    // below reads as "alive" regardless of the process's real state.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, 0, pid) };
    if handle.is_null() {
        // `last_os_error` is a safe call; it reads the calling thread's
        // last-error slot, which `OpenProcess` just set.
        let access_denied = io::Error::last_os_error().raw_os_error() == Some(5); // ERROR_ACCESS_DENIED
        return access_denied;
    }
    let owned = OwnedHandle(handle);
    // SAFETY: `owned.0` is a live handle opened above and not yet closed
    // (the `OwnedHandle` guard closes it on drop, after this call); `0` asks
    // for an immediate return rather than blocking.
    let wait = unsafe { WaitForSingleObject(owned.0, 0) };
    // `WAIT_OBJECT_0`: the handle was already signalled, i.e. the process
    // had already exited. Anything else — `WAIT_TIMEOUT` (still running) or
    // `WAIT_FAILED` (this process could open it but something about the
    // wait itself went wrong) — is treated as alive, the same conservative
    // direction `EPERM` takes on Unix: an unclear answer must never cause a
    // reclaim.
    wait != WAIT_OBJECT_0
}

/// Initialises WinSock exactly once per process, the way every WinSock call
/// (including [`hostname`]'s own `GetHostNameW`) requires before it may be
/// made.
///
/// A `OnceLock` rather than a call on every [`hostname`] invocation:
/// `WSAStartup` is refcounted and safe to call repeatedly, but there is no
/// reason to pay a syscall on every lock create and every reclaim check
/// when this process's WinSock state never changes after the first
/// success — the same lazy-once shape Bun's own `node:os` binding and
/// libuv's `uv_os_gethostname` use for the same call.
fn ensure_winsock() -> io::Result<()> {
    static RESULT: std::sync::OnceLock<i32> = std::sync::OnceLock::new();
    let code = *RESULT.get_or_init(|| {
        // SAFETY: `WSADATA` is `#[repr(C)]` plain data (version fields,
        // fixed-size description buffers, and pointers `WSAStartup` itself
        // fills in) for which an all-zero bit pattern is a valid value —
        // nothing here is read before `WSAStartup` overwrites it below.
        let mut wsa_data: WSADATA = unsafe { core::mem::zeroed() };
        // SAFETY: `wsa_data` is the live, correctly-sized out-parameter
        // `WSAStartup` fully initialises on success; `0x0202` (2.2) is the
        // WinSock version every caller today requests.
        unsafe { WSAStartup(0x0202, &raw mut wsa_data) }
    });
    if code == 0 {
        Ok(())
    } else {
        Err(io::Error::from_raw_os_error(code))
    }
}

/// This machine's hostname, for the lock body's `host` field.
///
/// Calls `GetHostNameW` from WinSock (`Ws2_32.dll`), the same Win32 API
/// Bun's own `node:os` binding calls for `hostname()` on Windows (and which
/// Node's libuv calls too) — not `GetComputerNameExW` (`Kernel32.dll`),
/// which is a different provider with no documented guarantee of agreeing
/// with it. `reclaim_if_abandoned`'s hostname comparison is lenient
/// (case-insensitive) as belt-and-braces, but the value actually written
/// into a lock's `host` field has to be the one a TypeScript waiter's own
/// `hostname()` would produce for this same machine, or a live Rust holder
/// can look foreign to it and have its lock stolen once `stale_after`
/// elapses.
pub(super) fn hostname() -> io::Result<String> {
    ensure_winsock()?;
    let mut buffer = [0u16; 256];
    // SAFETY: `buffer` is a live, properly-sized `PWSTR` target, and
    // `buffer.len()` — always within `i32`'s range for this fixed
    // 256-element array — is the exact capacity `GetHostNameW` may write
    // into, matching its documented contract.
    let result = unsafe { GetHostNameW(buffer.as_mut_ptr(), buffer.len() as i32) };
    if result != 0 {
        // WinSock functions report their error through `WSAGetLastError`,
        // not `GetLastError` — the two slots are not guaranteed to agree.
        // SAFETY: `WSAGetLastError` takes no arguments and only reads this
        // thread's WinSock error slot, which `GetHostNameW` just set.
        let error = unsafe { WSAGetLastError() };
        return Err(io::Error::from_raw_os_error(error));
    }
    let len = buffer
        .iter()
        .position(|&unit| unit == 0)
        .unwrap_or(buffer.len());
    Ok(String::from_utf16_lossy(&buffer[..len]))
}

#[cfg(test)]
mod tests {
    use super::{hostname, is_process_alive};

    #[test]
    fn the_current_process_is_alive() {
        assert!(is_process_alive(std::process::id()));
    }

    /// A pid this test has actually watched exit, which is the one case
    /// `OpenProcess`/`GetExitCodeProcess` is guaranteed to answer "not
    /// alive" for rather than racing pid reuse.
    #[test]
    fn a_reaped_child_is_not_alive() {
        let mut child = std::process::Command::new("cmd")
            .args(["/C", "exit 0"])
            .spawn()
            .expect("cmd.exe is on PATH on every Windows this crate targets");
        let pid = child.id();
        child.wait().expect("the child ran to completion");
        assert!(!is_process_alive(pid));
    }

    #[test]
    fn hostname_resolves_to_something_nonempty() {
        assert!(!hostname().expect("this machine has a hostname").is_empty());
    }
}
