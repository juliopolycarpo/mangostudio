//! The filesystem seam every library mutation goes through, mirroring the
//! `BackupStoreFs`, `ResourceWriterFs` and `TreeRemovalFs` interfaces the
//! TypeScript engines inject, so a test can fault one rename in the middle
//! of a multi-destination apply and watch the compensation run.
//!
//! [`NativeMutationFs`] reproduces the Node primitives those interfaces wrap:
//! `cp(..., { recursive, force: false, errorOnExist: true,
//! preserveTimestamps: true })`, `rm(..., { recursive, force: true })`,
//! `mkdir(..., { recursive: true })`, `rename`, `lstat` answering `null` for
//! a missing path, and the symlink-following `writeLibraryFileAtomic`. None
//! of them fsyncs, exactly as the TypeScript host does not: the durability
//! promise is atomic replacement by rename, nothing stronger.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use super::paths::{ResourceKind, node_basename, node_dirname, resolve_through_existing_ancestor};

/// Why a copy is being made. Only a fault fixture reads it: the TypeScript
/// writer's `copyTree` takes the same tag so a test can fail staging without
/// failing the backup taken just before it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CopyPurpose {
    Backup,
    Stage,
    Restore,
}

/// A directory entry's own type, never following a symlink (a `Dirent`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum EntryType {
    File,
    Directory,
    Other,
}

/// The seam; see the module docs.
pub(crate) trait MutationFs: Send + Sync {
    /// `cp` of a file, directory tree or symlink to a destination that must
    /// not exist yet.
    fn copy_tree(&self, source: &Path, destination: &Path, purpose: CopyPurpose) -> io::Result<()>;
    /// `lstat` reduced to "is anything there": `Ok(false)` only for a
    /// genuinely absent path.
    fn exists(&self, path: &Path) -> io::Result<bool>;
    /// `mkdir -p`.
    fn create_dir_all(&self, path: &Path) -> io::Result<()>;
    /// `rename`.
    fn rename(&self, source: &Path, destination: &Path) -> io::Result<()>;
    /// `rm -rf`: a missing path is success.
    fn remove_all(&self, path: &Path) -> io::Result<()>;
    /// `writeLibraryFileAtomic`: a same-directory temporary file renamed
    /// over the symlink-resolved destination, keeping the target's mode.
    fn write_file_atomic(&self, path: &str, contents: &[u8]) -> io::Result<()>;
    /// `writeFile(path, contents, 'utf8')`, used only for manifests.
    fn write_text(&self, path: &Path, contents: &str) -> io::Result<()>;
    /// `readFile(path, 'utf8')`.
    fn read_text(&self, path: &Path) -> io::Result<String>;
    /// `readdir(path, { withFileTypes: true })`.
    fn read_dir(&self, path: &Path) -> io::Result<Vec<(String, EntryType)>>;
    /// `stat(path)`: `(size, mtimeMs)`, following symlinks.
    fn stat(&self, path: &Path) -> io::Result<(u64, f64)>;
}

/// The real machine.
pub(crate) struct NativeMutationFs;

impl MutationFs for NativeMutationFs {
    fn copy_tree(
        &self,
        source: &Path,
        destination: &Path,
        _purpose: CopyPurpose,
    ) -> io::Result<()> {
        copy_entry(source, destination)
    }

    fn exists(&self, path: &Path) -> io::Result<bool> {
        match fs::symlink_metadata(path) {
            Ok(_) => Ok(true),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error),
        }
    }

    fn create_dir_all(&self, path: &Path) -> io::Result<()> {
        fs::create_dir_all(path)
    }

    fn rename(&self, source: &Path, destination: &Path) -> io::Result<()> {
        fs::rename(source, destination)
    }

    fn remove_all(&self, path: &Path) -> io::Result<()> {
        remove_all(path)
    }

    fn write_file_atomic(&self, path: &str, contents: &[u8]) -> io::Result<()> {
        write_library_file_atomic(path, contents)
    }

    fn write_text(&self, path: &Path, contents: &str) -> io::Result<()> {
        fs::write(path, contents)
    }

    fn read_text(&self, path: &Path) -> io::Result<String> {
        let mut bytes = Vec::new();
        File::open(path)?.read_to_end(&mut bytes)?;
        // `readFile(path, 'utf8')` replaces invalid sequences rather than
        // failing; JSON.parse then decides.
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    }

    fn read_dir(&self, path: &Path) -> io::Result<Vec<(String, EntryType)>> {
        let mut entries = Vec::new();
        for entry in fs::read_dir(path)? {
            let entry = entry?;
            let file_type = entry.file_type()?;
            let kind = if file_type.is_dir() {
                EntryType::Directory
            } else if file_type.is_file() {
                EntryType::File
            } else {
                EntryType::Other
            };
            entries.push((entry.file_name().to_string_lossy().into_owned(), kind));
        }
        Ok(entries)
    }

    fn stat(&self, path: &Path) -> io::Result<(u64, f64)> {
        let metadata = fs::metadata(path)?;
        Ok((metadata.len(), super::super::fs::mtime_ms(&metadata)))
    }
}

/// `rm(path, { recursive: true, force: true })`.
pub(crate) fn remove_all(path: &Path) -> io::Result<()> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    let result = if metadata.is_dir() {
        fs::remove_dir_all(path)
    } else {
        remove_link_or_file(path, &metadata)
    };
    match result {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

/// A file, or a symlink — which on Windows must be removed as whatever kind
/// of link it is (a directory symlink is not a file there).
fn remove_link_or_file(path: &Path, metadata: &fs::Metadata) -> io::Result<()> {
    match fs::remove_file(path) {
        Err(error) if cfg!(windows) && metadata.is_symlink() => {
            fs::remove_dir(path).map_err(|_| error)
        }
        other => other,
    }
}

/// One step of `cp`'s recursive copy. The source is inspected with
/// `lstat` (`dereference: false`): a symlink is recreated as a symlink,
/// its relative target resolved against the link's own directory as
/// `verbatimSymlinks: false` does. Anything that is neither a file, a
/// directory nor a symlink is refused, as `cp` refuses a FIFO or socket.
fn copy_entry(source: &Path, destination: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(source)?;
    if fs::symlink_metadata(destination).is_ok() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!(
                "Refusing to copy onto an existing path: {}",
                destination.display()
            ),
        ));
    }
    if metadata.is_symlink() {
        let target = fs::read_link(source)?;
        let absolute = if target.has_root() {
            target
        } else {
            source.parent().unwrap_or(Path::new("")).join(target)
        };
        return make_symlink(&absolute, destination);
    }
    if metadata.is_dir() {
        fs::create_dir(destination)?;
        for entry in fs::read_dir(source)? {
            let name = entry?.file_name();
            copy_entry(&source.join(&name), &destination.join(&name))?;
        }
        return fs::set_permissions(destination, metadata.permissions());
    }
    if metadata.is_file() {
        fs::copy(source, destination)?;
        return preserve_times(destination, &metadata);
    }
    Err(io::Error::new(
        io::ErrorKind::InvalidInput,
        format!(
            "Cannot copy {}: it is not a regular file, directory or symlink.",
            source.display()
        ),
    ))
}

/// `preserveTimestamps`: the copy keeps the source's access and
/// modification times, which is what makes a restored skill scan with the
/// timestamps it had before the apply. Stamping needs a writable handle, so
/// a read-only copy is made writable for that one step and then given its
/// source's permissions back — `cp`'s own `makeFileWritable` dance.
fn preserve_times(destination: &Path, source: &fs::Metadata) -> io::Result<()> {
    let mut times = fs::FileTimes::new();
    if let Ok(modified) = source.modified() {
        times = times.set_modified(modified);
    }
    if let Ok(accessed) = source.accessed() {
        times = times.set_accessed(accessed);
    }
    let original = source.permissions();
    let mut writable = original.clone();
    // Only the owner's write bit is added on Unix (`mode | 0o200`), as `cp`
    // does; on Windows this clears the read-only attribute.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        writable.set_mode(original.mode() | 0o200);
    }
    #[cfg(not(unix))]
    #[allow(clippy::permissions_set_readonly_false)]
    writable.set_readonly(false);
    let changed = writable != original;
    if changed {
        fs::set_permissions(destination, writable)?;
    }
    let stamped = OpenOptions::new()
        .write(true)
        .open(destination)
        .and_then(|file| file.set_times(times));
    if changed {
        fs::set_permissions(destination, original)?;
    }
    stamped
}

#[cfg(unix)]
fn make_symlink(target: &Path, link: &Path) -> io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(windows)]
fn make_symlink(target: &Path, link: &Path) -> io::Result<()> {
    if target.is_dir() {
        std::os::windows::fs::symlink_dir(target, link)
    } else {
        std::os::windows::fs::symlink_file(target, link)
    }
}

/// Sixteen lowercase hex characters from the OS CSPRNG —
/// `randomBytes(8).toString('hex')`.
pub(crate) fn random_suffix() -> String {
    let mut bytes = [0u8; 8];
    getrandom::fill(&mut bytes).expect("the operating system's CSPRNG must be available");
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// `writeLibraryFileAtomic`. Library file resources are often symlinked
/// into a dotfiles repository, so the write resolves the link and replaces
/// its *target*; the general `fs.write-file` writer refuses symlinks for
/// tool mutations, which is why this path has its own.
pub(crate) fn write_library_file_atomic(path: &str, contents: &[u8]) -> io::Result<()> {
    let (target, mode) = resolve_write_target(path)?;
    let parent = PathBuf::from(node_dirname(crate::health::node_platform(), &target));
    fs::create_dir_all(&parent)?;
    let temp = parent.join(format!(
        ".{}.{}.tmp",
        node_basename(&target),
        random_suffix()
    ));
    let outcome = write_temp_file(&temp, contents, mode).and_then(|()| {
        restore_mode(&temp, mode)?;
        fs::rename(&temp, &target)
    });
    if outcome.is_err() {
        let _ = fs::remove_file(&temp);
    }
    outcome
}

/// `resolveWriteTarget`: the symlink-resolved path and, when a file is
/// already there, its permission bits. A non-regular or non-writable
/// target is refused.
fn resolve_write_target(path: &str) -> io::Result<(String, Option<u32>)> {
    let resolved = resolve_through_existing_ancestor(path).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("Cannot safely resolve \"{path}\"."),
        )
    })?;
    let metadata = match fs::symlink_metadata(&resolved) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok((resolved, None)),
        Err(error) => return Err(error),
    };
    let describe = || {
        if resolved == path {
            format!("\"{path}\"")
        } else {
            format!("\"{path}\": it resolves to \"{resolved}\"")
        }
    };
    if !metadata.is_file() {
        return Err(io::Error::other(format!(
            "Cannot write {}, which is not a regular file.",
            describe()
        )));
    }
    if !is_writable(&resolved, &metadata) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("Cannot write {}, which is not writable.", describe()),
        ));
    }
    Ok((resolved, permission_bits(&metadata)))
}

#[cfg(unix)]
fn permission_bits(metadata: &fs::Metadata) -> Option<u32> {
    use std::os::unix::fs::PermissionsExt;
    Some(metadata.permissions().mode() & 0o7777)
}

#[cfg(not(unix))]
fn permission_bits(_metadata: &fs::Metadata) -> Option<u32> {
    None
}

/// `isWritable`: on POSIX a file with no write bit is refused before
/// `access(W_OK)` is asked (root would otherwise pass it); on Windows the
/// read-only attribute decides.
fn is_writable(path: &str, metadata: &fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o222 != 0
            && nix::unistd::access(path, nix::unistd::AccessFlags::W_OK).is_ok()
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        !metadata.permissions().readonly()
    }
}

fn write_temp_file(temp: &Path, contents: &[u8], mode: Option<u32>) -> io::Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    if let Some(mode) = mode {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(mode);
    }
    #[cfg(not(unix))]
    let _ = mode;
    let mut file = options.open(temp)?;
    file.write_all(contents)
}

/// `chmodSync(temp, mode)`: `open`'s mode is filtered by the umask, the
/// explicit chmod is not.
fn restore_mode(temp: &Path, mode: Option<u32>) -> io::Result<()> {
    #[cfg(unix)]
    if let Some(mode) = mode {
        use std::os::unix::fs::PermissionsExt;
        return fs::set_permissions(temp, fs::Permissions::from_mode(mode));
    }
    let _ = (temp, mode);
    Ok(())
}

/// The kind a mutation expects, hashed the way `hashResourceAt` hashes it —
/// the verification and undo seam, so a fixture can report a mismatch.
pub(crate) trait ResourceHasher: Send + Sync {
    /// The resource's content hash, or why it has none.
    fn hash_at(&self, path: &str, kind: ResourceKind) -> Result<String, super::hashing::HashError>;
}

/// The production hasher.
pub(crate) struct NativeHasher;

impl ResourceHasher for NativeHasher {
    fn hash_at(&self, path: &str, kind: ResourceKind) -> Result<String, super::hashing::HashError> {
        super::hashing::hash_resource_at(path, kind, crate::health::node_platform())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::mutation::paths::path_string;

    #[test]
    fn copy_tree_refuses_an_existing_destination_and_keeps_timestamps() {
        let scratch = crate::test_support::scratch_dir("library-copy-tree");
        let source = scratch.join("source");
        std::fs::create_dir_all(source.join("nested")).unwrap();
        std::fs::write(source.join("nested").join("a.md"), "a").unwrap();
        let old = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000);
        OpenOptions::new()
            .write(true)
            .open(source.join("nested").join("a.md"))
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(old))
            .unwrap();
        let destination = scratch.join("copy");
        NativeMutationFs
            .copy_tree(&source, &destination, CopyPurpose::Backup)
            .unwrap();
        let copied = destination.join("nested").join("a.md");
        assert_eq!(std::fs::read_to_string(&copied).unwrap(), "a");
        assert_eq!(
            std::fs::metadata(&copied).unwrap().modified().unwrap(),
            old,
            "expected the copy to keep the source mtime"
        );
        let again = NativeMutationFs.copy_tree(&source, &destination, CopyPurpose::Backup);
        assert_eq!(
            again.map_err(|error| error.kind()),
            Err(io::ErrorKind::AlreadyExists),
            "errorOnExist: a second copy onto the same path must fail"
        );
    }

    /// A read-only file (a vendored skill, a locked instruction file) must
    /// back up like any other and keep its mode: `cp` makes the copy
    /// writable only long enough to stamp its timestamps.
    #[cfg(unix)]
    #[test]
    fn copy_tree_backs_up_a_read_only_file_and_keeps_its_mode() {
        use std::os::unix::fs::PermissionsExt;
        let scratch = crate::test_support::scratch_dir("library-copy-read-only");
        let source = scratch.join("source");
        std::fs::create_dir_all(&source).unwrap();
        let locked = source.join("SKILL.md");
        std::fs::write(&locked, "locked").unwrap();
        std::fs::set_permissions(&locked, fs::Permissions::from_mode(0o444)).unwrap();
        let destination = scratch.join("copy");
        let copied = NativeMutationFs.copy_tree(&source, &destination, CopyPurpose::Backup);
        assert!(
            copied.is_ok(),
            "expected a read-only file to back up | received {copied:?}"
        );
        assert_eq!(
            std::fs::metadata(destination.join("SKILL.md"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o444
        );
    }

    #[test]
    fn remove_all_treats_a_missing_path_as_done() {
        let scratch = crate::test_support::scratch_dir("library-remove-all");
        assert!(remove_all(&scratch.join("absent")).is_ok());
        std::fs::create_dir_all(scratch.join("tree").join("x")).unwrap();
        remove_all(&scratch.join("tree")).unwrap();
        assert!(!scratch.join("tree").exists());
    }

    #[cfg(unix)]
    #[test]
    fn the_atomic_writer_writes_through_a_symlink_and_keeps_the_mode() {
        use std::os::unix::fs::PermissionsExt;
        let scratch = crate::test_support::scratch_dir("library-atomic-write");
        let target = scratch.join("dotfiles-CLAUDE.md");
        std::fs::write(&target, "old").unwrap();
        std::fs::set_permissions(&target, fs::Permissions::from_mode(0o640)).unwrap();
        let link = scratch.join("CLAUDE.md");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        write_library_file_atomic(&path_string(&link), b"new").unwrap();
        assert!(
            std::fs::symlink_metadata(&link).unwrap().is_symlink(),
            "expected the link to survive | received a regular file"
        );
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "new");
        assert_eq!(
            std::fs::metadata(&target).unwrap().permissions().mode() & 0o7777,
            0o640
        );
        std::fs::set_permissions(&target, fs::Permissions::from_mode(0o444)).unwrap();
        let refused = write_library_file_atomic(&path_string(&link), b"x").unwrap_err();
        assert!(
            refused.to_string().contains("which is not writable"),
            "received {refused}"
        );
        let leftovers: Vec<_> = std::fs::read_dir(&scratch)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "no temporary file may remain");
    }

    #[test]
    fn random_suffixes_are_sixteen_hex_characters() {
        let suffix = random_suffix();
        assert_eq!(suffix.len(), 16);
        assert!(suffix.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_ne!(suffix, random_suffix());
    }
}
