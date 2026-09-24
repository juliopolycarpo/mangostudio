//! Open-file identity shared by mutation guards and non-authoritative caches.

use std::fs::{File, Metadata};
use std::path::Path;

#[cfg(not(windows))]
use cap_fs_ext::MetadataExt as _;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) struct ObjectIdentity {
    device: u64,
    inode: u64,
}

impl ObjectIdentity {
    /// The device (Unix `st_dev`) or volume serial (Windows) holding the object.
    pub(crate) fn device(self) -> u64 {
        self.device
    }

    /// The inode (Unix `st_ino`) or 64-bit file index (Windows) of the object.
    pub(crate) fn inode(self) -> u64 {
        self.inode
    }
}

/// Identifies the opened object independently of its path and timestamps.
///
/// # Example
///
/// ```ignore
/// let identity = object_identity(&file, &file.metadata()?)?;
/// ```
#[cfg(not(windows))]
pub(crate) fn object_identity(_: &File, metadata: &Metadata) -> std::io::Result<ObjectIdentity> {
    Ok(ObjectIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
    })
}

#[cfg(windows)]
#[allow(
    unsafe_code,
    reason = "stable Rust does not expose Windows file identity from Metadata"
)]
pub(crate) fn object_identity(file: &File, _: &Metadata) -> std::io::Result<ObjectIdentity> {
    use std::mem::MaybeUninit;
    use std::os::windows::io::AsRawHandle as _;
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
    };

    let mut information = MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::uninit();
    // SAFETY: `file` owns a live handle and `information` points to writable,
    // correctly aligned storage for the structure populated by the API.
    let success =
        unsafe { GetFileInformationByHandle(file.as_raw_handle(), information.as_mut_ptr()) };
    if success == 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: a successful call initialized every field in the structure.
    let information = unsafe { information.assume_init() };
    Ok(ObjectIdentity {
        device: u64::from(information.dwVolumeSerialNumber),
        inode: (u64::from(information.nFileIndexHigh) << 32) | u64::from(information.nFileIndexLow),
    })
}

/// Fingerprints an executable cache entry; failed identity reads bypass caching.
/// This never represents consent or any other authority.
///
/// # Example
///
/// ```ignore
/// let key = fingerprint(Path::new("/usr/bin/git"));
/// ```
pub(crate) fn fingerprint(path: &Path) -> Option<String> {
    let file = File::open(path).ok()?;
    let metadata = file.metadata().ok()?;
    let identity = object_identity(&file, &metadata).ok()?;
    let modified = metadata
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_nanos();
    #[cfg(unix)]
    let changed = (
        std::os::unix::fs::MetadataExt::ctime(&metadata),
        std::os::unix::fs::MetadataExt::ctime_nsec(&metadata),
    );
    #[cfg(not(unix))]
    let changed = ();
    Some(format!(
        "{}:{}:{modified}:{changed:?}:{}:{:?}",
        identity.device,
        identity.inode,
        metadata.len(),
        metadata.permissions()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::scratch_dir;

    #[test]
    fn fingerprints_reuse_an_object_but_distinguish_equal_metadata_replacements() {
        let dir = scratch_dir("file-identity");
        let path = dir.join("binary");
        std::fs::write(&path, "first").unwrap();
        let first = fingerprint(&path).unwrap();
        assert_eq!(fingerprint(&path).unwrap(), first);
        let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
        let replacement = dir.join("replacement");
        std::fs::write(&replacement, "other").unwrap();
        File::options()
            .write(true)
            .open(&replacement)
            .unwrap()
            .set_modified(modified)
            .unwrap();
        // Remove first on Windows, where std rename does not replace an existing leaf.
        std::fs::remove_file(&path).unwrap();
        std::fs::rename(&replacement, &path).unwrap();
        assert_ne!(fingerprint(&path).unwrap(), first);
        std::fs::remove_file(&path).unwrap();
        assert_eq!(fingerprint(&path), None);
    }

    #[cfg(unix)]
    #[test]
    fn executable_permission_changes_invalidate_the_fingerprint() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch_dir("file-identity-permission");
        let path = dir.join("binary");
        std::fs::write(&path, "content").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        let executable = fingerprint(&path).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_ne!(fingerprint(&path).unwrap(), executable);
    }
}
