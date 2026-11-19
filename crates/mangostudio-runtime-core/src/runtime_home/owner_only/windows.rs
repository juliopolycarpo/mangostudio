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
//! This is one of this crate's narrowly-scoped Windows `unsafe` sites (the
//! module doc of [`crate::runtime_home::lock::windows`] lists the others);
//! every call carries a SAFETY comment.
#![allow(
    unsafe_code,
    reason = "the token/SID lookup and the ACL rewrite have no safe binding on Windows; every \
              call is documented with what makes it sound"
)]
// `clippy::all` (the workspace's own lint level) does not include this
// restriction lint, so nothing in the repo's own gate would have caught a
// `SAFETY`-less `unsafe` block here. Denying it locally, in each module that
// takes a module-wide `unsafe_code` allowance, gates the invariant the module
// doc above promises rather than resting it on review. `file_identity.rs` and
// `filesystem/io.rs` allow `unsafe_code` per function instead and do not carry
// this lint.
#![deny(clippy::undocumented_unsafe_blocks)]
// `Vec<u8>`'s allocation only promises byte alignment, never the alignment
// a typed Win32 struct read out of it needs — this lint is what would have
// caught reading a `TOKEN_USER` out of `current_user_token_buffer()`'s
// buffer through a place projection instead of `read_unaligned`.
#![deny(clippy::cast_ptr_alignment)]

use std::io;
use std::os::windows::ffi::OsStrExt as _;
use std::path::Path;
use std::ptr;

use windows_sys::Win32::Foundation::{CloseHandle, ERROR_SUCCESS, HANDLE, LocalFree};
use windows_sys::Win32::Security::Authorization::{
    EXPLICIT_ACCESS_W, GRANT_ACCESS, GetNamedSecurityInfoW, SE_FILE_OBJECT, SetEntriesInAclW,
    SetNamedSecurityInfoW, TRUSTEE_IS_SID, TRUSTEE_IS_USER, TRUSTEE_W,
};
use windows_sys::Win32::Security::{
    ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, ACL_SIZE_INFORMATION, AclSizeInformation,
    DACL_SECURITY_INFORMATION, EqualSid, GetAce, GetAclInformation, GetSecurityDescriptorControl,
    GetTokenInformation, IsValidSid, NO_INHERITANCE, PROTECTED_DACL_SECURITY_INFORMATION,
    PSECURITY_DESCRIPTOR, PSID, SE_DACL_PROTECTED, SID_AND_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER,
    TokenUser,
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

/// `ACE_HEADER::AceType` of an access-allowed entry. The named constant lives
/// in `Win32_System_SystemServices`, a feature nothing else here needs.
const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;

/// The smallest SID: one revision byte, one sub-authority-count byte and the
/// six-byte identifier authority, with no sub-authorities.
const MIN_SID_LEN: usize = 8;

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

/// The user SID inside a `TOKEN_USER` buffer from [`current_user_token_buffer`].
/// The returned pointer borrows `token_buffer` and must not outlive it.
fn user_sid_in(token_buffer: &[u8]) -> io::Result<PSID> {
    // `TOKEN_USER { User: SID_AND_ATTRIBUTES { Sid: PSID, .. } }` puts `Sid`
    // at offset 0 of the whole struct — `User` is `TOKEN_USER`'s only (and
    // so first) field, and `Sid` is `SID_AND_ATTRIBUTES`'s first field, and
    // `repr(C)` guarantees no padding before a struct's first field.
    let sid_offset =
        core::mem::offset_of!(TOKEN_USER, User) + core::mem::offset_of!(SID_AND_ATTRIBUTES, Sid);
    if token_buffer.len() < sid_offset + core::mem::size_of::<PSID>() {
        return Err(io::Error::other(
            "TOKEN_USER buffer is too short to hold its SID pointer",
        ));
    }
    // SAFETY: the length check above puts the `PSID`-sized field at
    // `sid_offset` inside `token_buffer`; the buffer was sized and filled by
    // `GetTokenInformation` for `TokenUser`, which documents its layout as
    // one `TOKEN_USER` struct followed by the SID it points at.
    // `read_unaligned` rather than a place projection through a cast
    // pointer: `Vec<u8>`'s allocation only promises byte alignment, not the
    // alignment a `PSID` (pointer-sized) read requires. The pointer copied
    // out still points into `token_buffer`'s own backing allocation, which
    // the caller keeps alive for every use of it.
    let sid: PSID =
        unsafe { std::ptr::read_unaligned(token_buffer.as_ptr().add(sid_offset).cast()) };
    if sid.is_null() {
        return Err(io::Error::other("TOKEN_USER holds a null SID"));
    }
    Ok(sid)
}

/// Whether `path`'s DACL is exactly what [`restrict_to_owner`] writes: a
/// protected DACL (no inherited entries) whose every entry is an allow for
/// this process's own account.
///
/// A file with a NULL DACL (everyone), an unprotected DACL, an entry for any
/// other trustee, a deny entry or no entry at all is not owner-only. The
/// check is deliberately strict rather than a general "who can read this"
/// analysis: the only files it guards are ones this crate wrote through
/// [`restrict_to_owner`], so anything that differs was changed afterwards.
///
/// # Errors
/// The `io::Error` from whichever Win32 call refused: reading the process's
/// token or the security descriptor of `path` (a missing file included).
pub(super) fn is_owner_only(path: &Path) -> io::Result<bool> {
    let token_buffer = current_user_token_buffer()?;
    let owner_sid = user_sid_in(&token_buffer)?;

    let wide_path: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut dacl: *mut ACL = ptr::null_mut();
    let mut descriptor: PSECURITY_DESCRIPTOR = ptr::null_mut();
    // SAFETY: `wide_path` is a NUL-terminated UTF-16 buffer that outlives
    // the call; the owner/group/SACL out-parameters are null because only the
    // DACL is requested; `dacl` and `descriptor` are live out-parameters. On
    // success `descriptor` owns the allocation `dacl` points into.
    let read = unsafe {
        GetNamedSecurityInfoW(
            wide_path.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            ptr::null_mut(),
            ptr::null_mut(),
            &raw mut dacl,
            ptr::null_mut(),
            &raw mut descriptor,
        )
    };
    if read != ERROR_SUCCESS {
        return Err(io::Error::from_raw_os_error(read as i32));
    }
    // Frees the descriptor (and so `dacl`) on every path out below.
    let _descriptor_guard = LocalAlloc(descriptor);

    if dacl.is_null() {
        // A NULL DACL grants everyone full access.
        return Ok(false);
    }

    let mut control: u16 = 0;
    let mut revision: u32 = 0;
    // SAFETY: `descriptor` is the live descriptor returned above; `control`
    // and `revision` are live out-parameters.
    let controlled =
        unsafe { GetSecurityDescriptorControl(descriptor, &raw mut control, &raw mut revision) };
    if controlled == 0 {
        return Err(io::Error::last_os_error());
    }
    if control & SE_DACL_PROTECTED == 0 {
        return Ok(false);
    }

    let mut size = ACL_SIZE_INFORMATION::default();
    // SAFETY: `dacl` is the non-null ACL above, alive through the descriptor
    // guard; `size` is a live `ACL_SIZE_INFORMATION` and its byte length is
    // passed with the matching `AclSizeInformation` class.
    let sized = unsafe {
        GetAclInformation(
            dacl,
            (&raw mut size).cast(),
            core::mem::size_of::<ACL_SIZE_INFORMATION>() as u32,
            AclSizeInformation,
        )
    };
    if sized == 0 {
        return Err(io::Error::last_os_error());
    }
    if size.AceCount == 0 {
        // Nobody, the owner included, can open it: not a file this crate wrote.
        return Ok(false);
    }

    for index in 0..size.AceCount {
        let mut ace: *mut core::ffi::c_void = ptr::null_mut();
        // SAFETY: `dacl` is alive through the guard and `index` is below its
        // `AceCount`; `ace` is a live out-parameter that, on success, points
        // into `dacl`.
        let fetched = unsafe { GetAce(dacl, index, &raw mut ace) };
        if fetched == 0 {
            return Err(io::Error::last_os_error());
        }
        // `GetAce` reports success only with a pointer into the ACL, but the
        // null check costs nothing and keeps the reads below from resting on
        // an unchecked out-parameter.
        let Some(ace) = ptr::NonNull::new(ace.cast::<u8>()) else {
            return Err(io::Error::other("GetAce succeeded with a null entry"));
        };
        // SAFETY: `ace` is non-null and points at an entry inside `dacl`,
        // which the descriptor guard keeps alive; every entry starts with a
        // four-byte `ACE_HEADER`, and the ACL's own `AceCount` bounds the
        // index, so those bytes are inside the allocation. Read unaligned:
        // entries are only DWORD-aligned.
        let header = unsafe { ptr::read_unaligned(ace.as_ptr().cast::<ACE_HEADER>()) };
        if header.AceType != ACCESS_ALLOWED_ACE_TYPE {
            return Ok(false);
        }
        // An allow entry has to hold its fixed part and the smallest SID
        // (revision, sub-authority count, six identifier-authority bytes)
        // starting at `SidStart`. A shorter one is malformed, not ours.
        let sid_offset = core::mem::offset_of!(ACCESS_ALLOWED_ACE, SidStart);
        if usize::from(header.AceSize) < sid_offset + MIN_SID_LEN {
            return Ok(false);
        }
        // The SID starts `sid_offset` bytes into the entry, which the size
        // check above puts inside it. `wrapping_add` only computes the
        // address; nothing dereferences it here, and `IsValidSid` then
        // validates the structure before `EqualSid` reads it.
        let ace_sid: PSID = ace.as_ptr().wrapping_add(sid_offset).cast();
        // SAFETY: `ace_sid` points inside the live entry, at least
        // `MIN_SID_LEN` bytes from its end, which is all `IsValidSid` needs
        // to read the SID header it validates.
        if unsafe { IsValidSid(ace_sid) } == 0 {
            return Ok(false);
        }
        // SAFETY: both are valid SIDs: `ace_sid` was just validated and lives
        // in the ACL, and `owner_sid` points into `token_buffer`, which
        // outlives this loop.
        if unsafe { EqualSid(ace_sid, owner_sid) } == 0 {
            return Ok(false);
        }
    }
    Ok(true)
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
    let sid = user_sid_in(&token_buffer)?;

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
    use super::{is_owner_only, restrict_to_owner};
    use crate::test_support::scratch_path;

    #[test]
    fn restricts_an_existing_file_this_process_owns() {
        let path = scratch_path("owner-only-windows-test");
        std::fs::write(&path, b"secret").unwrap();

        assert!(restrict_to_owner(&path).is_ok());

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn a_file_restricted_to_its_owner_reads_back_as_owner_only() {
        let path = scratch_path("owner-only-windows-roundtrip");
        std::fs::write(&path, b"secret").unwrap();
        restrict_to_owner(&path).unwrap();

        let owner_only = is_owner_only(&path);

        std::fs::remove_file(&path).ok();
        assert!(
            matches!(owner_only, Ok(true)),
            "expected Ok(true) for a file restrict_to_owner just wrote | received: {owner_only:?}"
        );
    }

    #[test]
    fn a_file_with_its_inherited_dacl_is_not_owner_only() {
        // A fresh file inherits its directory's entries (SYSTEM, Administrators,
        // the owner) and an unprotected DACL.
        let path = scratch_path("owner-only-windows-inherited");
        std::fs::write(&path, b"secret").unwrap();

        let owner_only = is_owner_only(&path);

        std::fs::remove_file(&path).ok();
        assert!(
            matches!(owner_only, Ok(false)),
            "expected Ok(false) for a file still carrying its inherited DACL | received: \
             {owner_only:?}"
        );
    }

    #[test]
    fn a_missing_file_is_an_error_not_an_answer() {
        let path = scratch_path("owner-only-windows-check-missing");
        assert!(
            is_owner_only(&path).is_err(),
            "expected an error for a path that does not exist"
        );
    }

    #[test]
    fn reports_an_error_rather_than_panicking_for_a_missing_file() {
        let path = scratch_path("owner-only-windows-missing");
        assert!(restrict_to_owner(&path).is_err());
    }
}
