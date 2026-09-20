//! Restricting a file to its owner on Windows.
//!
//! Windows has no mode bits: `chmod` there sets the read-only attribute and
//! reports success, so a caller trusting that return value would think a
//! world-readable credentials file was protected. `apps/runtime/src/services/owner-only.ts`
//! answers this by shelling out to `icacls <path> /inheritance:r /grant:r
//! <user>:(M)`; this module does the same rewrite as roughly forty lines of
//! `windows-sys` instead of spawning a process, using the SID from this
//! process's own token rather than a name lookup (a name can round-trip to a
//! domain controller; a SID from `OpenProcessToken` never does).
//!
//! `(M)` — modify — not `(R,W)`: every writer in [`crate::runtime_home`]
//! publishes through a temporary file and a rename
//! ([`crate::runtime_home::atomic`]), and replacing an existing file needs
//! `DELETE` on it. A read/write grant would let the first write succeed and
//! refuse every rotation after it.
//!
//! This is one of this crate's two narrowly-scoped `unsafe` modules (the
//! other is [`crate::runtime_home::lock::windows`]); every call carries a
//! SAFETY comment.
#![allow(
    unsafe_code,
    reason = "the token/SID lookup and the ACL rewrite have no safe binding on Windows; every \
              call is documented with what makes it sound"
)]
// `clippy::all` (the workspace's own lint level) does not include this
// restriction lint, so nothing in the repo's own gate would have caught a
// `SAFETY`-less `unsafe` block here. Denying it locally, only in the two
// modules that actually contain `unsafe`, gates the invariant the module
// doc above promises rather than resting it on review.
#![deny(clippy::undocumented_unsafe_blocks)]

use std::io;
use std::os::windows::ffi::OsStrExt as _;
use std::path::Path;
use std::ptr;

use windows_sys::Win32::Foundation::{CloseHandle, ERROR_SUCCESS, HANDLE, LocalFree};
use windows_sys::Win32::Security::Authorization::{
    EXPLICIT_ACCESS_W, GRANT_ACCESS, SE_FILE_OBJECT, SetEntriesInAclW, SetNamedSecurityInfoW,
    TRUSTEE_IS_SID, TRUSTEE_IS_USER, TRUSTEE_W,
};
use windows_sys::Win32::Security::{
    ACL, DACL_SECURITY_INFORMATION, GetTokenInformation, NO_INHERITANCE,
    PROTECTED_DACL_SECURITY_INFORMATION, TOKEN_QUERY, TOKEN_USER, TokenUser,
};
use windows_sys::Win32::Storage::FileSystem::{
    DELETE, FILE_GENERIC_EXECUTE, FILE_GENERIC_READ, FILE_GENERIC_WRITE,
};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

/// `FILE_GENERIC_READ|WRITE|EXECUTE|DELETE` — Explorer's "Modify". Deliberately
/// not `FILE_ALL_ACCESS` (Explorer's "Full control"), which is a wider grant
/// than this file ever needs.
const MODIFY_ACCESS_MASK: u32 =
    FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | DELETE;

/// A `HANDLE` closed on drop.
struct OwnedHandle(HANDLE);

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        // SAFETY: `self.0` was returned by a successful open above and is
        // closed exactly once, here, by the value that uniquely owns it.
        unsafe {
            CloseHandle(self.0);
        }
    }
}

/// A block LocalFree-d on drop, for the two allocations this module makes
/// with Windows' own allocator (`GetTokenInformation`'s buffer needs no such
/// wrapper — it is ordinary Rust-allocated memory — but the ACL
/// `SetEntriesInAclW` returns is not).
struct LocalAlloc(*mut core::ffi::c_void);

impl Drop for LocalAlloc {
    fn drop(&mut self) {
        if self.0.is_null() {
            return;
        }
        // SAFETY: `self.0` was allocated by `SetEntriesInAclW`, which
        // documents `LocalFree` as the way to release the ACL it returns,
        // and this type owns it uniquely.
        unsafe {
            LocalFree(self.0 as _);
        }
    }
}

/// This process's own user SID, read from its primary token.
///
/// Returns the raw `TOKEN_USER` buffer alongside the handle: the SID inside
/// it points into that buffer, so the buffer must outlive every use of the
/// pointer.
fn current_user_token_buffer() -> io::Result<Vec<u8>> {
    // SAFETY: `GetCurrentProcess` returns a pseudo-handle that needs no
    // closing, valid for the lifetime of this process.
    let process = unsafe { GetCurrentProcess() };
    let mut token: HANDLE = ptr::null_mut();
    // SAFETY: `process` is the valid pseudo-handle above, and `token` is a
    // live out-parameter this call fully initialises on success.
    let opened = unsafe { OpenProcessToken(process, TOKEN_QUERY, &raw mut token) };
    if opened == 0 {
        return Err(io::Error::last_os_error());
    }
    let token = OwnedHandle(token);

    let mut needed: u32 = 0;
    // SAFETY: a null buffer with a zero length and a live `needed`
    // out-parameter is the documented way to ask `GetTokenInformation` how
    // large a buffer it needs; it never dereferences the buffer pointer in
    // this mode.
    unsafe {
        GetTokenInformation(token.0, TokenUser, ptr::null_mut(), 0, &raw mut needed);
    }
    if needed == 0 {
        return Err(io::Error::other(
            "GetTokenInformation reported a zero-length TOKEN_USER",
        ));
    }

    let mut buffer = vec![0u8; needed as usize];
    // SAFETY: `buffer` has room for exactly the `needed` bytes the sizing
    // call reported, and `needed` is passed back as a live in/out width.
    let read = unsafe {
        GetTokenInformation(
            token.0,
            TokenUser,
            buffer.as_mut_ptr().cast(),
            needed,
            &raw mut needed,
        )
    };
    if read == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(buffer)
}

/// Rewrites `path`'s DACL to grant this process's own account `(M)` and
/// nobody else, dropping every inherited entry.
///
/// # Errors
/// The `io::Error` from whichever Win32 call refused: reading this
/// process's token or SID, building the replacement ACL, or applying it to
/// `path`.
pub(super) fn restrict_to_owner(path: &Path) -> io::Result<()> {
    let token_buffer = current_user_token_buffer()?;
    // SAFETY: `token_buffer` was sized and filled by `GetTokenInformation`
    // for `TokenUser` above, which documents its layout as one `TOKEN_USER`
    // struct followed by the SID it points at — the pointer inside it is
    // valid for as long as `token_buffer` is alive, which outlives every use
    // below.
    let sid = unsafe { (*token_buffer.as_ptr().cast::<TOKEN_USER>()).User.Sid };

    // SAFETY: `TRUSTEE_W` is `#[repr(C)]` plain data — two pointers
    // (`pMultipleTrustee`, `ptstrName`) and two `i32` enums
    // (`MultipleTrusteeOperation`, `TrusteeForm`/`TrusteeType`) — for which
    // an all-zero bit pattern is a valid value: a null pointer is a valid
    // `*mut TRUSTEE_W`/`PWSTR`, and `NO_MULTIPLE_TRUSTEE` is itself `0`.
    // Every field this call actually reads (`TrusteeForm`, `TrusteeType`,
    // `ptstrName`) is overwritten explicitly on the three lines below before
    // `trustee` is used.
    let mut trustee: TRUSTEE_W = unsafe { core::mem::zeroed() };
    trustee.TrusteeForm = TRUSTEE_IS_SID;
    trustee.TrusteeType = TRUSTEE_IS_USER;
    trustee.ptstrName = sid.cast();

    let entry = EXPLICIT_ACCESS_W {
        grfAccessPermissions: MODIFY_ACCESS_MASK,
        grfAccessMode: GRANT_ACCESS,
        grfInheritance: NO_INHERITANCE,
        Trustee: trustee,
    };

    let mut new_acl: *mut ACL = ptr::null_mut();
    // SAFETY: `entry` is a single, fully-initialised `EXPLICIT_ACCESS_W`
    // whose `Trustee.ptstrName` borrows the live SID above; `oldacl` is null
    // so the call builds a fresh ACL from this one entry rather than merging
    // with an existing one — which is what "drop every inherited entry"
    // means; `new_acl` is a live out-parameter.
    let built = unsafe { SetEntriesInAclW(1, &raw const entry, ptr::null(), &raw mut new_acl) };
    if built != ERROR_SUCCESS {
        return Err(io::Error::from_raw_os_error(built as i32));
    }
    let new_acl_guard = LocalAlloc(new_acl.cast());

    let mut wide_path: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    // SAFETY: `wide_path` is a NUL-terminated UTF-16 buffer that outlives
    // the call; `new_acl` is the ACL built above, still alive through
    // `new_acl_guard`; the owner/group/SACL arguments are null because this
    // call touches only the DACL, which `securityinfo` names.
    let applied = unsafe {
        SetNamedSecurityInfoW(
            wide_path.as_mut_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            ptr::null_mut(),
            ptr::null_mut(),
            new_acl,
            ptr::null(),
        )
    };
    drop(new_acl_guard);
    if applied != ERROR_SUCCESS {
        return Err(io::Error::from_raw_os_error(applied as i32));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::restrict_to_owner;

    #[test]
    fn restricts_an_existing_file_this_process_owns() {
        let path = std::env::temp_dir().join(format!(
            "mango-owner-only-windows-test-{}-{}",
            std::process::id(),
            line!()
        ));
        std::fs::write(&path, b"secret").unwrap();

        assert!(restrict_to_owner(&path).is_ok());

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn reports_an_error_rather_than_panicking_for_a_missing_file() {
        let path = std::env::temp_dir().join(format!(
            "mango-owner-only-windows-missing-{}-{}",
            std::process::id(),
            line!()
        ));
        assert!(restrict_to_owner(&path).is_err());
    }
}
