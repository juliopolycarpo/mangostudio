//! Windows halves of the lock protocol's two platform questions: is a pid
//! still alive, and what does this machine call itself. Neither has a safe
//! binding — `nix` is Unix-only — so this is one of this crate's two
//! narrowly-scoped `unsafe` modules (the other is
//! [`crate::runtime_home::owner_only::windows`]), mirroring
//! `mango-protocol`'s own `transports/ipc/windows/security.rs`: every call
//! below carries a SAFETY comment, and nothing outside this file needs to.
#![allow(
    unsafe_code,
    reason = "OpenProcess/GetExitCodeProcess and GetComputerNameExW have no safe binding on \
              Windows; every call is documented with what makes it sound"
)]

use std::io;

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, STILL_ACTIVE};
use windows_sys::Win32::System::SystemInformation::{
    ComputerNamePhysicalDnsHostname, GetComputerNameExW,
};
use windows_sys::Win32::System::Threading::{
    GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
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
pub(super) fn is_process_alive(pid: u32) -> bool {
    // SAFETY: `pid` is an arbitrary `u32` read back from a lock file, which
    // is exactly what `OpenProcess` is for — it validates the id itself and
    // returns a null handle rather than doing anything unsound with a bad
    // one.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        // `last_os_error` is a safe call; it reads the calling thread's
        // last-error slot, which `OpenProcess` just set.
        let access_denied = io::Error::last_os_error().raw_os_error() == Some(5); // ERROR_ACCESS_DENIED
        return access_denied;
    }
    let owned = OwnedHandle(handle);
    let mut exit_code: u32 = 0;
    // SAFETY: `owned.0` is a live handle opened above and not yet closed
    // (the `OwnedHandle` guard closes it on drop, after this call), and
    // `exit_code` is a live out-parameter of the width the function writes.
    let read = unsafe { GetExitCodeProcess(owned.0, &raw mut exit_code) };
    read != 0 && exit_code == STILL_ACTIVE as u32
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
