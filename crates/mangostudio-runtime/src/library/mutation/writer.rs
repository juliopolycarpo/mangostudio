//! One resource write into a registry location, with its pre-write backup —
//! a port of `writeDirectoryResource` and `writeFileResource` in
//! `apps/shared/src/library/machine/resource-writer.ts`.
//!
//! A directory is staged in full beside the destination and swapped in by
//! rename, so a failure while staging leaves the original and a failed swap
//! renames the original back. A file goes through the symlink-following
//! atomic writer. Either way, whatever was at the destination is copied into
//! the backup set before anything replaces it.

use std::path::Path;
use std::sync::Arc;

use super::backup_store::{BackupStore, StoreError};
use super::disk::{CopyPurpose, MutationFs};
use super::paths::{
    ResourceKind, WriteError, WriteFailure, assert_expected_resource_entry, fs_path, node_basename,
    node_dirname, node_join, require_writable_location, resolve_resource_destination,
};
use crate::probing::detection::path_env::PathEnv;

/// Where a directory resource's bytes come from: a directory on this host
/// (a same-machine apply) or a tree that travelled in the frame.
#[derive(Debug, Clone)]
pub(crate) enum DirectorySource {
    Path(String),
    Files(Vec<TransferredFile>),
}

/// One file of a transferred directory resource.
#[derive(Debug, Clone)]
pub(crate) struct TransferredFile {
    /// Posix-separated, relative to the resource root.
    pub relative_path: String,
    /// Shared with every other operation carrying the same payload.
    pub contents: Arc<Vec<u8>>,
}

/// `ResourceWriteResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WriteResult {
    pub destination_path: String,
    pub resolved_destination_path: String,
    pub backup_path: Option<String>,
}

/// Why one resource write failed: a policy refusal (`LibraryWriteError`,
/// a `guard-rejected` row) or anything else (a `write-failed` row).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum WriterError {
    Policy(WriteError),
    Failed(String),
}

impl From<WriteError> for WriterError {
    fn from(error: WriteError) -> Self {
        Self::Policy(error)
    }
}

impl From<StoreError> for WriterError {
    fn from(error: StoreError) -> Self {
        Self::Failed(error.to_string())
    }
}

fn failed(error: std::io::Error) -> WriterError {
    WriterError::Failed(error.to_string())
}

/// The inputs every resource write shares.
pub(crate) struct WriteTarget<'a> {
    pub location_id: &'a str,
    pub slug: &'a str,
    pub env: &'a PathEnv,
    pub backup_id: &'a str,
}

/// `writeDirectoryResource`.
///
/// # Example
///
/// ```ignore
/// let written = write_directory(&target, &DirectorySource::Path("/src/gh".into()), &store)?;
/// ```
pub(crate) fn write_directory(
    target: &WriteTarget<'_>,
    source: &DirectorySource,
    store: &BackupStore,
) -> Result<WriteResult, WriterError> {
    let location = require_writable_location(target.location_id, ResourceKind::Directory)?;
    let destination = resolve_resource_destination(location, target.slug, target.env)?;
    let resolved = destination.resolved_path.as_str();
    assert_expected_resource_entry(resolved, ResourceKind::Directory)?;
    if let DirectorySource::Path(source_dir) = source {
        assert_source_directory(source_dir)?;
    }
    store.set_path(target.backup_id)?;

    let fs = store.fs.as_ref();
    let platform = &store.platform;
    fs.create_dir_all(&fs_path(&node_dirname(platform, resolved)))
        .map_err(failed)?;
    let existing = fs.exists(&fs_path(resolved)).map_err(failed)?;
    let backup_path = existing
        .then(|| backup_resource(resolved, target, store))
        .transpose()?;

    let suffix = (store.random_suffix)();
    let stage = sibling(platform, resolved, &suffix, "staging");
    let previous = sibling(platform, resolved, &suffix, "previous");
    let staged = stage_source(fs, source, &stage).and_then(|()| {
        assert_expected_resource_entry(resolved, ResourceKind::Directory)?;
        swap_staged_directory(fs, &stage, resolved, &previous, existing)
    });
    if let Err(error) = staged {
        let _ = fs.remove_all(&fs_path(&stage));
        return Err(error);
    }
    Ok(WriteResult {
        destination_path: destination.logical_path,
        resolved_destination_path: destination.resolved_path,
        backup_path,
    })
}

/// `writeFileResource`: the commit goes through the symlink-resolving
/// atomic writer with the *logical* path, so the writer re-resolves and
/// re-validates the real target itself.
pub(crate) fn write_file(
    target: &WriteTarget<'_>,
    contents: &[u8],
    store: &BackupStore,
) -> Result<WriteResult, WriterError> {
    let location = require_writable_location(target.location_id, ResourceKind::File)?;
    let destination = resolve_resource_destination(location, target.slug, target.env)?;
    let resolved = destination.resolved_path.as_str();
    assert_expected_resource_entry(resolved, ResourceKind::File)?;
    store.set_path(target.backup_id)?;

    let fs = store.fs.as_ref();
    fs.create_dir_all(&fs_path(&node_dirname(&store.platform, resolved)))
        .map_err(failed)?;
    let existing = fs.exists(&fs_path(resolved)).map_err(failed)?;
    let backup_path = existing
        .then(|| backup_resource(resolved, target, store))
        .transpose()?;
    fs.write_file_atomic(&destination.logical_path, contents)
        .map_err(failed)?;
    Ok(WriteResult {
        destination_path: destination.logical_path,
        resolved_destination_path: destination.resolved_path,
        backup_path,
    })
}

/// `backupResource`: copy aside, then trim the store, keeping this set.
fn backup_resource(
    resolved: &str,
    target: &WriteTarget<'_>,
    store: &BackupStore,
) -> Result<String, WriterError> {
    let backup_path =
        store.backup_existing(resolved, target.location_id, target.slug, target.backup_id)?;
    store.prune(Some(target.backup_id))?;
    Ok(backup_path)
}

fn sibling(platform: &str, path: &str, suffix: &str, kind: &str) -> String {
    node_join(
        platform,
        &[
            &node_dirname(platform, path),
            &format!(".{}.{suffix}.{kind}", node_basename(path)),
        ],
    )
}

fn assert_source_directory(source_dir: &str) -> Result<(), WriterError> {
    match std::fs::metadata(source_dir) {
        Ok(metadata) if metadata.is_dir() => Ok(()),
        Ok(_) => Err(WriteError::new(
            WriteFailure::InvalidSource,
            format!("Library resource source \"{source_dir}\" is not a directory."),
        )
        .into()),
        Err(error) => Err(WriteError::new(
            WriteFailure::InvalidSource,
            format!("Cannot read library resource source \"{source_dir}\": {error}"),
        )
        .into()),
    }
}

fn stage_source(
    fs: &dyn MutationFs,
    source: &DirectorySource,
    stage: &str,
) -> Result<(), WriterError> {
    match source {
        DirectorySource::Path(source_dir) => fs
            .copy_tree(&fs_path(source_dir), &fs_path(stage), CopyPurpose::Stage)
            .map_err(failed),
        DirectorySource::Files(files) => stage_files(fs, stage, files),
    }
}

/// `stageFiles`: every transferred relative path is validated before it
/// becomes a path, and refused rather than sanitized — a name that had to
/// be rewritten is not the tree that was reviewed.
fn stage_files(
    fs: &dyn MutationFs,
    stage: &str,
    files: &[TransferredFile],
) -> Result<(), WriterError> {
    fs.create_dir_all(&fs_path(stage)).map_err(failed)?;
    for file in files {
        let relative = file.relative_path.as_str();
        let escapes = relative.is_empty()
            || relative.contains('\\')
            || relative
                .split('/')
                .any(|segment| !is_single_normal_segment(segment));
        if escapes {
            return Err(WriteError::new(
                WriteFailure::PathEscape,
                format!(
                    "Transferred library file \"{relative}\" is not a contained relative path."
                ),
            )
            .into());
        }
        let target = relative
            .split('/')
            .fold(fs_path(stage), |path, segment| path.join(segment));
        if let Some(parent) = target.parent() {
            fs.create_dir_all(parent).map_err(failed)?;
        }
        fs.write_file_atomic(&target.to_string_lossy(), &file.contents)
            .map_err(failed)?;
    }
    Ok(())
}

/// `swapStagedDirectory`: a failed swap renames the original back; a
/// failed cleanup of the previous tree leaves a recoverable stale sibling,
/// never partial content.
fn swap_staged_directory(
    fs: &dyn MutationFs,
    stage: &str,
    destination: &str,
    previous: &str,
    existing: bool,
) -> Result<(), WriterError> {
    let (stage, destination, previous) = (
        Path::new(stage),
        Path::new(destination),
        Path::new(previous),
    );
    if !existing {
        return fs.rename(stage, destination).map_err(failed);
    }
    fs.rename(destination, previous).map_err(failed)?;
    if let Err(write_error) = fs.rename(stage, destination) {
        if let Err(rollback_error) = fs.rename(previous, destination) {
            return Err(WriterError::Failed(format!(
                "Library write failed and \"{}\" could not be restored: {write_error}; {rollback_error}",
                destination.display()
            )));
        }
        return Err(failed(write_error));
    }
    let _ = fs.remove_all(previous);
    Ok(())
}

/// Whether `segment` is exactly one plain path component on this platform.
///
/// Rejects empty, `.` and `..` segments, and on Windows a drive-relative
/// prefix such as `C:evil`, which `PathBuf::join` would treat as a new base
/// and so escape the stage.
///
/// ```ignore
/// assert!(is_single_normal_segment("notes.md"));
/// assert!(!is_single_normal_segment(".."));
/// ```
fn is_single_normal_segment(segment: &str) -> bool {
    let mut components = Path::new(segment).components();
    matches!(
        (components.next(), components.next()),
        (Some(std::path::Component::Normal(_)), None)
    )
}

#[cfg(test)]
mod segment_tests {
    use super::is_single_normal_segment;

    #[test]
    fn single_normal_segment_rejects_empty_dot_and_parent() {
        for segment in ["", ".", ".."] {
            assert!(
                !is_single_normal_segment(segment),
                "expected segment {segment:?} to be rejected as not one plain component"
            );
        }
        assert!(is_single_normal_segment("notes.md"));
    }

    #[cfg(windows)]
    #[test]
    fn single_normal_segment_rejects_a_drive_relative_prefix() {
        assert!(
            !is_single_normal_segment("C:evil"),
            "expected a drive-relative segment to be rejected; it would replace the stage path"
        );
    }
}

/// What a process killed mid-swap leaves behind, and why the next run is
/// unaffected by it.
#[cfg(test)]
mod crash_leftover_tests {
    use std::path::Path;

    use tokio_util::sync::CancellationToken;

    use super::DirectorySource;
    use crate::library::cache::LibraryCache;
    use crate::library::fs::NativeLibraryFs;
    use crate::library::mutation::apply::{ApplyContext, ApplyOperation, execute_apply};
    use crate::library::mutation::fakes::Home;
    use crate::library::mutation::paths::ResourceKind;
    use crate::library::reader::{ScanContext, read_location_instances};
    use crate::probing::locations::location_by_id;

    /// The file names the `claude-skills` location lists as instances, and
    /// how many entries it reports as unreadable.
    fn scanned_names(skills: &Path) -> (Vec<String>, usize) {
        let cache = LibraryCache::default();
        let cancel = CancellationToken::new();
        let warn = |_: &str| {};
        let context = ScanContext {
            cache: &cache,
            force: true,
            fs: &NativeLibraryFs,
            platform: crate::health::node_platform(),
            cancel: &cancel,
            warn: &warn,
        };
        let location = location_by_id("claude-skills").unwrap();
        let scanned =
            read_location_instances(location, &skills.to_string_lossy(), &context).unwrap();
        let mut names: Vec<String> = scanned
            .entries
            .iter()
            .map(|entry| {
                Path::new(&entry.instance.path)
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        names.sort();
        (names, scanned.unreadable_entries.len())
    }

    /// A process killed between staging and swapping leaves
    /// `.<slug>.<suffix>.staging` and `.<slug>.<suffix>.previous` siblings,
    /// each looking like a whole skill. The next scan does not list them as
    /// resources, and the next apply of the same slug writes the real
    /// destination without tripping over them.
    #[test]
    fn crash_leftover_staging_and_previous_siblings_are_ignored_on_the_next_run() {
        let home = Home::new("writer-crash-leftovers");
        let skills = home.path(&[".claude", "skills"]);
        home.skill(&skills.join(".gh.deadbeefdeadbeef.staging"), "half-staged");
        home.skill(&skills.join(".gh.deadbeefdeadbeef.previous"), "swapped-out");

        let before = scanned_names(&skills);
        assert_eq!(
            before,
            (Vec::<String>::new(), 0),
            "expected crash leftovers neither listed nor reported unreadable | \
             received (instances, unreadable): {before:?}"
        );

        let source = home.skill(&home.scratch.join("source"), "fresh");
        let hash = home.hash(&source, ResourceKind::Directory);
        let never = || None;
        let result = execute_apply(
            &[ApplyOperation {
                resource_key: "skill:gh".into(),
                location_id: "claude-skills".into(),
                slug: "gh".into(),
                operation: "create".into(),
                kind: ResourceKind::Directory,
                expected_content_hash: hash,
                destination_root: skills.to_string_lossy().into_owned(),
                directory: Some(DirectorySource::Path(source.to_string_lossy().into_owned())),
                contents: None,
                adaptation: None,
            }],
            &ApplyContext {
                store: &home.store,
                hasher: home.hasher.as_ref(),
                env: &home.env,
                environment_id: None,
                backup_id: None,
                interrupted: &never,
            },
        );
        assert!(
            result.failed.is_empty(),
            "expected the next apply to succeed beside the leftovers | received: {:?}",
            result.failed
        );
        let written = std::fs::read_to_string(skills.join("gh").join("SKILL.md")).unwrap();
        assert!(
            written.contains("fresh"),
            "expected the real destination to hold the new skill | received: {written:?}"
        );
        let after = scanned_names(&skills);
        assert_eq!(
            after,
            (vec!["gh".to_owned()], 0),
            "expected only the real skill listed after the next run | \
             received (instances, unreadable): {after:?}"
        );
    }
}
