//! The two Windows calls the local socket transport cannot make from safe
//! Rust: creating a named pipe whose access control admits its owner alone,
//! and asking a connected pipe which process is on the other end.
//!
//! This is the only module in the crate that is allowed to use `unsafe`, and
//! it exists because `spec/transports/local-socket.md` records a limit that is
//! Node's, not Windows': "the socket API the reference SDK builds on cannot
//! attach a security descriptor, so every local user may connect". Windows can
//! attach one, and a POSIX listener's `0600` socket file has no meaning unless
//! the Windows address is just as narrow.
#![allow(
    unsafe_code,
    reason = "CreateNamedPipe's security descriptor and GetNamedPipeClientProcessId have no safe \
              binding; every call below is documented with what makes it sound"
)]

use std::io;
use std::os::windows::io::AsRawHandle;
use std::path::Path;
use std::ptr;

use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
use windows_sys::Win32::Foundation::{HLOCAL, LocalFree};
use windows_sys::Win32::Security::Authorization::{
    ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::System::Pipes::GetNamedPipeClientProcessId;

/// A protected discretionary access control list with one entry: full access
/// for the object's owner, which is the account that created the pipe.
///
/// `D:` opens the DACL, `P` protects it from inheriting anything else,
/// `A` is an allow entry, `GA` is `GENERIC_ALL`, and `OW` is the Owner Rights
/// SID (`S-1-3-4`), the entry that applies to whoever owns the object. No
/// other account is named, so no other account is admitted.
const OWNER_ONLY_SDDL: &[u16] = &[
    b'D' as u16,
    b':' as u16,
    b'P' as u16,
    b'(' as u16,
    b'A' as u16,
    b';' as u16,
    b';' as u16,
    b'G' as u16,
    b'A' as u16,
    b';' as u16,
    b';' as u16,
    b';' as u16,
    b'O' as u16,
    b'W' as u16,
    b')' as u16,
    0,
];

/// A security descriptor built from SDDL, freed when it goes out of scope.
struct OwnerOnlyDescriptor {
    descriptor: *mut core::ffi::c_void,
}

impl OwnerOnlyDescriptor {
    /// Converts [`OWNER_ONLY_SDDL`] into the descriptor `CreateNamedPipe`
    /// wants.
    fn new() -> io::Result<Self> {
        let mut descriptor: *mut core::ffi::c_void = ptr::null_mut();
        // SAFETY: the string is a NUL-terminated UTF-16 literal that outlives
        // the call, the revision is the documented constant, `descriptor` is a
        // live out-parameter, and the optional size out-parameter is allowed
        // to be null.
        let converted = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                OWNER_ONLY_SDDL.as_ptr(),
                SDDL_REVISION_1,
                &raw mut descriptor,
                ptr::null_mut(),
            )
        };
        if converted == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Self { descriptor })
    }

    /// The `SECURITY_ATTRIBUTES` to hand `CreateNamedPipe`. Borrows this
    /// descriptor, so it cannot outlive the memory it points at.
    fn attributes(&self) -> SECURITY_ATTRIBUTES {
        SECURITY_ATTRIBUTES {
            nLength: u32::try_from(size_of::<SECURITY_ATTRIBUTES>()).unwrap_or(u32::MAX),
            lpSecurityDescriptor: self.descriptor,
            bInheritHandle: 0,
        }
    }
}

impl Drop for OwnerOnlyDescriptor {
    fn drop(&mut self) {
        if self.descriptor.is_null() {
            return;
        }
        // SAFETY: the descriptor came from
        // `ConvertStringSecurityDescriptorToSecurityDescriptorW`, which
        // documents `LocalFree` as the way to release it, and this type owns
        // it, so nothing else can free or read it afterwards.
        unsafe {
            LocalFree(self.descriptor as HLOCAL);
        }
        self.descriptor = ptr::null_mut();
    }
}

/// Creates one instance of the pipe at `path`, admitting its owner alone.
///
/// `first` asks Windows to refuse the call unless this is the first instance,
/// which is how a listener finds out that another process already serves the
/// address instead of quietly joining it.
pub(super) fn create_owner_only_instance(path: &Path, first: bool) -> io::Result<NamedPipeServer> {
    let descriptor = OwnerOnlyDescriptor::new()?;
    let mut attributes = descriptor.attributes();
    let mut options = ServerOptions::new();
    options.first_pipe_instance(first);
    // A pipe reachable over the network is not a local socket at all.
    options.reject_remote_clients(true);

    // SAFETY: `attributes` is a live, fully initialised `SECURITY_ATTRIBUTES`
    // whose descriptor `descriptor` keeps alive for the whole call, which is
    // all `create_with_security_attributes_raw` reads it for: Windows copies
    // what it needs into the object it creates.
    let server = unsafe {
        options.create_with_security_attributes_raw(
            path,
            (&raw mut attributes).cast::<core::ffi::c_void>(),
        )
    };
    drop(descriptor);
    server
}

/// The process on the other end of a connected pipe, or `None` when Windows
/// will not say.
///
/// The peer's process is what a listener checks before it serves a connection
/// it has to trust with more than "the same machine" (local-socket.md,
/// Authentication).
pub(super) fn client_process_id(server: &NamedPipeServer) -> Option<u32> {
    let mut process_id: u32 = 0;
    // SAFETY: the handle is borrowed from a live `NamedPipeServer`, so it is
    // open for the duration of the call, and `process_id` is a live
    // out-parameter of exactly the width the function writes.
    let read = unsafe { GetNamedPipeClientProcessId(server.as_raw_handle(), &raw mut process_id) };
    (read != 0).then_some(process_id)
}
