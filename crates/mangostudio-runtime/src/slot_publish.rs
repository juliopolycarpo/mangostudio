//! Publishes immutable runtime binaries and the Unix `current` pointer.
//!
//! Callers hold the slot update lock across publication, activation, and the
//! matching `runtime.json` write. A failed config write can then restore the
//! previous pointer. Windows needs junction handling and remains unsupported.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use mangostudio_runtime_contract::strings::runtime_home::CURRENT_LINK_NAME;

use crate::runtime_home::binary_name;

static NEXT_STAGE: AtomicU64 = AtomicU64::new(0);

/// Result of publishing binary bytes into an immutable version directory.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BinaryPublication {
    /// This version did not have a binary before the call.
    Published,
    /// This version already held exactly the same bytes.
    Unchanged,
}

/// Rejects a version that cannot be one safe slot path segment.
///
/// ```
/// use mangostudio_runtime::slot_publish::validate_slot_version;
/// assert!(validate_slot_version("1.2.0-canary.4").is_ok());
/// assert!(validate_slot_version("../other").is_err());
/// ```
pub fn validate_slot_version(version: &str) -> io::Result<()> {
    let bytes = version.as_bytes();
    let valid = (1..=64).contains(&bytes.len())
        && bytes[0].is_ascii_alphanumeric()
        && bytes[1..]
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'+' | b'-'));
    if valid {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "invalid slot version {version:?}: expected 1-64 ASCII letters, digits, dots, plus signs, or hyphens, starting with a letter or digit"
            ),
        ))
    }
}

/// Copies a binary into `<slot>/<version>/<binary_name>` without replacing existing bytes.
///
/// The temporary file is in the destination directory. A hard link publishes
/// it without replacement, including when another writer gets there first.
/// Callers still need the slot update lock to serialize config and pointer writes.
///
/// ```no_run
/// use std::path::Path;
/// use mangostudio_runtime::slot_publish::publish_slot_binary;
/// # fn example() -> std::io::Result<()> {
/// publish_slot_binary(Path::new("/tmp/slot"), "1.2.0", Path::new("/tmp/runtime"))?;
/// # Ok(()) }
/// ```
pub fn publish_slot_binary(
    slot_dir: &Path,
    version: &str,
    source: &Path,
) -> io::Result<BinaryPublication> {
    validate_slot_version(version)?;
    unsupported_on_windows()?;
    let version_dir = slot_dir.join(version);
    fs::create_dir_all(&version_dir)?;
    let destination = version_dir.join(binary_name());
    if destination.exists() {
        return compare_existing(source, &destination);
    }

    let stage = unique_stage_path(&version_dir, &binary_name());
    let result = (|| {
        let mut input = File::open(source)?;
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&stage)?;
        io::copy(&mut input, &mut output)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            output.set_permissions(fs::Permissions::from_mode(0o755))?;
        }
        output.flush()?;
        output.sync_all()?;
        match fs::hard_link(&stage, &destination) {
            Ok(()) => {
                File::open(&version_dir)?.sync_all()?;
                Ok(BinaryPublication::Published)
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                compare_existing(&stage, &destination)
            }
            Err(error) => Err(error),
        }
    })();
    let _ = fs::remove_file(stage);
    result
}

/// Reads the version named by `current`, or `None` when no pointer exists.
///
/// Rejects an absolute, nested, or otherwise invalid target rather than
/// using it as the rollback destination.
///
/// ```no_run
/// use std::path::Path;
/// use mangostudio_runtime::slot_publish::read_slot_current;
/// # fn example() -> std::io::Result<()> {
/// let _previous = read_slot_current(Path::new("/tmp/slot"))?;
/// # Ok(()) }
/// ```
pub fn read_slot_current(slot_dir: &Path) -> io::Result<Option<String>> {
    unsupported_on_windows()?;
    let path = slot_dir.join(CURRENT_LINK_NAME);
    let target = match fs::read_link(&path) {
        Ok(target) => target,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let Some(version) = target.to_str() else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "invalid current pointer at {}: target is not UTF-8",
                path.display()
            ),
        ));
    };
    validate_slot_version(version).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "invalid current pointer at {}: target {version:?} must be one safe version name",
                path.display()
            ),
        )
    })?;
    Ok(Some(version.to_owned()))
}

/// Atomically points `current` at a published version and returns its old target.
///
/// ```no_run
/// use std::path::Path;
/// use mangostudio_runtime::slot_publish::activate_slot_current;
/// # fn example() -> std::io::Result<()> {
/// let previous = activate_slot_current(Path::new("/tmp/slot"), "1.2.0")?;
/// # Ok(()) }
/// ```
pub fn activate_slot_current(slot_dir: &Path, version: &str) -> io::Result<Option<String>> {
    validate_slot_version(version)?;
    unsupported_on_windows()?;
    let binary = slot_dir.join(version).join(binary_name());
    if !binary.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!(
                "cannot activate slot version {version:?}: expected binary at {}",
                binary.display()
            ),
        ));
    }
    let previous = read_slot_current(slot_dir)?;
    write_pointer(slot_dir, version)?;
    Ok(previous)
}

/// Restores a previous version or removes `current` when it was absent.
///
/// ```no_run
/// use std::path::Path;
/// use mangostudio_runtime::slot_publish::restore_slot_current;
/// # fn example() -> std::io::Result<()> {
/// restore_slot_current(Path::new("/tmp/slot"), Some("1.1.0"))?;
/// # Ok(()) }
/// ```
pub fn restore_slot_current(slot_dir: &Path, previous: Option<&str>) -> io::Result<()> {
    unsupported_on_windows()?;
    match previous {
        Some(version) => {
            validate_slot_version(version)?;
            write_pointer(slot_dir, version)
        }
        None => {
            let path = slot_dir.join(CURRENT_LINK_NAME);
            match fs::symlink_metadata(&path) {
                Ok(meta) if meta.file_type().is_symlink() => {
                    fs::remove_file(path)?;
                    File::open(slot_dir)?.sync_all()
                }
                Ok(_) => Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!(
                        "cannot remove current pointer at {}: expected a symlink",
                        path.display()
                    ),
                )),
                Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
                Err(error) => Err(error),
            }
        }
    }
}

fn compare_existing(source: &Path, destination: &Path) -> io::Result<BinaryPublication> {
    let mut input = File::open(source)?;
    let mut existing = File::open(destination)?;
    let mut left = [0; 8192];
    let mut right = [0; 8192];
    loop {
        let left_count = input.read(&mut left)?;
        let right_count = existing.read(&mut right)?;
        if left_count != right_count || left[..left_count] != right[..right_count] {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                format!(
                    "version binary {} already exists with different bytes",
                    destination.display()
                ),
            ));
        }
        if left_count == 0 {
            return Ok(BinaryPublication::Unchanged);
        }
    }
}

#[cfg(unix)]
fn write_pointer(slot_dir: &Path, version: &str) -> io::Result<()> {
    use std::os::unix::fs::symlink;

    let current = slot_dir.join(CURRENT_LINK_NAME);
    match fs::symlink_metadata(&current) {
        Ok(meta) if !meta.file_type().is_symlink() => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "cannot replace current pointer at {}: expected a symlink",
                    current.display()
                ),
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let stage = unique_stage_path(slot_dir, CURRENT_LINK_NAME);
    symlink(version, &stage)?;
    let result = fs::rename(&stage, &current);
    if result.is_err() {
        let _ = fs::remove_file(stage);
    }
    result?;
    File::open(slot_dir)?.sync_all()
}

#[cfg(not(unix))]
fn write_pointer(_slot_dir: &Path, _version: &str) -> io::Result<()> {
    unsupported_on_windows()
}

fn unique_stage_path(dir: &Path, name: &str) -> PathBuf {
    let id = NEXT_STAGE.fetch_add(1, Ordering::Relaxed);
    dir.join(format!(".{name}.{}.{}", std::process::id(), id))
}

fn unsupported_on_windows() -> io::Result<()> {
    if cfg!(unix) {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "slot publication requires Unix symlink support; Windows junction publication is not implemented",
        ))
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn slot() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "mango-slot-publish-{}-{}",
            std::process::id(),
            NEXT_STAGE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn version_validation_matches_typescript() {
        for version in ["1", "1.2.0+build-4", "a".repeat(64).as_str()] {
            validate_slot_version(version).unwrap();
        }
        for version in [
            "",
            ".hidden",
            "../other",
            "one/two",
            "one\\two",
            "é",
            "a".repeat(65).as_str(),
        ] {
            let error = validate_slot_version(version).unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
            assert!(error.to_string().contains(&format!("{version:?}")));
        }
    }

    #[test]
    fn binary_is_immutable_and_pointer_can_roll_back() {
        let dir = slot();
        let source = dir.join("source");
        fs::write(&source, b"first").unwrap();
        assert_eq!(
            publish_slot_binary(&dir, "1.0.0", &source).unwrap(),
            BinaryPublication::Published
        );
        assert_eq!(
            publish_slot_binary(&dir, "1.0.0", &source).unwrap(),
            BinaryPublication::Unchanged
        );
        assert_eq!(activate_slot_current(&dir, "1.0.0").unwrap(), None);
        fs::write(&source, b"second").unwrap();
        assert_eq!(
            publish_slot_binary(&dir, "1.0.0", &source)
                .unwrap_err()
                .kind(),
            io::ErrorKind::AlreadyExists
        );
        assert_eq!(
            fs::read(dir.join("current").join(binary_name())).unwrap(),
            b"first"
        );
        publish_slot_binary(&dir, "2.0.0", &source).unwrap();
        assert_eq!(
            activate_slot_current(&dir, "2.0.0").unwrap(),
            Some("1.0.0".into())
        );
        assert_eq!(read_slot_current(&dir).unwrap(), Some("2.0.0".into()));
        restore_slot_current(&dir, Some("1.0.0")).unwrap();
        assert_eq!(
            fs::read(dir.join("current").join(binary_name())).unwrap(),
            b"first"
        );
        restore_slot_current(&dir, None).unwrap();
        assert_eq!(read_slot_current(&dir).unwrap(), None);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn refuses_external_or_directory_current_pointer() {
        use std::os::unix::fs::symlink;
        let dir = slot();
        symlink("../elsewhere", dir.join("current")).unwrap();
        assert_eq!(
            read_slot_current(&dir).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        let source = dir.join("source");
        fs::write(&source, b"binary").unwrap();
        publish_slot_binary(&dir, "1.0.0", &source).unwrap();
        assert_eq!(
            activate_slot_current(&dir, "1.0.0").unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        assert_eq!(
            fs::read_link(dir.join("current")).unwrap(),
            Path::new("../elsewhere")
        );
        restore_slot_current(&dir, Some("1.0.0")).unwrap();
        assert_eq!(read_slot_current(&dir).unwrap(), Some("1.0.0".into()));
        fs::remove_file(dir.join("current")).unwrap();
        fs::create_dir(dir.join("current")).unwrap();
        assert_eq!(
            restore_slot_current(&dir, None).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        fs::remove_dir_all(dir).unwrap();
    }
}
