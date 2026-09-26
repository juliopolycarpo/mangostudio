//! One location's scan and the bounded directory walk behind it — a port of
//! `readLocationInstances`, `readOneEntry`, `collectLeafFiles` and the hash
//! passes in `apps/shared/src/library/machine/instance-reader.ts`.
//!
//! Every outcome the TypeScript reader reports is reported the same way:
//! a nameable entry that cannot be hashed becomes an invalid instance with a
//! stable `invalidReason` (never a dropped row), an unnameable one becomes an
//! `unreadableEntries` row, and only an absent path contributes nothing. The
//! one silent case is inherited unchanged: a location directory that exists
//! but cannot be listed contributes no rows and a diagnostic line, because
//! the contract has no location-level slot to carry it (see `mod.rs`).

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use tokio_util::sync::CancellationToken;

use super::cache::{CachedInstanceHash, Display, LibraryCache};
use super::collation::locale_compare;
use super::describe::describe_instance;
use super::fs::{FileMeta, LibraryFs, ReadFailure, join_relative};
use super::hash::{
    DirectoryManifest, ManifestViolation, combine_whitespace_digests, hash_file_bytes,
    relative_path_violation, whitespace_digest,
};
use super::js::text_decoder_decode;
use super::names::{file_slug, is_valid_kind_slug, is_valid_resource_slug, matches_format};
use super::types::{Instance, InvalidReason, ResourceRef, ScanEntry, ScanResult, UnreadableEntry};
use crate::probing::detection::path_env::normalize_path;
use crate::probing::locations::{LocationDefinition, LocationLayout};

/// `MAX_LIBRARY_FILE_BYTES`: one leaf, or one file-backed instance.
pub(crate) const MAX_LIBRARY_FILE_BYTES: u64 = 2 * 1024 * 1024;
/// `MAX_LIBRARY_INSTANCE_BYTES`: one directory instance, all leaves.
pub(crate) const MAX_LIBRARY_INSTANCE_BYTES: u64 = 16 * 1024 * 1024;
/// `MAX_SKILL_ENTRYPOINT_BYTES`: a skill's `SKILL.md`.
pub(crate) const MAX_SKILL_ENTRYPOINT_BYTES: u64 = 256 * 1024;
const MAX_LIBRARY_INSTANCE_ENTRIES: usize = 10_000;
const MAX_LIBRARY_INSTANCE_DEPTH: usize = 32;
/// `SKILL_ENTRYPOINT`.
pub(crate) const SKILL_ENTRYPOINT: &str = "SKILL.md";

/// Why a walk or hash pass stopped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum WalkError {
    /// `PathEscapeError`: something resolved outside its root, or a
    /// directory was reached twice (a symlink cycle).
    PathEscape,
    /// `InstanceTooLargeError`: a byte, entry-count or depth cap.
    TooLarge,
    /// A manifest name the hash cannot carry safely.
    UnsafeName,
    /// Any I/O failure, with its description.
    Unreadable(String),
    /// The caller's cancellation token fired.
    Cancelled,
}

impl WalkError {
    fn invalid_reason(&self) -> InvalidReason {
        match self {
            Self::PathEscape => InvalidReason::PathEscape,
            Self::TooLarge => InvalidReason::TooLarge,
            Self::UnsafeName => InvalidReason::UnsafeName,
            Self::Unreadable(_) | Self::Cancelled => InvalidReason::Unreadable,
        }
    }
}

impl From<ReadFailure> for WalkError {
    fn from(failure: ReadFailure) -> Self {
        match failure {
            ReadFailure::Outside => Self::PathEscape,
            ReadFailure::TooLarge => Self::TooLarge,
            ReadFailure::Unreadable(message) => Self::Unreadable(message),
        }
    }
}

/// Everything one location's scan shares: the memo, the filesystem, the
/// host path semantics, cancellation, and where a skipped-location
/// diagnostic goes.
pub(crate) struct ScanContext<'a> {
    pub cache: &'a LibraryCache,
    pub force: bool,
    pub fs: &'a dyn LibraryFs,
    pub platform: &'a str,
    pub cancel: &'a CancellationToken,
    pub warn: &'a (dyn Fn(&str) + Sync),
}

fn check(cancel: &CancellationToken) -> Result<(), WalkError> {
    if cancel.is_cancelled() {
        return Err(WalkError::Cancelled);
    }
    Ok(())
}

fn is_within(root: &Path, candidate: &Path) -> bool {
    candidate.starts_with(root)
}

/// `readLocationInstances`: the instances and unreadable entries of one
/// location at `location_path`. Only cancellation is an error.
///
/// # Example
///
/// ```ignore
/// let scanned = read_location_instances(location_by_id("mango-skills").unwrap(), "/home/u/.mango/skills", &context)?;
/// ```
pub(crate) fn read_location_instances(
    location: &LocationDefinition,
    location_path: &str,
    context: &ScanContext<'_>,
) -> Result<ScanResult, WalkError> {
    check(context.cancel)?;
    if location.layout == LocationLayout::SingleFile {
        // The registry names a single-file resource, so the vendor's
        // filename never becomes identity.
        let name = Path::new(location_path)
            .file_name()
            .map(OsStr::to_string_lossy)
            .unwrap_or_default();
        let slug = location
            .resource_slug
            .map_or_else(|| file_slug(&name).to_string(), str::to_string);
        return read_one_entry(location, &slug, &name, location_path, false, None, context);
    }

    let listed = context
        .fs
        .read_dir(Path::new(location_path))
        .and_then(|names| Ok((names, context.fs.real_path(Path::new(location_path))?)));
    let (names, canonical_location) = match listed {
        Ok(listed) => listed,
        Err(error) => {
            if error.kind() != std::io::ErrorKind::NotFound {
                (context.warn)(&format!(
                    "[library] Skipping unreadable location \"{}\" at {location_path}.",
                    location.id
                ));
            }
            return Ok(ScanResult::default());
        }
    };

    let directories = location.layout == LocationLayout::DirectoryOfDirs;
    let mut result = ScanResult::default();
    for name in names {
        let name = name.to_string_lossy().into_owned();
        if name.starts_with('.') || (!directories && !matches_format(&name, location.format)) {
            continue;
        }
        check(context.cancel)?;
        let path = normalize_path(
            context.platform,
            &format!("{location_path}{}{name}", separator(context.platform)),
        );
        result.extend(read_one_entry(
            location,
            file_slug(&name),
            &name,
            &path,
            directories,
            Some(&canonical_location),
            context,
        )?);
    }
    Ok(result)
}

fn separator(platform: &str) -> char {
    if platform == "win32" { '\\' } else { '/' }
}

fn round_ms(mtime_ms: f64) -> u64 {
    // `Math.max(0, Math.round(x))`: half rounds toward +∞.
    let rounded = (mtime_ms + 0.5).floor();
    if rounded <= 0.0 { 0 } else { rounded as u64 }
}

fn invalid_instance(
    location: &LocationDefinition,
    slug: &str,
    path: &str,
    modified_at_ms: u64,
    reason: InvalidReason,
) -> ScanResult {
    ScanResult::instance(ScanEntry {
        resource: ResourceRef {
            kind: location.kind,
            slug: slug.to_string(),
        },
        instance: Instance {
            location_id: location.id,
            path: path.to_string(),
            modified_at_ms,
            format: location.format.as_str(),
            title: Some(slug.to_string()),
            description: None,
            content_hash: None,
            size_bytes: None,
            valid: false,
            invalid_reason: Some(reason),
        },
        whitespace_hash: None,
    })
}

/// `readOneEntry`. `name` is the raw entry name reported on the
/// unreadable-entries channel; `containment` is the canonical location
/// root for directory layouts.
fn read_one_entry(
    location: &LocationDefinition,
    slug: &str,
    name: &str,
    path: &str,
    expect_directory: bool,
    containment: Option<&Path>,
    context: &ScanContext<'_>,
) -> Result<ScanResult, WalkError> {
    if !is_valid_resource_slug(slug) {
        return Ok(ScanResult::unreadable(UnreadableEntry {
            location_id: location.id,
            name: name.to_string(),
            reason: "invalid-name",
        }));
    }
    let metadata = match context.fs.stat(Path::new(path)) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ScanResult::default());
        }
        Err(_) => {
            return Ok(invalid_instance(
                location,
                slug,
                path,
                0,
                InvalidReason::Unreadable,
            ));
        }
    };
    let modified = round_ms(metadata.mtime_ms);
    let has_type = if expect_directory {
        metadata.is_dir
    } else {
        metadata.is_file
    };
    if !has_type {
        return Ok(invalid_instance(
            location,
            slug,
            path,
            modified,
            InvalidReason::UnexpectedEntryType,
        ));
    }
    if !is_valid_kind_slug(location.kind, slug) {
        return Ok(invalid_instance(
            location,
            slug,
            path,
            modified,
            InvalidReason::InvalidSlug,
        ));
    }
    if !expect_directory && metadata.size > MAX_LIBRARY_FILE_BYTES {
        return Ok(invalid_instance(
            location,
            slug,
            path,
            modified,
            InvalidReason::TooLarge,
        ));
    }

    let hashed = resolve_read_path(path, containment, context).and_then(|(read_path, root)| {
        if expect_directory {
            hash_directory(location, slug, &read_path, &metadata, context)
        } else {
            hash_file(
                location,
                slug,
                &read_path,
                root.as_deref(),
                &metadata,
                context,
            )
        }
    });
    let (value, modified_at_ms) = match hashed {
        Ok(hashed) => hashed,
        Err(WalkError::Cancelled) => return Err(WalkError::Cancelled),
        Err(error) => {
            return Ok(invalid_instance(
                location,
                slug,
                path,
                modified,
                error.invalid_reason(),
            ));
        }
    };
    let display = &value.display;
    Ok(ScanResult::instance(ScanEntry {
        resource: ResourceRef {
            kind: location.kind,
            slug: slug.to_string(),
        },
        instance: Instance {
            location_id: location.id,
            path: path.to_string(),
            modified_at_ms,
            format: location.format.as_str(),
            title: display.title.clone().filter(|title| !title.is_empty()),
            description: display.description.clone().filter(|text| !text.is_empty()),
            content_hash: Some(value.content_hash.clone()),
            size_bytes: Some(value.size_bytes),
            valid: display.invalid_reason.is_none(),
            invalid_reason: display.invalid_reason,
        },
        whitespace_hash: Some(value.whitespace_hash.clone()),
    }))
}

/// The contained realpath a directory-layout entry is read through (so a
/// swap between check and open cannot escape), plus the root a file read
/// is contained to. Single-file locations read their own path, uncontained,
/// exactly as the TypeScript scan does — a dotfile-managed `CLAUDE.md`
/// symlinked elsewhere still scans.
fn resolve_read_path(
    path: &str,
    containment: Option<&Path>,
    context: &ScanContext<'_>,
) -> Result<(PathBuf, Option<PathBuf>), WalkError> {
    let Some(root) = containment else {
        return Ok((PathBuf::from(path), None));
    };
    let canonical = context
        .fs
        .real_path(Path::new(path))
        .map_err(|error| WalkError::Unreadable(error.to_string()))?;
    if !is_within(root, &canonical) {
        return Err(WalkError::PathEscape);
    }
    Ok((canonical, Some(root.to_path_buf())))
}

type Hashed = (std::sync::Arc<CachedInstanceHash>, u64);

fn hash_file(
    location: &LocationDefinition,
    slug: &str,
    read_path: &Path,
    root: Option<&Path>,
    metadata: &FileMeta,
    context: &ScanContext<'_>,
) -> Result<Hashed, WalkError> {
    let key = read_path.to_string_lossy();
    let fingerprint = format!("{key}\0{}\0{}", metadata.size, metadata.mtime_ms);
    let value = context
        .cache
        .instance_hash(&key, &fingerprint, context.force, || {
            let bytes = context
                .fs
                .read_file(root, read_path, MAX_LIBRARY_FILE_BYTES)?;
            let name = read_path
                .file_name()
                .map(OsStr::to_string_lossy)
                .unwrap_or_default()
                .into_owned();
            let text = text_decoder_decode(&bytes);
            Ok::<_, WalkError>(CachedInstanceHash {
                content_hash: hash_file_bytes(&bytes),
                size_bytes: bytes.len() as u64,
                whitespace_hash: combine_whitespace_digests(&[(name, whitespace_digest(&bytes))]),
                display: describe_instance(location, slug, Some(&text)),
            })
        })?;
    Ok((value, round_ms(metadata.mtime_ms)))
}

/// One leaf file of a directory instance.
#[derive(Debug, Clone)]
pub(crate) struct Leaf {
    pub absolute: PathBuf,
    /// Posix-separated, relative to the instance root.
    pub relative: String,
    pub size: u64,
    pub mtime_ms: f64,
}

/// `collectLeafFiles`: every regular file under `root`, following directory
/// symlinks only while they stay inside it, bounded by the entry, byte and
/// depth caps, and sorted by `localeCompare` on the relative path.
///
/// # Example
///
/// ```ignore
/// let leaves = collect_leaf_files(&NativeLibraryFs, Path::new("/home/u/.claude/skills/x"), &cancel)?;
/// ```
pub(crate) fn collect_leaf_files(
    fs: &dyn LibraryFs,
    root: &Path,
    cancel: &CancellationToken,
) -> Result<Vec<Leaf>, WalkError> {
    check(cancel)?;
    let canonical_root = fs
        .real_path(root)
        .map_err(|error| WalkError::Unreadable(error.to_string()))?;
    let mut walk = Walk {
        fs,
        cancel,
        canonical_root,
        visited: Vec::new(),
        leaves: Vec::new(),
        total_bytes: 0,
    };
    walk.visit(root, "", 0)?;
    let mut leaves = walk.leaves;
    leaves.sort_by(|left, right| locale_compare(&left.relative, &right.relative));
    Ok(leaves)
}

struct Walk<'a> {
    fs: &'a dyn LibraryFs,
    cancel: &'a CancellationToken,
    canonical_root: PathBuf,
    visited: Vec<PathBuf>,
    leaves: Vec<Leaf>,
    total_bytes: u64,
}

impl Walk<'_> {
    fn visit(&mut self, directory: &Path, prefix: &str, depth: usize) -> Result<(), WalkError> {
        check(self.cancel)?;
        if depth > MAX_LIBRARY_INSTANCE_DEPTH {
            return Err(WalkError::TooLarge);
        }
        let io = |error: std::io::Error| WalkError::Unreadable(error.to_string());
        let canonical = self.fs.real_path(directory).map_err(io)?;
        if !is_within(&self.canonical_root, &canonical) || self.visited.contains(&canonical) {
            return Err(WalkError::PathEscape);
        }
        self.visited.push(canonical);
        for name in self.fs.read_dir(directory).map_err(io)? {
            check(self.cancel)?;
            let absolute = directory.join(&name);
            let relative = format!("{prefix}{}", name.to_string_lossy());
            let metadata = self.fs.stat(&absolute).map_err(io)?;
            if metadata.is_dir {
                self.visit(&absolute, &format!("{relative}/"), depth + 1)?;
            } else if metadata.is_file {
                self.total_bytes += metadata.size;
                if self.total_bytes > MAX_LIBRARY_INSTANCE_BYTES
                    || self.leaves.len() >= MAX_LIBRARY_INSTANCE_ENTRIES
                {
                    return Err(WalkError::TooLarge);
                }
                self.leaves.push(Leaf {
                    absolute,
                    relative,
                    size: metadata.size,
                    mtime_ms: metadata.mtime_ms,
                });
            }
        }
        Ok(())
    }
}

fn assert_within_byte_budget(
    location: &LocationDefinition,
    leaves: &[Leaf],
) -> Result<(), WalkError> {
    let mut total = 0u64;
    for leaf in leaves {
        if leaf.size > MAX_LIBRARY_FILE_BYTES {
            return Err(WalkError::TooLarge);
        }
        if location.kind == "skill"
            && leaf.relative == SKILL_ENTRYPOINT
            && leaf.size > MAX_SKILL_ENTRYPOINT_BYTES
        {
            return Err(WalkError::TooLarge);
        }
        total += leaf.size;
        if total > MAX_LIBRARY_INSTANCE_BYTES {
            return Err(WalkError::TooLarge);
        }
    }
    Ok(())
}

fn hash_directory(
    location: &LocationDefinition,
    slug: &str,
    path: &Path,
    root_metadata: &FileMeta,
    context: &ScanContext<'_>,
) -> Result<Hashed, WalkError> {
    let leaves = collect_leaf_files(context.fs, path, context.cancel)?;
    assert_within_byte_budget(location, &leaves)?;
    let mut fingerprint = format!(".\0{}\0{}\n", root_metadata.size, root_metadata.mtime_ms);
    for leaf in &leaves {
        fingerprint.push_str(&format!(
            "{}\0{}\0{}\n",
            leaf.relative, leaf.size, leaf.mtime_ms
        ));
    }
    let newest = leaves.iter().fold(root_metadata.mtime_ms, |newest, leaf| {
        newest.max(leaf.mtime_ms)
    });
    let key = path.to_string_lossy();
    let value = context
        .cache
        .instance_hash(&key, &fingerprint, context.force, || {
            hash_directory_contents(location, slug, path, &leaves, context)
        })?;
    Ok((value, round_ms(newest)))
}

/// The cached half of `hashDirectory`: the v2 manifest over every leaf, the
/// whitespace digest, and the entrypoint's display metadata, in one read of
/// each file. Leaves that resolve to one canonical file (a symlink to a
/// sibling) each record that file's digest once per read, duplicates
/// included, exactly as the TypeScript reader's map does.
fn hash_directory_contents(
    location: &LocationDefinition,
    slug: &str,
    path: &Path,
    leaves: &[Leaf],
    context: &ScanContext<'_>,
) -> Result<CachedInstanceHash, WalkError> {
    let io = |error: std::io::Error| WalkError::Unreadable(error.to_string());
    let canonical_root = context.fs.real_path(path).map_err(io)?;
    let mut aliases: Vec<(PathBuf, Vec<String>)> = Vec::new();
    for leaf in leaves {
        let canonical = context.fs.real_path(&leaf.absolute).map_err(io)?;
        match aliases.iter_mut().find(|(known, _)| *known == canonical) {
            Some((_, names)) => names.push(leaf.relative.clone()),
            None => aliases.push((canonical, vec![leaf.relative.clone()])),
        }
    }

    let win32 = context.platform == "win32";
    let mut relatives: Vec<&str> = leaves.iter().map(|leaf| leaf.relative.as_str()).collect();
    relatives.sort_by(|left, right| super::js::cmp_utf16(left, right));
    let mut manifest = DirectoryManifest::default();
    let mut whitespace = Vec::new();
    let mut entrypoint: Option<String> = None;
    for relative in relatives {
        check(context.cancel)?;
        match relative_path_violation(relative, win32) {
            Some(ManifestViolation::PathEscape) => return Err(WalkError::PathEscape),
            Some(ManifestViolation::UnsafeName) => return Err(WalkError::UnsafeName),
            None => {}
        }
        let canonical = context
            .fs
            .real_path(&join_relative(&canonical_root, relative))
            .map_err(io)?;
        if !is_within(&canonical_root, &canonical) {
            return Err(WalkError::PathEscape);
        }
        let bytes =
            context
                .fs
                .read_file(Some(&canonical_root), &canonical, MAX_LIBRARY_FILE_BYTES)?;
        let digest = whitespace_digest(&bytes);
        let names = aliases
            .iter()
            .find(|(known, _)| *known == canonical)
            .map(|(_, names)| names.as_slice())
            .unwrap_or_default();
        for name in names {
            whitespace.push((name.clone(), digest.clone()));
            if name == SKILL_ENTRYPOINT {
                entrypoint = Some(text_decoder_decode(&bytes));
            }
        }
        manifest.push(relative, hash_file_bytes(&bytes), bytes.len() as u64);
    }
    let (content_hash, size_bytes) = manifest.finish();
    let display: Display = describe_instance(location, slug, entrypoint.as_deref());
    Ok(CachedInstanceHash {
        content_hash,
        size_bytes,
        whitespace_hash: combine_whitespace_digests(&whitespace),
        display,
    })
}
