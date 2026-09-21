//! Object-bound access for paths controlled by a filesystem policy.
//!
//! A string-path check alone cannot authorize a later ambient open: an
//! ancestor can change between those operations. This module checks the
//! requested path, opens it once, then checks the opened object's final host
//! path before giving that object to an operation.

use std::ffi::OsString;
use std::fs::{self, File};
use std::path::{Path, PathBuf};

use cap_fs_ext::DirExt as _;
use cap_std::ambient_authority;
use cap_std::fs::Dir;
use mango_protocol::error::{RemoteError, codes};

use super::policy::CompiledPolicy;
use crate::workspace::lexically_normalize;

/// A directory that has been opened and checked against the final policy.
pub(super) struct BoundDir {
    anchor: AnchoredDir,
}

impl BoundDir {
    /// Re-opens this directory from the filesystem root before running a
    /// relative operation.
    ///
    /// # Example
    ///
    /// ```ignore
    /// directory.with_dir(|dir| dir.entries().map_err(io_error))?;
    /// ```
    pub(super) fn with_dir<T>(
        &self,
        operation: impl FnOnce(&Dir) -> Result<T, RemoteError>,
    ) -> Result<T, RemoteError> {
        let dir = self.anchor.open_directory()?;
        operation(&dir)
    }
}

/// A verified directory capability and a single relative filename.
///
/// Mutations must use `dir` and `leaf` together. Reconstructing an ambient
/// path from either value would discard the authority this type preserves.
pub(super) struct VerifiedParent {
    leaf: OsString,
    anchor: AnchoredDir,
}

impl VerifiedParent {
    fn leaf(&self) -> &Path {
        Path::new(&self.leaf)
    }

    /// Re-opens this parent from the filesystem root before mutating its
    /// verified leaf.
    ///
    /// # Example
    ///
    /// ```ignore
    /// parent.with_parent(|dir, leaf| dir.remove_file(leaf).map_err(io_error))?;
    /// ```
    pub(super) fn with_parent<T>(
        &self,
        operation: impl FnOnce(&Dir, &Path) -> Result<T, RemoteError>,
    ) -> Result<T, RemoteError> {
        let dir = self.anchor.open_directory()?;
        operation(&dir, self.leaf())
    }
}

/// A cross-parent operation failed either while restoring the policy-bound
/// capabilities or in the filesystem operation itself.
pub(super) enum ParentOperationError {
    Access(RemoteError),
    Io(std::io::Error),
}

/// Re-opens two verified parents from their respective anchors for one
/// cross-directory operation.
pub(super) fn with_parents<T>(
    first: &VerifiedParent,
    second: &VerifiedParent,
    operation: impl FnOnce(&Dir, &Path, &Dir, &Path) -> std::io::Result<T>,
) -> Result<T, ParentOperationError> {
    let first_dir = first
        .anchor
        .open_directory()
        .map_err(ParentOperationError::Access)?;
    let second_dir = second
        .anchor
        .open_directory()
        .map_err(ParentOperationError::Access)?;
    operation(&first_dir, first.leaf(), &second_dir, second.leaf())
        .map_err(ParentOperationError::Io)
}

/// An immutable path below a filesystem-root capability.
///
/// The descendant itself is deliberately not retained as the authority for a
/// later operation: it may be renamed after it is checked. Every use starts
/// at the filesystem/volume `root` and walks `relative` with no-follow
/// directory opens.
struct AnchoredDir {
    root: Dir,
    relative: Vec<OsString>,
    requested: PathBuf,
}

impl AnchoredDir {
    fn open_directory(&self) -> Result<Dir, RemoteError> {
        let mut directory = self.root.try_clone().map_err(handle_error)?;
        for component in &self.relative {
            directory = directory
                .open_dir_nofollow(component)
                .map_err(|error| anchored_open_error(&self.requested, error))?;
        }
        Ok(directory)
    }
}

fn anchored_open_error(path: &Path, error: std::io::Error) -> RemoteError {
    if matches!(
        error.kind(),
        std::io::ErrorKind::NotFound
            | std::io::ErrorKind::NotADirectory
            | std::io::ErrorKind::TooManyLinks
    ) {
        return path_error(format!(
            "Cannot reopen \"{}\" through its policy-bound directory: {error}",
            path.display()
        ))
        .with_detail("anchorReopen", true);
    }
    open_error(path, error)
}

/// Opens an existing file once and rejects it when its handle resolves outside
/// the policy roots.
///
/// # Example
///
/// ```ignore
/// let mut file = open_existing_file(&policy, requested)?;
/// std::io::Read::read_to_end(&mut file, &mut bytes)?;
/// ```
pub(super) fn open_existing_file(
    policy: &CompiledPolicy,
    path: &Path,
) -> Result<File, RemoteError> {
    open_existing_file_with_hook(policy, path, &NoopOpenHook)
}

/// Opens a directory once and returns a relative directory capability only
/// after checking the directory handle's final host path.
///
/// # Example
///
/// ```ignore
/// let directory = open_directory(&policy, requested)?;
/// directory.with_dir(|dir| dir.entries().map_err(io_error))?;
/// ```
pub(super) fn open_directory(
    policy: &CompiledPolicy,
    path: &Path,
) -> Result<BoundDir, RemoteError> {
    open_directory_with_hook(policy, path, &NoopOpenHook)
}

/// Opens and checks an optional directory, returning `None` when the target or
/// one of its parents does not exist or is not a directory.
///
/// # Example
///
/// ```ignore
/// if let Some(directory) = open_directory_if_present(&policy, requested)? {
///     directory.with_dir(|dir| dir.entries().map_err(io_error))?;
/// }
/// ```
pub(super) fn open_directory_if_present(
    policy: &CompiledPolicy,
    path: &Path,
) -> Result<Option<BoundDir>, RemoteError> {
    policy.check(path)?;
    match Dir::open_ambient_dir(path, ambient_authority()) {
        Ok(dir) => bind_opened_directory(policy, path, dir).map(Some),
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
            ) =>
        {
            Ok(None)
        }
        Err(error) => Err(open_error(path, error)),
    }
}

/// Returns a checked parent directory and relative leaf for mutations. When
/// `create_missing` is true, it creates missing parents only through a
/// verified existing ancestor, with no-follow component opens.
///
/// # Example
///
/// ```ignore
/// let destination = verified_parent(&policy, requested, true)?;
/// destination.with_parent(|dir, leaf| dir.open_with(leaf, options).map_err(io_error))?;
/// ```
pub(super) fn verified_parent(
    policy: &CompiledPolicy,
    path: &Path,
    create_missing: bool,
) -> Result<VerifiedParent, RemoteError> {
    verified_parent_with_hook(policy, path, create_missing, &NoopOpenHook)
}

/// Returns a checked parent capability when every parent component currently
/// exists, without creating anything. A missing parent is reported as `None`.
///
/// # Example
///
/// ```ignore
/// if let Some(parent) = verified_parent_if_present(&policy, requested)? {
///     parent.with_parent(|dir, leaf| dir.symlink_metadata(leaf).map_err(io_error))?;
/// }
/// ```
pub(super) fn verified_parent_if_present(
    policy: &CompiledPolicy,
    path: &Path,
) -> Result<Option<VerifiedParent>, RemoteError> {
    policy.check(path)?;
    let target = absolute_normalized(path)?;
    let (ancestor, missing, leaf) = existing_parent_and_missing(&target)?;
    let opened = Dir::open_ambient_dir(&ancestor, ambient_authority())
        .map_err(|error| open_error(&ancestor, error))?;
    bind_verified_parent(policy, path, opened, &missing, leaf, false)
}

trait OpenHook {
    fn after_resolution(&self);
}

struct NoopOpenHook;

impl OpenHook for NoopOpenHook {
    fn after_resolution(&self) {}
}

fn open_existing_file_with_hook(
    policy: &CompiledPolicy,
    path: &Path,
    hook: &dyn OpenHook,
) -> Result<File, RemoteError> {
    policy.check(path)?;
    hook.after_resolution();
    let file = open_file(path).map_err(|error| open_error(path, error))?;
    check_file_handle(policy, path, &file)?;
    Ok(file)
}

fn open_directory_with_hook(
    policy: &CompiledPolicy,
    path: &Path,
    hook: &dyn OpenHook,
) -> Result<BoundDir, RemoteError> {
    policy.check(path)?;
    hook.after_resolution();
    let dir = Dir::open_ambient_dir(path, ambient_authority())
        .map_err(|error| open_error(path, error))?;
    bind_opened_directory(policy, path, dir)
}

fn verified_parent_with_hook(
    policy: &CompiledPolicy,
    path: &Path,
    create_missing: bool,
    hook: &dyn OpenHook,
) -> Result<VerifiedParent, RemoteError> {
    policy.check(path)?;
    let target = absolute_normalized(path)?;
    let (ancestor, missing, leaf) = existing_parent_and_missing(&target)?;
    hook.after_resolution();

    let opened = Dir::open_ambient_dir(&ancestor, ambient_authority())
        .map_err(|error| open_error(&ancestor, error))?;
    bind_verified_parent(policy, path, opened, &missing, leaf, create_missing)?.ok_or_else(|| {
        path_error(format!(
            "Filesystem object not found: \"{}\"",
            path.display()
        ))
    })
}

/// Checks an already-open directory handle and returns its relative capability.
pub(super) fn bind_opened_directory(
    policy: &CompiledPolicy,
    requested: &Path,
    dir: Dir,
) -> Result<BoundDir, RemoteError> {
    let final_path = directory_final_path(&dir)?;
    policy.check_final_handle_path(requested, &final_path)?;
    let anchor = bind_authorization_anchor(policy, requested, &final_path, &final_path)?;
    Ok(BoundDir { anchor })
}

fn bind_verified_parent(
    policy: &CompiledPolicy,
    requested: &Path,
    ancestor: Dir,
    missing: &[OsString],
    leaf: OsString,
    create_missing: bool,
) -> Result<Option<VerifiedParent>, RemoteError> {
    let mut parent_target = directory_final_path(&ancestor)?;
    parent_target.extend(missing);
    let mut final_target = parent_target.clone();
    final_target.push(&leaf);
    policy.check_final_handle_path(requested, &final_target)?;
    let anchor = bind_authorization_anchor(policy, requested, &final_target, &parent_target)?;
    let Some(dir) = open_or_create_anchored_directory(&anchor, create_missing)? else {
        return Ok(None);
    };
    drop(dir);
    Ok(Some(VerifiedParent { leaf, anchor }))
}

fn open_or_create_anchored_directory(
    anchor: &AnchoredDir,
    create_missing: bool,
) -> Result<Option<Dir>, RemoteError> {
    let mut dir = anchor.root.try_clone().map_err(handle_error)?;
    for component in &anchor.relative {
        if create_missing {
            dir = open_or_create_child(dir, component, true, &anchor.requested)?;
            continue;
        }
        match dir.open_dir_nofollow(component) {
            Ok(child) => dir = child,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(open_error(&anchor.requested, error)),
        }
    }
    Ok(Some(dir))
}

fn bind_authorization_anchor(
    policy: &CompiledPolicy,
    requested: &Path,
    final_target: &Path,
    directory_target: &Path,
) -> Result<AnchoredDir, RemoteError> {
    policy.check_final_handle_path(requested, final_target)?;
    // A configured policy root can itself be renamed after binding. Only the
    // filesystem/volume root is immutable for the lifetime of a capability;
    // the private relative path then confines each later operation to the
    // original checked namespace location.
    let root = filesystem_root(directory_target).ok_or_else(|| {
        path_error(format!(
            "Cannot bind \"{}\": its final path has no filesystem root.",
            requested.display()
        ))
    })?;
    let anchor = Dir::open_ambient_dir(&root, ambient_authority())
        .map_err(|error| open_error(requested, error))?;
    let anchor_final = directory_final_path(&anchor)?;
    if !paths_equal(&anchor_final, &root) {
        return Err(path_error(format!(
            "Cannot bind \"{}\": its filesystem root changed while it was being opened.",
            requested.display()
        )));
    }
    let Some(relative) = relative_components(&anchor_final, directory_target) else {
        return Err(path_error(format!(
            "Cannot bind \"{}\" to its filesystem root.",
            requested.display()
        )));
    };
    Ok(AnchoredDir {
        root: anchor,
        relative,
        requested: requested.to_path_buf(),
    })
}

fn paths_equal(left: &Path, right: &Path) -> bool {
    super::policy::is_prefix(left, right) && super::policy::is_prefix(right, left)
}

fn relative_components(anchor: &Path, target: &Path) -> Option<Vec<OsString>> {
    if !super::policy::is_prefix(anchor, target) {
        return None;
    }
    let component_count = anchor.components().count();
    target
        .components()
        .skip(component_count)
        .map(|component| match component {
            std::path::Component::Normal(component) => Some(component.to_os_string()),
            _ => None,
        })
        .collect()
}

fn filesystem_root(path: &Path) -> Option<PathBuf> {
    let mut root = PathBuf::new();
    for component in path.components() {
        root.push(component.as_os_str());
        if matches!(component, std::path::Component::RootDir) {
            return Some(root);
        }
    }
    None
}

fn directory_final_path(dir: &Dir) -> Result<PathBuf, RemoteError> {
    let handle = dir.try_clone().map_err(handle_error)?;
    final_path_from_file(&handle.into_std_file()).map_err(handle_error)
}

fn check_file_handle(
    policy: &CompiledPolicy,
    requested: &Path,
    file: &File,
) -> Result<(), RemoteError> {
    let final_path = final_path_from_file(file).map_err(handle_error)?;
    policy.check_final_handle_path(requested, &final_path)
}

/// Checks a file opened relative to a directory capability and returns its
/// standard-library handle for the existing bounded I/O helpers.
pub(super) fn verify_opened_file(
    policy: &CompiledPolicy,
    requested: &Path,
    file: cap_std::fs::File,
) -> Result<File, RemoteError> {
    let file = file.into_std();
    let final_path = final_path_from_file(&file).map_err(handle_error)?;
    policy.check_final_handle_path(requested, &final_path)?;
    Ok(file)
}

fn existing_parent_and_missing(
    target: &Path,
) -> Result<(PathBuf, Vec<OsString>, OsString), RemoteError> {
    let leaf = target.file_name().map(OsString::from).ok_or_else(|| {
        path_error(format!(
            "Cannot use \"{}\" as a filesystem target: it has no filename.",
            target.display()
        ))
    })?;
    let parent = target.parent().ok_or_else(|| {
        path_error(format!(
            "Cannot use \"{}\" as a filesystem target: it has no parent directory.",
            target.display()
        ))
    })?;
    let mut ancestor = parent.to_path_buf();
    let mut missing = Vec::new();
    loop {
        match fs::metadata(&ancestor) {
            Ok(metadata) if metadata.is_dir() => {
                missing.reverse();
                return Ok((ancestor, missing, leaf));
            }
            Ok(_) => {
                return Err(path_error(format!(
                    "Cannot create \"{}\": parent \"{}\" is not a directory.",
                    target.display(),
                    ancestor.display()
                )));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let component = ancestor.file_name().map(OsString::from).ok_or_else(|| {
                    path_error(format!(
                        "Cannot find an existing parent directory for \"{}\".",
                        target.display()
                    ))
                })?;
                missing.push(component);
                ancestor = ancestor
                    .parent()
                    .ok_or_else(|| {
                        path_error(format!(
                            "Cannot find an existing parent directory for \"{}\".",
                            target.display()
                        ))
                    })?
                    .to_path_buf();
            }
            Err(error) => return Err(open_error(&ancestor, error)),
        }
    }
}

fn open_or_create_child(
    dir: Dir,
    component: &OsString,
    create_missing: bool,
    requested: &Path,
) -> Result<Dir, RemoteError> {
    match dir.open_dir_nofollow(component) {
        Ok(child) => Ok(child),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && create_missing => {
            dir.create_dir(component).map_err(|create_error| {
                if create_error.kind() == std::io::ErrorKind::AlreadyExists {
                    path_error(format!(
                        "Cannot create parent for \"{}\": \"{}\" changed while it was being created.",
                        requested.display(),
                        Path::new(component).display()
                    ))
                } else {
                    open_error(requested, create_error)
                }
            })?;
            dir.open_dir_nofollow(component).map_err(|open_error| {
                path_error(format!(
                    "Cannot create parent for \"{}\": \"{}\" was not a directory after creation. Cause: {open_error}",
                    requested.display(),
                    Path::new(component).display()
                ))
            })
        }
        Err(error) => Err(open_error(requested, error)),
    }
}

fn absolute_normalized(path: &Path) -> Result<PathBuf, RemoteError> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|error| RemoteError::new(codes::INTERNAL, error.to_string()))?
            .join(path)
    };
    Ok(lexically_normalize(&absolute))
}

fn open_file(path: &Path) -> std::io::Result<File> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        // A FIFO substituted after policy resolution must not block the worker
        // before its handle and type can be checked by the caller.
        options.custom_flags(nix::libc::O_NONBLOCK);
    }
    options.open(path)
}

fn open_error(path: &Path, error: std::io::Error) -> RemoteError {
    if error.kind() == std::io::ErrorKind::NotFound {
        path_error(format!(
            "Filesystem object not found: \"{}\"",
            path.display()
        ))
    } else {
        RemoteError::new(codes::INTERNAL, error.to_string())
    }
}

fn handle_error(error: std::io::Error) -> RemoteError {
    path_error(format!(
        "Cannot verify the opened filesystem object's final path: {error}"
    ))
}

fn path_error(message: String) -> RemoteError {
    RemoteError::new(codes::INTERNAL, message).with_detail("kind", "path_access")
}

#[cfg(target_os = "linux")]
fn final_path_from_file(file: &File) -> std::io::Result<PathBuf> {
    use std::os::fd::AsRawFd as _;

    std::fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd()))
}

#[cfg(target_os = "macos")]
fn final_path_from_file(file: &File) -> std::io::Result<PathBuf> {
    macos::final_path_from_file(file)
}

#[cfg(target_os = "macos")]
mod macos {
    #![allow(
        unsafe_code,
        reason = "macOS exposes an opened file descriptor's final path only through fcntl(F_GETPATH)"
    )]
    #![deny(clippy::undocumented_unsafe_blocks)]

    use std::ffi::{CStr, OsStr};
    use std::fs::File;
    use std::os::fd::AsRawFd as _;
    use std::os::unix::ffi::OsStrExt as _;
    use std::path::PathBuf;

    pub(super) fn final_path_from_file(file: &File) -> std::io::Result<PathBuf> {
        let mut path = [0_i8; nix::libc::PATH_MAX as usize];
        // SAFETY: `path` is writable PATH_MAX-sized storage. The descriptor stays
        // live for the call and F_GETPATH writes a NUL-terminated path on success.
        let result =
            unsafe { nix::libc::fcntl(file.as_raw_fd(), nix::libc::F_GETPATH, path.as_mut_ptr()) };
        if result == -1 {
            return Err(std::io::Error::last_os_error());
        }
        // SAFETY: F_GETPATH succeeded, so the buffer contains a NUL-terminated path.
        let bytes = unsafe { CStr::from_ptr(path.as_ptr()) }.to_bytes();
        Ok(PathBuf::from(OsStr::from_bytes(bytes)))
    }
}

#[cfg(windows)]
fn final_path_from_file(file: &File) -> std::io::Result<PathBuf> {
    windows::final_path_from_file(file)
}

#[cfg(windows)]
mod windows {
    #![allow(
        unsafe_code,
        reason = "Windows exposes an opened handle's final path only through GetFinalPathNameByHandleW"
    )]
    #![deny(clippy::undocumented_unsafe_blocks)]

    use std::ffi::OsString;
    use std::fs::File;
    use std::os::windows::ffi::OsStringExt as _;
    use std::os::windows::io::AsRawHandle as _;
    use std::path::PathBuf;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_NAME_NORMALIZED, GetFinalPathNameByHandleW,
    };

    pub(super) fn final_path_from_file(file: &File) -> std::io::Result<PathBuf> {
        let mut buffer = vec![0_u16; 512];
        loop {
            // SAFETY: the handle is live, and `buffer` is writable for the exact
            // number of UTF-16 code units passed to the Windows API.
            let length = unsafe {
                GetFinalPathNameByHandleW(
                    file.as_raw_handle().cast(),
                    buffer.as_mut_ptr(),
                    buffer.len() as u32,
                    FILE_NAME_NORMALIZED,
                )
            };
            if length == 0 {
                return Err(std::io::Error::last_os_error());
            }
            if (length as usize) < buffer.len() {
                let path = PathBuf::from(OsString::from_wide(&buffer[..length as usize]));
                return Ok(super::super::policy::normalize_windows_final_path(&path));
            }
            buffer.resize(length as usize + 1, 0);
        }
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn final_path_from_file(_file: &File) -> std::io::Result<PathBuf> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "this platform cannot report an opened filesystem object's final path",
    ))
}

#[cfg(test)]
mod tests {
    use std::io::Read as _;

    use super::*;
    use crate::filesystem::policy::PathPolicy;
    use crate::test_support::scratch_dir;

    #[cfg(unix)]
    struct SwapAncestor {
        link: PathBuf,
        replacement: PathBuf,
    }

    #[cfg(unix)]
    impl OpenHook for SwapAncestor {
        fn after_resolution(&self) {
            std::fs::remove_file(&self.link).unwrap();
            std::os::unix::fs::symlink(&self.replacement, &self.link).unwrap();
        }
    }

    #[cfg(unix)]
    struct RenameAfterBind {
        from: PathBuf,
        to: PathBuf,
    }

    #[cfg(unix)]
    impl RenameAfterBind {
        fn apply(&self) {
            std::fs::rename(&self.from, &self.to).unwrap();
        }
    }

    #[cfg(unix)]
    fn swapped_policy_fixture(
        name: &str,
    ) -> (
        crate::test_support::ScratchDir,
        CompiledPolicy,
        PathBuf,
        PathBuf,
        SwapAncestor,
    ) {
        let scratch = scratch_dir(name);
        let root = scratch.join("root");
        let safe = root.join("safe");
        let outside = scratch.join("outside");
        let link = root.join("link");
        std::fs::create_dir_all(&safe).unwrap();
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(safe.join("secret.txt"), b"inside").unwrap();
        std::fs::write(outside.join("secret.txt"), b"outside").unwrap();
        std::os::unix::fs::symlink(&safe, &link).unwrap();
        let policy = PathPolicy {
            containment_root: Some(root),
            ..PathPolicy::default()
        }
        .compile()
        .unwrap();
        let requested = link.join("secret.txt");
        let hook = SwapAncestor {
            link,
            replacement: outside.clone(),
        };
        (scratch, policy, requested, outside, hook)
    }

    #[cfg(unix)]
    #[test]
    fn rejects_file_open_when_a_checked_ancestor_swaps_outside() {
        let (_scratch, policy, requested, _outside, hook) =
            swapped_policy_fixture("filesystem-capability-file-swap");

        let error = open_existing_file_with_hook(&policy, &requested, &hook).unwrap_err();

        assert_eq!(error.details.unwrap()["kind"], "path_access");
    }

    #[cfg(unix)]
    #[test]
    fn rejects_directory_open_when_a_checked_ancestor_swaps_outside() {
        let (_scratch, policy, requested, _outside, hook) =
            swapped_policy_fixture("filesystem-capability-directory-swap");
        let directory = requested.parent().unwrap();

        let error = match open_directory_with_hook(&policy, directory, &hook) {
            Ok(_) => panic!("the swapped directory must be rejected"),
            Err(error) => error,
        };

        assert_eq!(error.details.unwrap()["kind"], "path_access");
    }

    #[cfg(unix)]
    #[test]
    fn refuses_to_create_below_an_ancestor_that_swaps_outside() {
        let (_scratch, policy, requested, outside, hook) =
            swapped_policy_fixture("filesystem-capability-parent-swap");
        let missing = requested.parent().unwrap().join("new/note.txt");

        let error = match verified_parent_with_hook(&policy, &missing, true, &hook) {
            Ok(_) => panic!("the swapped parent must be rejected"),
            Err(error) => error,
        };

        assert_eq!(error.details.unwrap()["kind"], "path_access");
        assert!(!outside.join("new/note.txt").exists());
    }

    #[test]
    fn binds_an_existing_file_to_the_opened_object() {
        let scratch = scratch_dir("filesystem-capability-file");
        let file_path = scratch.join("note.txt");
        std::fs::write(&file_path, b"bound").unwrap();
        let policy = PathPolicy {
            containment_root: Some(scratch.to_path_buf()),
            ..PathPolicy::default()
        }
        .compile()
        .unwrap();

        let mut file = open_existing_file(&policy, &file_path).unwrap();
        let mut content = String::new();
        file.read_to_string(&mut content).unwrap();

        assert_eq!(content, "bound");
    }

    #[test]
    fn reports_missing_parent_without_creating_it() {
        let scratch = scratch_dir("filesystem-capability-missing-parent");
        let root = scratch.join("root");
        std::fs::create_dir(&root).unwrap();
        let requested = root.join("missing/note.txt");
        let policy = PathPolicy {
            containment_root: Some(root),
            ..PathPolicy::default()
        }
        .compile()
        .unwrap();

        assert!(
            verified_parent_if_present(&policy, &requested)
                .unwrap()
                .is_none()
        );
        assert!(!requested.parent().unwrap().exists());
    }

    #[test]
    fn exact_file_roots_can_bind_their_parent_without_authorizing_siblings() {
        let scratch = scratch_dir("filesystem-capability-file-root");
        let allowed = scratch.join("allowed.txt");
        let sibling = scratch.join("sibling.txt");
        std::fs::write(&allowed, b"allowed").unwrap();
        std::fs::write(&sibling, b"sibling").unwrap();
        let policy = PathPolicy {
            allowed_roots: vec![allowed.clone()],
            ..PathPolicy::default()
        }
        .compile()
        .unwrap();

        let parent = verified_parent(&policy, &allowed, false).unwrap();
        assert!(
            parent
                .with_parent(|dir, leaf| {
                    dir.symlink_metadata(leaf)
                        .map(|metadata| metadata.is_file())
                        .map_err(|error| open_error(leaf, error))
                })
                .unwrap()
        );
        assert!(verified_parent(&policy, &sibling, false).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn parent_operation_cannot_follow_a_descendant_renamed_after_binding() {
        let scratch = scratch_dir("filesystem-capability-parent-rename-after-bind");
        let root = scratch.join("root");
        let nested = root.join("safe/nested");
        let relocated = scratch.join("outside/nested");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::create_dir_all(relocated.parent().unwrap()).unwrap();
        let requested = nested.join("new.txt");
        let policy = PathPolicy {
            containment_root: Some(root),
            ..PathPolicy::default()
        }
        .compile()
        .unwrap();
        let parent = verified_parent(&policy, &requested, false).unwrap();
        let rename = RenameAfterBind {
            from: nested,
            to: relocated.clone(),
        };

        rename.apply();
        let error = parent
            .with_parent(|dir, leaf| {
                dir.create_dir(leaf)
                    .map_err(|error| open_error(leaf, error))
            })
            .unwrap_err();

        assert_eq!(error.details.unwrap()["kind"], "path_access");
        assert!(!relocated.join("new.txt").exists());
    }

    #[cfg(unix)]
    #[test]
    fn directory_operation_cannot_read_a_descendant_renamed_after_binding() {
        use std::cell::Cell;

        let scratch = scratch_dir("filesystem-capability-directory-rename-after-bind");
        let root = scratch.join("root");
        let nested = root.join("safe/nested");
        let relocated = scratch.join("outside/nested");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::create_dir_all(relocated.parent().unwrap()).unwrap();
        std::fs::write(nested.join("secret.txt"), b"outside after rename").unwrap();
        let policy = PathPolicy {
            containment_root: Some(root),
            ..PathPolicy::default()
        }
        .compile()
        .unwrap();
        let directory = open_directory(&policy, &nested).unwrap();
        let rename = RenameAfterBind {
            from: nested,
            to: relocated,
        };
        let operation_ran = Cell::new(false);

        rename.apply();
        let error = directory
            .with_dir(|dir| {
                operation_ran.set(true);
                dir.entries()
                    .map(|_| ())
                    .map_err(crate::filesystem::io::io_error)
            })
            .unwrap_err();

        assert_eq!(error.details.unwrap()["kind"], "path_access");
        assert!(!operation_ran.get());
    }

    #[cfg(unix)]
    #[test]
    fn directory_operation_cannot_follow_a_containment_root_renamed_after_binding() {
        use std::cell::Cell;

        let scratch = scratch_dir("filesystem-capability-containment-root-rename");
        let root = scratch.join("root");
        let nested = root.join("nested");
        let relocated = scratch.join("relocated-root");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("secret.txt"), b"must not be read").unwrap();
        let policy = PathPolicy {
            containment_root: Some(root.clone()),
            ..PathPolicy::default()
        }
        .compile()
        .unwrap();
        let directory = open_directory(&policy, &nested).unwrap();
        let rename = RenameAfterBind {
            from: root,
            to: relocated,
        };
        let operation_ran = Cell::new(false);

        rename.apply();
        let error = directory
            .with_dir(|dir| {
                operation_ran.set(true);
                dir.entries()
                    .map(|_| ())
                    .map_err(crate::filesystem::io::io_error)
            })
            .unwrap_err();

        assert_eq!(error.details.unwrap()["kind"], "path_access");
        assert!(!operation_ran.get());
    }

    #[cfg(unix)]
    #[test]
    fn parent_operation_cannot_follow_an_allowed_root_renamed_after_binding() {
        let scratch = scratch_dir("filesystem-capability-allowed-root-rename");
        let allowed = scratch.join("allowed");
        let nested = allowed.join("nested");
        let relocated = scratch.join("relocated-allowed");
        std::fs::create_dir_all(&nested).unwrap();
        let requested = nested.join("new.txt");
        let policy = PathPolicy {
            allowed_roots: vec![allowed.clone()],
            ..PathPolicy::default()
        }
        .compile()
        .unwrap();
        let parent = verified_parent(&policy, &requested, false).unwrap();
        let rename = RenameAfterBind {
            from: allowed,
            to: relocated.clone(),
        };

        rename.apply();
        let error = parent
            .with_parent(|dir, leaf| {
                dir.create_dir(leaf)
                    .map_err(|error| open_error(leaf, error))
            })
            .unwrap_err();

        assert_eq!(error.details.unwrap()["kind"], "path_access");
        assert!(!relocated.join("nested/new.txt").exists());
    }

    #[test]
    fn deny_only_policy_uses_a_fixed_filesystem_root_anchor() {
        let scratch = scratch_dir("filesystem-capability-deny-only");
        let allowed = scratch.join("allowed");
        let denied = scratch.join("denied");
        std::fs::create_dir_all(&allowed).unwrap();
        std::fs::create_dir(&denied).unwrap();
        let policy = PathPolicy {
            denied_roots: vec![denied.clone()],
            ..PathPolicy::default()
        }
        .compile()
        .unwrap();

        let directory = open_directory(&policy, &allowed).unwrap();
        directory
            .with_dir(|dir| {
                dir.entries()
                    .map(|_| ())
                    .map_err(crate::filesystem::io::io_error)
            })
            .unwrap();
        assert!(open_directory(&policy, &denied).is_err());
    }
}
