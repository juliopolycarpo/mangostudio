//! Publishes immutable runtime binaries and the stable slot launcher.
//!
//! Callers hold the slot update lock across publication, activation, and the
//! matching `runtime.json` write. A failed config write can then restore the
//! previous pointer. Unix uses `current`; Windows uses an atomic `.cmd` shim.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use mangostudio_runtime_contract::strings::runtime_home::CURRENT_LINK_NAME;

#[cfg(windows)]
use crate::runtime_home::atomic::{RenameRetryPolicy, StdRename, rename_with_retry};
use crate::runtime_home::binary_name;

const WINDOWS_SHIM_NAME: &str = "mangostudio-runtime.cmd";

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
    fs::create_dir_all(slot_dir)?;
    let version_dir = slot_dir.join(version);
    match fs::create_dir(&version_dir) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error),
    }
    require_directory(&version_dir)?;
    let destination = version_dir.join(binary_name());
    match fs::symlink_metadata(&destination) {
        Ok(meta) if meta.file_type().is_file() => return compare_existing(source, &destination),
        Ok(_) => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "version binary {} must be a regular file",
                    destination.display()
                ),
            ));
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
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
        #[cfg(windows)]
        let link = retry_windows_sharing(|| fs::hard_link(&stage, &destination));
        #[cfg(unix)]
        let link = fs::hard_link(&stage, &destination);
        match link {
            Ok(()) => {
                #[cfg(unix)]
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

/// Reads the version named by `current` on Unix or the root `.cmd` shim on Windows.
///
/// Returns `None` when no launcher exists. Rejects an absolute, nested,
/// missing, or otherwise invalid Windows shim target before rollback.
///
/// ```no_run
/// use std::path::Path;
/// use mangostudio_runtime::slot_publish::read_slot_current;
/// # fn example() -> std::io::Result<()> {
/// let _previous = read_slot_current(Path::new("/tmp/slot"))?;
/// # Ok(()) }
/// ```
pub fn read_slot_current(slot_dir: &Path) -> io::Result<Option<String>> {
    #[cfg(windows)]
    return read_windows_shim(slot_dir);

    #[cfg(unix)]
    {
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
}

#[cfg(windows)]
fn windows_shim_body(version: &str) -> Vec<u8> {
    format!("@echo off\r\n\"%~dp0{version}\\{}\" %*\r\n", binary_name()).into_bytes()
}

#[cfg(windows)]
fn read_windows_shim(slot_dir: &Path) -> io::Result<Option<String>> {
    retry_windows_sharing(|| read_windows_shim_once(slot_dir))
}

#[cfg(windows)]
fn read_windows_shim_once(slot_dir: &Path) -> io::Result<Option<String>> {
    let path = slot_dir.join(WINDOWS_SHIM_NAME);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    if !metadata.file_type().is_file() || metadata.len() > 256 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "invalid current shim at {}: expected a regular generated .cmd file of at most 256 bytes",
                path.display()
            ),
        ));
    }
    let body = fs::read(&path)?;
    let prefix = b"@echo off\r\n\"%~dp0";
    let suffix = format!("\\{}\" %*\r\n", binary_name());
    let suffix = suffix.as_bytes();
    let Some(raw_version) = body
        .strip_prefix(prefix)
        .and_then(|rest| rest.strip_suffix(suffix))
    else {
        return Err(invalid_windows_shim(
            &path,
            "expected the generated slot-relative launcher format",
        ));
    };
    let version = std::str::from_utf8(raw_version)
        .map_err(|_| invalid_windows_shim(&path, "version is not UTF-8"))?;
    validate_slot_version(version).map_err(|_| {
        invalid_windows_shim(
            &path,
            &format!("version {version:?} is not one safe path segment"),
        )
    })?;
    let version_dir = slot_dir.join(version);
    require_directory(&version_dir).map_err(|error| {
        invalid_windows_shim(
            &path,
            &format!("target version {version:?} is missing or unsafe: {error}"),
        )
    })?;
    let binary = version_dir.join(binary_name());
    match fs::symlink_metadata(&binary) {
        Ok(meta) if meta.file_type().is_file() => Ok(Some(version.to_owned())),
        Ok(_) => Err(invalid_windows_shim(
            &path,
            &format!("target {} is not a regular file", binary.display()),
        )),
        Err(error) => Err(invalid_windows_shim(
            &path,
            &format!("target {} is unavailable: {error}", binary.display()),
        )),
    }
}

#[cfg(windows)]
fn invalid_windows_shim(path: &Path, reason: &str) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        format!("invalid current shim at {}: {reason}", path.display()),
    )
}

/// Atomically points the slot launcher at a published version and returns its old target.
///
/// ```no_run
/// use std::path::Path;
/// use mangostudio_runtime::slot_publish::activate_slot_current;
/// # fn example() -> std::io::Result<()> {
/// let previous = activate_slot_current(Path::new("/tmp/slot"), "1.2.0")?;
/// # Ok(()) }
/// ```
pub fn activate_slot_current(slot_dir: &Path, version: &str) -> io::Result<Option<String>> {
    activate_slot_current_with_sync(slot_dir, version, sync_slot_dir)
}

fn activate_slot_current_with_sync(
    slot_dir: &Path,
    version: &str,
    sync: impl FnOnce(&Path) -> io::Result<()>,
) -> io::Result<Option<String>> {
    validate_slot_version(version)?;
    let version_dir = slot_dir.join(version);
    require_directory(&version_dir)?;
    let binary = version_dir.join(binary_name());
    if !fs::symlink_metadata(&binary)?.file_type().is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "cannot activate slot version {version:?}: expected regular binary at {}",
                binary.display()
            ),
        ));
    }
    let previous = read_slot_current(slot_dir)?;
    if let Err(error) = write_pointer_with_sync(slot_dir, version, sync) {
        if let Err(restore_error) = restore_slot_current(slot_dir, previous.as_deref()) {
            return Err(io::Error::other(format!(
                "could not activate {version:?} ({error}) or restore previous current pointer ({restore_error}); inspect {}",
                slot_dir.display()
            )));
        }
        return Err(io::Error::other(format!(
            "could not activate {version:?} ({error}); restored previous current pointer"
        )));
    }
    Ok(previous)
}

fn require_directory(path: &Path) -> io::Result<()> {
    if fs::symlink_metadata(path)?.file_type().is_dir() {
        return Ok(());
    }
    Err(io::Error::new(
        io::ErrorKind::InvalidData,
        format!(
            "version directory {} must be a real directory",
            path.display()
        ),
    ))
}

/// Restores a previous version or removes the slot launcher when it was absent.
///
/// ```no_run
/// use std::path::Path;
/// use mangostudio_runtime::slot_publish::restore_slot_current;
/// # fn example() -> std::io::Result<()> {
/// restore_slot_current(Path::new("/tmp/slot"), Some("1.1.0"))?;
/// # Ok(()) }
/// ```
pub fn restore_slot_current(slot_dir: &Path, previous: Option<&str>) -> io::Result<()> {
    match previous {
        Some(version) => {
            validate_slot_version(version)?;
            write_pointer(slot_dir, version)
        }
        None => {
            #[cfg(windows)]
            {
                let path = slot_dir.join(WINDOWS_SHIM_NAME);
                if read_windows_shim(slot_dir)?.is_some() {
                    fs::remove_file(path)?;
                }
                Ok(())
            }
            #[cfg(unix)]
            {
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
}

/// Keeps the active and previous immutable versions, removing older versions and abandoned stages.
///
/// Call while holding the slot update lock, after the pointer and config both commit. Individual
/// deletion failures are harmless: the next publication tries again.
///
/// ```no_run
/// use std::path::Path;
/// use mangostudio_runtime::slot_publish::prune_slot_versions;
/// # fn example() -> std::io::Result<()> {
/// prune_slot_versions(Path::new("/tmp/slot"), "1.2.0", Some("1.1.0"))?;
/// # Ok(()) }
/// ```
pub fn prune_slot_versions(
    slot_dir: &Path,
    current: &str,
    previous: Option<&str>,
) -> io::Result<()> {
    validate_slot_version(current)?;
    if let Some(previous) = previous {
        validate_slot_version(previous)?;
    }
    sweep_abandoned_stages(slot_dir)?;
    for entry in fs::read_dir(slot_dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let path = entry.path();
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.file_type().is_symlink() {
            if is_abandoned_stage(name, &meta) {
                let _ = fs::remove_file(path);
            }
            continue;
        }
        if is_abandoned_stage(name, &meta) {
            let _ = fs::remove_file(path);
            continue;
        }
        if meta.file_type().is_dir()
            && name != current
            && Some(name) != previous
            && validate_slot_version(name).is_ok()
        {
            let _ = fs::remove_dir_all(path);
        }
    }
    Ok(())
}

/// Clears stages left by a killed writer after acquiring the exclusive slot lock.
///
/// ```no_run
/// use std::path::Path;
/// use mangostudio_runtime::slot_publish::sweep_abandoned_stages;
/// # fn example() -> std::io::Result<()> {
/// sweep_abandoned_stages(Path::new("/tmp/slot"))?;
/// # Ok(()) }
/// ```
pub fn sweep_abandoned_stages(slot_dir: &Path) -> io::Result<()> {
    for entry in fs::read_dir(slot_dir)? {
        let entry = entry?;
        let path = entry.path();
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if is_abandoned_stage(name, &meta) {
            let _ = fs::remove_file(path);
        } else if meta.file_type().is_dir() && validate_slot_version(name).is_ok() {
            sweep_version_stages(&path);
        }
    }
    Ok(())
}

fn sweep_version_stages(version_dir: &Path) {
    let Ok(entries) = fs::read_dir(version_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.file_type().is_file()
            && entry
                .file_name()
                .to_str()
                .is_some_and(is_abandoned_binary_stage)
        {
            let _ = fs::remove_file(path);
        }
    }
}

fn is_abandoned_binary_stage(name: &str) -> bool {
    if name == format!("{}.incoming", binary_name()) {
        return true;
    }
    let Some(suffix) = name.strip_prefix(&format!(".{}.", binary_name())) else {
        return false;
    };
    let Some((pid, sequence)) = suffix.split_once('.') else {
        return false;
    };
    !pid.is_empty()
        && !sequence.is_empty()
        && pid.bytes().all(|byte| byte.is_ascii_digit())
        && sequence.bytes().all(|byte| byte.is_ascii_digit())
}

fn is_abandoned_stage(name: &str, meta: &fs::Metadata) -> bool {
    (meta.file_type().is_symlink() && name.starts_with(&format!(".{CURRENT_LINK_NAME}.")))
        || (cfg!(windows) && meta.file_type().is_file() && is_windows_shim_stage(name))
        || (meta.file_type().is_file() && name.starts_with(".mangostudio-runtime.incoming-"))
}

fn is_windows_shim_stage(name: &str) -> bool {
    let Some(suffix) = name.strip_prefix(&format!(".{WINDOWS_SHIM_NAME}.")) else {
        return false;
    };
    let Some((pid, sequence)) = suffix.split_once('.') else {
        return false;
    };
    !pid.is_empty()
        && !sequence.is_empty()
        && pid.bytes().all(|byte| byte.is_ascii_digit())
        && sequence.bytes().all(|byte| byte.is_ascii_digit())
}

fn compare_existing(source: &Path, destination: &Path) -> io::Result<BinaryPublication> {
    if !fs::symlink_metadata(destination)?.file_type().is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "version binary {} must be a regular file",
                destination.display()
            ),
        ));
    }
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
    write_pointer_with_sync(slot_dir, version, sync_slot_dir)
}

#[cfg(unix)]
fn sync_slot_dir(slot_dir: &Path) -> io::Result<()> {
    File::open(slot_dir)?.sync_all()
}

#[cfg(windows)]
fn sync_slot_dir(_slot_dir: &Path) -> io::Result<()> {
    // Windows does not allow opening directories as ordinary files for sync_all.
    Ok(())
}

#[cfg(unix)]
fn write_pointer_with_sync(
    slot_dir: &Path,
    version: &str,
    sync: impl FnOnce(&Path) -> io::Result<()>,
) -> io::Result<()> {
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
    sync(slot_dir)
}

#[cfg(windows)]
fn write_pointer(slot_dir: &Path, version: &str) -> io::Result<()> {
    write_pointer_with_sync(slot_dir, version, sync_slot_dir)
}

#[cfg(windows)]
fn write_pointer_with_sync(
    slot_dir: &Path,
    version: &str,
    sync: impl FnOnce(&Path) -> io::Result<()>,
) -> io::Result<()> {
    let current = slot_dir.join(WINDOWS_SHIM_NAME);
    match fs::symlink_metadata(&current) {
        Ok(meta) if !meta.file_type().is_file() => {
            return Err(invalid_windows_shim(
                &current,
                "expected a regular .cmd file before replacement",
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let stage = unique_stage_path(slot_dir, WINDOWS_SHIM_NAME);
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&stage)?;
        file.write_all(&windows_shim_body(version))?;
        file.flush()?;
        file.sync_all()?;
        drop(file);
        rename_with_retry(&StdRename, &stage, &current, &RenameRetryPolicy::default())?;
        sync(slot_dir)
    })();
    if result.is_err() {
        let _ = fs::remove_file(stage);
    }
    result
}

fn unique_stage_path(dir: &Path, name: &str) -> PathBuf {
    let id = NEXT_STAGE.fetch_add(1, Ordering::Relaxed);
    dir.join(format!(".{name}.{}.{}", std::process::id(), id))
}

#[cfg(windows)]
fn retry_windows_sharing<T>(mut operation: impl FnMut() -> io::Result<T>) -> io::Result<T> {
    let policy = RenameRetryPolicy::default();
    for attempt in 1..=policy.attempts {
        match operation() {
            Ok(value) => return Ok(value),
            Err(error) if attempt < policy.attempts && error.raw_os_error() == Some(32) => {
                std::thread::sleep(policy.backoff);
            }
            Err(error) => return Err(error),
        }
    }
    unreachable!("the final attempt returns")
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
    fn activation_restores_previous_pointer_if_sync_fails_after_rename() {
        let dir = slot();
        let source = dir.join("source");
        fs::write(&source, b"runtime").unwrap();
        publish_slot_binary(&dir, "1.0.0", &source).unwrap();
        publish_slot_binary(&dir, "2.0.0", &source).unwrap();
        activate_slot_current(&dir, "1.0.0").unwrap();

        let error = activate_slot_current_with_sync(&dir, "2.0.0", |_| {
            Err(io::Error::other("injected directory sync failure"))
        })
        .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("injected directory sync failure")
        );
        assert!(
            error
                .to_string()
                .contains("restored previous current pointer")
        );
        assert_eq!(read_slot_current(&dir).unwrap().as_deref(), Some("1.0.0"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn pruning_keeps_current_and_previous_and_sweeps_abandoned_stages() {
        let dir = slot();
        let source = dir.join("source");
        fs::write(&source, b"runtime").unwrap();
        for version in ["1.0.0", "2.0.0", "3.0.0"] {
            publish_slot_binary(&dir, version, &source).unwrap();
        }
        activate_slot_current(&dir, "3.0.0").unwrap();
        std::os::unix::fs::symlink("1.0.0", dir.join(".current.abandoned")).unwrap();
        fs::write(
            dir.join(".mangostudio-runtime.incoming-abandoned"),
            b"partial",
        )
        .unwrap();
        fs::write(dir.join("3.0.0/.mangostudio-runtime.42.7"), b"partial").unwrap();
        fs::write(dir.join("2.0.0/mangostudio-runtime.incoming"), b"partial").unwrap();
        fs::write(dir.join("runtime.json"), b"{}").unwrap();

        prune_slot_versions(&dir, "3.0.0", Some("2.0.0")).unwrap();

        assert!(!dir.join("1.0.0").exists());
        assert!(dir.join("2.0.0").exists());
        assert!(dir.join("3.0.0").exists());
        assert!(!dir.join(".current.abandoned").exists());
        assert!(!dir.join(".mangostudio-runtime.incoming-abandoned").exists());
        assert!(!dir.join("3.0.0/.mangostudio-runtime.42.7").exists());
        assert!(!dir.join("2.0.0/mangostudio-runtime.incoming").exists());
        assert!(dir.join("runtime.json").exists());
        assert_eq!(read_slot_current(&dir).unwrap().as_deref(), Some("3.0.0"));
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

    #[test]
    fn publication_refuses_symlinked_version_directory_and_binary() {
        use std::os::unix::fs::symlink;

        let dir = slot();
        let outside = slot();
        let source = dir.join("source");
        fs::write(&source, b"binary").unwrap();
        symlink(&outside, dir.join("1.0.0")).unwrap();
        assert_eq!(
            publish_slot_binary(&dir, "1.0.0", &source)
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidData
        );
        assert_eq!(
            activate_slot_current(&dir, "1.0.0").unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        assert!(!outside.join(binary_name()).exists());

        fs::remove_file(dir.join("1.0.0")).unwrap();
        fs::create_dir(dir.join("1.0.0")).unwrap();
        symlink(&source, dir.join("1.0.0").join(binary_name())).unwrap();
        assert_eq!(
            publish_slot_binary(&dir, "1.0.0", &source)
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidData
        );
        assert_eq!(
            activate_slot_current(&dir, "1.0.0").unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        fs::remove_dir_all(dir).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;
    use std::os::windows::fs::OpenOptionsExt;

    fn slot() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "mango-windows-slot-{}-{}",
            std::process::id(),
            NEXT_STAGE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn publishes_immutable_binary_and_activates_a_stable_shim() {
        let dir = slot();
        let source = dir.join("source.exe");
        fs::write(&source, b"first").unwrap();
        assert_eq!(
            publish_slot_binary(&dir, "1.0.0", &source).unwrap(),
            BinaryPublication::Published
        );
        assert_eq!(activate_slot_current(&dir, "1.0.0").unwrap(), None);
        assert_eq!(read_slot_current(&dir).unwrap().as_deref(), Some("1.0.0"));
        assert!(dir.join("mangostudio-runtime.cmd").is_file());
        fs::write(&source, b"second").unwrap();
        assert_eq!(
            publish_slot_binary(&dir, "1.0.0", &source)
                .unwrap_err()
                .kind(),
            io::ErrorKind::AlreadyExists
        );
        publish_slot_binary(&dir, "2.0.0", &source).unwrap();
        assert_eq!(
            activate_slot_current(&dir, "2.0.0").unwrap().as_deref(),
            Some("1.0.0")
        );
        restore_slot_current(&dir, Some("1.0.0")).unwrap();
        assert_eq!(read_slot_current(&dir).unwrap().as_deref(), Some("1.0.0"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rejects_corrupt_or_stale_shim_without_following_it() {
        let dir = slot();
        let shim = dir.join(WINDOWS_SHIM_NAME);
        fs::write(&shim, b"@echo off\r\n\"C:\\elsewhere\\runtime.exe\" %*\r\n").unwrap();
        let error = read_slot_current(&dir).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert!(
            error
                .to_string()
                .contains("generated slot-relative launcher")
        );

        fs::write(&shim, windows_shim_body("../elsewhere")).unwrap();
        assert_eq!(
            read_slot_current(&dir).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );

        fs::write(&shim, windows_shim_body("1.0.0")).unwrap();
        let error = read_slot_current(&dir).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert!(error.to_string().contains("target version"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn activation_failure_restores_previous_shim_and_prune_keeps_previous_binary() {
        let dir = slot();
        let source = dir.join("source.exe");
        fs::write(&source, b"binary").unwrap();
        for version in ["1.0.0", "2.0.0", "3.0.0"] {
            publish_slot_binary(&dir, version, &source).unwrap();
        }
        activate_slot_current(&dir, "1.0.0").unwrap();
        let error = activate_slot_current_with_sync(&dir, "2.0.0", |_| {
            Err(io::Error::other("injected sync failure"))
        })
        .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("restored previous current pointer")
        );
        assert_eq!(read_slot_current(&dir).unwrap().as_deref(), Some("1.0.0"));

        activate_slot_current(&dir, "3.0.0").unwrap();
        fs::write(dir.join(".mangostudio-runtime.cmd.42.7"), b"incomplete").unwrap();
        prune_slot_versions(&dir, "3.0.0", Some("2.0.0")).unwrap();
        assert!(!dir.join("1.0.0").exists());
        assert!(dir.join("2.0.0").is_dir());
        assert!(dir.join("3.0.0").is_dir());
        assert!(!dir.join(".mangostudio-runtime.cmd.42.7").exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn sharing_retry_is_bounded_and_only_retries_sharing_violations() {
        let mut calls = 0;
        let result = retry_windows_sharing(|| {
            calls += 1;
            if calls < 3 {
                Err(io::Error::from_raw_os_error(32))
            } else {
                Ok(7)
            }
        });
        assert_eq!(result.unwrap(), 7);
        assert_eq!(calls, 3);

        let mut calls = 0;
        let error = retry_windows_sharing(|| {
            calls += 1;
            Err::<(), _>(io::Error::from_raw_os_error(5))
        })
        .unwrap_err();
        assert_eq!(error.raw_os_error(), Some(5));
        assert_eq!(calls, 1);
    }

    #[test]
    fn activation_waits_for_a_transient_shim_file_lock() {
        let dir = slot();
        let source = dir.join("source.exe");
        fs::write(&source, b"binary").unwrap();
        for version in ["1.0.0", "2.0.0"] {
            publish_slot_binary(&dir, version, &source).unwrap();
        }
        activate_slot_current(&dir, "1.0.0").unwrap();

        let shim = dir.join(WINDOWS_SHIM_NAME);
        let locked_shim = OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&shim)
            .unwrap();
        let release = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(35));
            drop(locked_shim);
        });
        assert_eq!(
            activate_slot_current(&dir, "2.0.0").unwrap().as_deref(),
            Some("1.0.0")
        );
        release.join().unwrap();
        assert_eq!(read_slot_current(&dir).unwrap().as_deref(), Some("2.0.0"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn stage_sweep_recognizes_only_generated_shim_names() {
        assert!(is_windows_shim_stage(".mangostudio-runtime.cmd.42.7"));
        assert!(!is_windows_shim_stage(".mangostudio-runtime.cmd.backup"));
        assert!(!is_windows_shim_stage(".mangostudio-runtime.cmd.42.other"));
    }
}
