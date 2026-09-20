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
use windows_sys::Win32::Storage::FileSystem::SYNCHRONIZE;
use windows_sys::Win32::System::SystemInformation::{
    ComputerNamePhysicalDnsHostname, GetComputerNameExW,
};
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

/// This machine's hostname, for the lock body's `host` field.
///
/// `ComputerNamePhysicalDnsHostname` is the DNS-style name — the same family
/// `gethostname()` reports on Unix — rather than the legacy NetBIOS name, so
/// the two platforms' lock bodies carry comparable values.
pub(super) fn hostname() -> io::Result<String> {
    let mut len: u32 = 0;
    // SAFETY: a null buffer with a live `len` out-parameter is the
    // documented way to ask `GetComputerNameExW` how large a buffer it
    // needs; it never dereferences the buffer pointer in this mode.
    unsafe {
        GetComputerNameExW(
            ComputerNamePhysicalDnsHostname,
            std::ptr::null_mut(),
            &raw mut len,
        );
    }
    if len == 0 {
        return Err(io::Error::other(
            "GetComputerNameExW reported a zero-length hostname",
        ));
    }
    let mut buffer = vec![0u16; len as usize];
    // SAFETY: `buffer` has room for exactly the `len` (including the
    // terminator) the sizing call above reported, and `len` is passed back
    // as a live in/out parameter of that same width.
    let ok = unsafe {
        GetComputerNameExW(
            ComputerNamePhysicalDnsHostname,
            buffer.as_mut_ptr(),
            &raw mut len,
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(String::from_utf16_lossy(&buffer[..len as usize]))
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
