//! Ports of `apps/shared/tests/unit/library/machine/apply-writes.test.ts`
//! and `apps/api/tests/unit/modules/library/resource-writer.test.ts`, plus
//! isolated fault fixtures: permission and path swaps between check and
//! use, partial writes, and interruption at an operation boundary.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use super::*;
use crate::library::mutation::disk::CopyPurpose;
use crate::library::mutation::fakes::{FsOp, Home};
use crate::library::mutation::undo::execute_undo;
use crate::library::mutation::writer::TransferredFile;

fn skill_op(
    home: &Home,
    location_id: &str,
    root: &[&str],
    source: &std::path::Path,
    hash: &str,
) -> ApplyOperation {
    ApplyOperation {
        resource_key: "skill:gh".into(),
        location_id: location_id.into(),
        slug: "gh".into(),
        operation: "create".into(),
        kind: ResourceKind::Directory,
        expected_content_hash: hash.into(),
        destination_root: home.text(root),
        directory: Some(DirectorySource::Path(source.to_string_lossy().into_owned())),
        contents: None,
        adaptation: None,
    }
}

fn never() -> Option<Interrupt> {
    None
}

fn run(home: &Home, operations: &[ApplyOperation]) -> ApplyResult {
    run_with(home, operations, &never)
}

fn run_with(
    home: &Home,
    operations: &[ApplyOperation],
    interrupted: &dyn Fn() -> Option<Interrupt>,
) -> ApplyResult {
    execute_apply(
        operations,
        &ApplyContext {
            store: &home.store,
            hasher: home.hasher.as_ref(),
            env: &home.env,
            environment_id: None,
            backup_id: None,
            interrupted,
        },
    )
}

fn undo(home: &Home, backup_id: &str) -> super::super::undo::UndoResult {
    execute_undo(
        backup_id,
        &home.store,
        home.hasher.as_ref(),
        &home.env,
        &never,
    )
    .unwrap()
}

fn skills(home: &Home, slug: &str) -> std::path::PathBuf {
    home.path(&[".claude", "skills", slug])
}

#[test]
fn writes_through_the_injected_backup_root_and_supports_undo() {
    let home = Home::new("apply-create-undo");
    let source = home.skill(&home.scratch.join("source"), "body");
    let hash = home.hash(&source, ResourceKind::Directory);
    let result = run(
        &home,
        &[skill_op(
            &home,
            "claude-skills",
            &[".claude", "skills"],
            &source,
            &hash,
        )],
    );
    assert_eq!(result.failed, vec![], "received {result:?}");
    let backup_id = result
        .backup_id
        .clone()
        .expect("a successful apply names its set");
    assert_eq!(result.backups[0].environment_id, "local");
    assert_eq!(result.applied[0].content_hash, hash);
    assert!(
        std::fs::read_to_string(skills(&home, "gh").join("SKILL.md"))
            .unwrap()
            .contains("body")
    );
    let manifest = home.manifest(&backup_id);
    assert_eq!(manifest["operation"], "propagation");
    assert!(
        manifest.get("environmentId").is_none(),
        "an envelope without environmentId stamps none"
    );
    let undone = undo(&home, &backup_id);
    assert_eq!(undone.removed.len(), 1);
    assert!(!skills(&home, "gh").exists());
}

#[test]
fn refuses_a_write_whose_destination_is_not_the_one_the_preview_showed() {
    let home = Home::new("apply-guard-root");
    let source = home.skill(&home.scratch.join("source"), "body");
    let hash = home.hash(&source, ResourceKind::Directory);
    let mut operation = skill_op(
        &home,
        "claude-skills",
        &[".claude", "skills"],
        &source,
        &hash,
    );
    operation.destination_root = "/somebody/else/.claude/skills".into();
    let result = run(&home, &[operation]);
    assert_eq!(
        result.failed[0].reason, "guard-rejected",
        "received {result:?}"
    );
    assert!(result.applied.is_empty());
    assert!(!skills(&home, "gh").exists());
    assert!(
        !home.backups.exists(),
        "a refused apply leaves no backup set"
    );
}

/// `apply-writes.test.ts` "stops and rolls back when the hub cancels
/// mid-apply": the interruption lands at the boundary after the first
/// destination was written.
#[test]
fn an_interruption_between_operations_stops_and_rolls_back() {
    for interrupt in [Interrupt::Cancelled, Interrupt::ConsentWithdrawn] {
        let home = Home::new("apply-interrupt");
        std::fs::create_dir_all(home.path(&[".agents", "skills"])).unwrap();
        let source = home.skill(&home.scratch.join("source"), "body");
        let hash = home.hash(&source, ResourceKind::Directory);
        let checks = AtomicUsize::new(0);
        let interrupted = || (checks.fetch_add(1, Ordering::SeqCst) >= 1).then_some(interrupt);
        let result = run_with(
            &home,
            &[
                skill_op(
                    &home,
                    "claude-skills",
                    &[".claude", "skills"],
                    &source,
                    &hash,
                ),
                skill_op(
                    &home,
                    "agents-skills",
                    &[".agents", "skills"],
                    &source,
                    &hash,
                ),
            ],
            &interrupted,
        );
        assert_eq!(result.failed.len(), 1, "received {result:?}");
        assert_eq!(result.failed[0].location_id, "agents-skills");
        assert_eq!(result.failed[0].message, interrupt.message());
        assert!(result.applied.is_empty() && !result.partial);
        assert!(
            !skills(&home, "gh").exists(),
            "the first write is compensated"
        );
        assert!(!home.path(&[".agents", "skills", "gh"]).exists());
        assert!(
            !home
                .backups
                .join("2025-09-23T10-55-44.087Z-0000000000000000")
                .exists()
        );
    }
}

#[test]
fn refuses_a_write_whose_on_disk_hash_is_not_the_one_the_preview_described() {
    let home = Home::new("apply-verify-mismatch");
    let source = home.skill(&home.scratch.join("source"), "body");
    let result = run(
        &home,
        &[skill_op(
            &home,
            "claude-skills",
            &[".claude", "skills"],
            &source,
            "not-the-hash",
        )],
    );
    assert_eq!(
        result.failed[0].reason, "verification-failed",
        "received {result:?}"
    );
    assert!(result.failed[0].message.contains("not not-the-hash"));
    assert!(result.applied.is_empty());
    assert!(!skills(&home, "gh").exists());
}

#[cfg(unix)]
#[test]
fn a_newline_filename_fails_verification_with_unsafe_name() {
    let home = Home::new("apply-verify-newline");
    let source = home.skill(&home.scratch.join("source"), "body");
    std::fs::write(source.join("a\nb.md"), "leaf").unwrap();
    let result = run(
        &home,
        &[skill_op(
            &home,
            "claude-skills",
            &[".claude", "skills"],
            &source,
            "unused",
        )],
    );
    assert_eq!(result.failed[0].reason, "verification-failed");
    assert!(
        result.failed[0].message.contains("unsafe-name"),
        "received {result:?}"
    );
    assert!(!skills(&home, "gh").exists());
}

#[test]
fn keeps_the_backup_set_when_an_overwrite_cannot_be_rolled_back() {
    let home = Home::new("apply-uncompensated-overwrite");
    let destination = home.skill(&skills(&home, "gh"), "old");
    let source = home.skill(&home.scratch.join("source"), "new");
    home.fs.fail(FsOp::Copy(CopyPurpose::Restore), "", 0);
    let mut operation = skill_op(
        &home,
        "claude-skills",
        &[".claude", "skills"],
        &source,
        "not-the-hash",
    );
    operation.operation = "overwrite".into();
    let result = run(&home, &[operation]);
    assert!(
        result.partial,
        "expected a partial apply | received {result:?}"
    );
    let backup_id = result.backup_id.clone().unwrap();
    assert_eq!(result.failed[0].reason, "verification-failed");
    assert!(result.applied.is_empty());
    assert!(
        std::fs::read_to_string(destination.join("SKILL.md"))
            .unwrap()
            .contains("new")
    );
    assert!(
        std::fs::read_to_string(
            home.set(&backup_id)
                .join("claude-skills")
                .join("gh")
                .join("SKILL.md")
        )
        .unwrap()
        .contains("old")
    );
    assert_eq!(
        home.manifest(&backup_id)["entries"][0]["writtenContentHash"],
        home.hash(&destination, ResourceKind::Directory),
        "the manifest records what is actually on disk"
    );
    let mut fixed = Home::new("apply-uncompensated-overwrite-undo");
    fixed.store.root = home.store.root.clone();
    fixed.env = home.env.clone();
    let undone = undo(&fixed, &backup_id);
    assert_eq!(undone.restored.len(), 1, "received {undone:?}");
    assert!(
        std::fs::read_to_string(destination.join("SKILL.md"))
            .unwrap()
            .contains("old")
    );
}

#[test]
fn records_the_destination_hash_when_verification_saw_none() {
    let home = Home::new("apply-verify-io");
    let destination = skills(&home, "gh");
    let source = home.skill(&home.scratch.join("source"), "body");
    let hash = home.hash(&source, ResourceKind::Directory);
    home.hasher.answer_once(
        "skills",
        Err(HashError::Io("EIO: could not read destination".into())),
    );
    home.fs.fail(
        FsOp::Remove,
        &format!("{}{}", std::path::MAIN_SEPARATOR, "gh"),
        0,
    );
    let result = run(
        &home,
        &[skill_op(
            &home,
            "claude-skills",
            &[".claude", "skills"],
            &source,
            &hash,
        )],
    );
    assert!(result.partial, "received {result:?}");
    assert_eq!(result.failed[0].reason, "write-failed");
    assert!(destination.exists());
    let backup_id = result.backup_id.clone().unwrap();
    assert_eq!(
        home.manifest(&backup_id)["entries"][0]["writtenContentHash"],
        home.hash(&destination, ResourceKind::Directory)
    );
    let mut fixed = Home::new("apply-verify-io-undo");
    fixed.store.root = home.store.root.clone();
    fixed.env = home.env.clone();
    let undone = undo(&fixed, &backup_id);
    assert!(undone.skipped.is_empty(), "received {undone:?}");
    assert_eq!(undone.removed.len(), 1);
    assert!(!destination.exists());
}

#[test]
fn keeps_a_created_destination_when_rollback_cannot_remove_it() {
    let home = Home::new("apply-uncompensated-create");
    let destination = skills(&home, "gh");
    let source = home.skill(&home.scratch.join("source"), "body");
    home.fs.fail(
        FsOp::Remove,
        &format!("{}{}", std::path::MAIN_SEPARATOR, "gh"),
        0,
    );
    let result = run(
        &home,
        &[skill_op(
            &home,
            "claude-skills",
            &[".claude", "skills"],
            &source,
            "not-the-hash",
        )],
    );
    assert!(result.partial, "received {result:?}");
    assert_eq!(result.failed[0].reason, "verification-failed");
    assert!(destination.exists());
    let backup_id = result.backup_id.clone().unwrap();
    assert!(home.set(&backup_id).join("manifest.json").exists());
}

#[test]
fn backs_up_prior_content_before_replacing_a_directory() {
    let home = Home::new("apply-backup-overwrite");
    let destination = home.skill(&skills(&home, "gh"), "old");
    std::fs::write(destination.join("stale.md"), "stale").unwrap();
    let source = home.skill(&home.scratch.join("source"), "new");
    let hash = home.hash(&source, ResourceKind::Directory);
    let result = run(
        &home,
        &[skill_op(
            &home,
            "claude-skills",
            &[".claude", "skills"],
            &source,
            &hash,
        )],
    );
    assert!(result.failed.is_empty(), "received {result:?}");
    let backup_id = result.backup_id.unwrap();
    let backup = home.set(&backup_id).join("claude-skills").join("gh");
    assert!(
        std::fs::read_to_string(backup.join("SKILL.md"))
            .unwrap()
            .contains("old")
    );
    assert!(backup.join("stale.md").exists());
    assert!(
        !destination.join("stale.md").exists(),
        "the swap replaces the whole tree"
    );
    let siblings: Vec<String> = std::fs::read_dir(home.path(&[".claude", "skills"]))
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(
        siblings,
        vec!["gh"],
        "no staging or previous sibling remains"
    );
}

#[test]
fn restores_the_original_directory_when_the_staged_swap_fails() {
    let home = Home::new("apply-swap-fails");
    let destination = home.skill(&skills(&home, "gh"), "old");
    let source = home.skill(&home.scratch.join("source"), "new");
    let hash = home.hash(&source, ResourceKind::Directory);
    home.fs.fail_once(
        FsOp::Rename,
        &format!("skills{}gh", std::path::MAIN_SEPARATOR),
    );
    let result = run(
        &home,
        &[skill_op(
            &home,
            "claude-skills",
            &[".claude", "skills"],
            &source,
            &hash,
        )],
    );
    assert_eq!(
        result.failed[0].reason, "write-failed",
        "received {result:?}"
    );
    assert!(!result.partial);
    assert!(
        std::fs::read_to_string(destination.join("SKILL.md"))
            .unwrap()
            .contains("old")
    );
    assert!(
        !home
            .backups
            .join("2025-09-23T10-55-44.087Z-0000000000000000")
            .exists()
    );
}

#[test]
fn refuses_a_read_only_location_before_touching_the_filesystem() {
    let home = Home::new("apply-read-only");
    let mut operation = skill_op(&home, "claude-settings", &[".claude"], &home.scratch, "h");
    operation.kind = ResourceKind::File;
    operation.slug = "settings".into();
    operation.directory = None;
    operation.contents = Some(Arc::new(b"{}".to_vec()));
    let result = run(&home, &[operation]);
    assert_eq!(
        result.failed[0].reason, "guard-rejected",
        "received {result:?}"
    );
    assert!(result.failed[0].message.contains("is read-only"));
    assert_eq!(
        home.fs.count(FsOp::Exists, ""),
        0,
        "nothing was inspected on disk"
    );
}

#[cfg(unix)]
#[test]
fn writes_through_a_symlinked_location_root_without_replacing_the_link() {
    let home = Home::new("apply-symlinked-root");
    let real = home.scratch.join("dotfiles-skills");
    std::fs::create_dir_all(&real).unwrap();
    std::fs::remove_dir_all(home.path(&[".claude", "skills"])).unwrap();
    std::os::unix::fs::symlink(&real, home.path(&[".claude", "skills"])).unwrap();
    let source = home.skill(&home.scratch.join("source"), "body");
    let hash = home.hash(&source, ResourceKind::Directory);
    let result = run(
        &home,
        &[skill_op(
            &home,
            "claude-skills",
            &[".claude", "skills"],
            &source,
            &hash,
        )],
    );
    assert!(result.failed.is_empty(), "received {result:?}");
    assert!(
        std::fs::symlink_metadata(home.path(&[".claude", "skills"]))
            .unwrap()
            .is_symlink()
    );
    assert!(real.join("gh").join("SKILL.md").exists());
}

#[test]
fn prunes_backup_sets_beyond_the_configured_retention_count() {
    let mut home = Home::new("apply-prune");
    home.store.retention_count = 1.0;
    let old = home.backups.join("old");
    std::fs::create_dir_all(old.join("claude-skills")).unwrap();
    home.store
        .write_manifest(&crate::library::mutation::backup_store::BackupManifest {
            version: 3,
            backup_id: "old".into(),
            created_at_ms: 0.0,
            entries: Vec::new(),
            operation: None,
            environment_id: None,
            pinned: None,
            last_copy_resource_keys: None,
        })
        .unwrap();
    home.fs.pin_mtime(&old, 0.0);
    home.skill(&skills(&home, "gh"), "old");
    let source = home.skill(&home.scratch.join("source"), "new");
    let hash = home.hash(&source, ResourceKind::Directory);
    let result = run(
        &home,
        &[skill_op(
            &home,
            "claude-skills",
            &[".claude", "skills"],
            &source,
            &hash,
        )],
    );
    assert!(result.failed.is_empty(), "received {result:?}");
    assert!(!old.exists(), "the older set is evicted");
    assert!(home.set(&result.backup_id.unwrap()).exists());
}

#[test]
fn refuses_a_backup_id_that_would_escape_the_backup_root() {
    let home = Home::new("apply-escaping-id");
    let source = home.skill(&home.scratch.join("source"), "body");
    let hash = home.hash(&source, ResourceKind::Directory);
    let result = execute_apply(
        &[skill_op(
            &home,
            "claude-skills",
            &[".claude", "skills"],
            &source,
            &hash,
        )],
        &ApplyContext {
            store: &home.store,
            hasher: home.hasher.as_ref(),
            env: &home.env,
            environment_id: Some("box"),
            backup_id: Some("../escape"),
            interrupted: &never,
        },
    );
    assert_eq!(
        result.failed[0].reason, "write-failed",
        "received {result:?}"
    );
    assert_eq!(result.failed[0].environment_id, "box");
    assert!(
        result.failed[0]
            .message
            .contains("Invalid library backup id")
    );
    assert!(!skills(&home, "gh").exists());
}

/// Correction to TypeScript: a manifest that cannot be recorded after
/// every write landed is rolled back *and reported*, not answered as an
/// empty success.
#[test]
fn a_manifest_failure_after_a_full_rollback_is_reported() {
    let home = Home::new("apply-manifest-fails");
    let source = home.skill(&home.scratch.join("source"), "body");
    let hash = home.hash(&source, ResourceKind::Directory);
    home.fs.fail(FsOp::WriteText, "manifest.json", 0);
    let result = run(
        &home,
        &[skill_op(
            &home,
            "claude-skills",
            &[".claude", "skills"],
            &source,
            &hash,
        )],
    );
    assert!(!result.partial && result.applied.is_empty());
    assert_eq!(
        result
            .failed
            .iter()
            .map(|row| row.reason)
            .collect::<Vec<_>>(),
        vec!["write-failed"],
        "expected one write-failed row for the unrecorded manifest | received {:?}",
        result.failed
    );
    assert!(result.failed[0].message.contains("rolled back"));
    assert!(!skills(&home, "gh").exists());
}

#[test]
fn a_transferred_tree_is_staged_from_the_frame_and_undone() {
    let home = Home::new("apply-transferred-tree");
    let source = home.skill(&home.scratch.join("source"), "body");
    std::fs::create_dir_all(source.join("refs")).unwrap();
    std::fs::write(source.join("refs").join("a.md"), "a").unwrap();
    let hash = home.hash(&source, ResourceKind::Directory);
    let file = |relative: &str, path: std::path::PathBuf| TransferredFile {
        relative_path: relative.into(),
        contents: Arc::new(std::fs::read(path).unwrap()),
    };
    let mut operation = skill_op(
        &home,
        "claude-skills",
        &[".claude", "skills"],
        &source,
        &hash,
    );
    operation.directory = Some(DirectorySource::Files(vec![
        file("SKILL.md", source.join("SKILL.md")),
        file("refs/a.md", source.join("refs").join("a.md")),
    ]));
    let result = run(&home, &[operation.clone()]);
    assert!(result.failed.is_empty(), "received {result:?}");
    assert_eq!(
        std::fs::read_to_string(skills(&home, "gh").join("refs").join("a.md")).unwrap(),
        "a"
    );
    undo(&home, &result.backup_id.unwrap());
    assert!(!skills(&home, "gh").exists());

    operation.directory = Some(DirectorySource::Files(vec![TransferredFile {
        relative_path: "../../.ssh/authorized_keys".into(),
        contents: Arc::new(b"key".to_vec()),
    }]));
    let refused = run(&home, &[operation]);
    assert_eq!(
        refused.failed[0].reason, "guard-rejected",
        "received {refused:?}"
    );
    assert!(
        refused.failed[0]
            .message
            .contains("not a contained relative path")
    );
    assert!(!home.scratch.join(".ssh").exists() && !home.home.join(".ssh").exists());
}

#[test]
fn a_file_resource_is_backed_up_written_and_restored() {
    let home = Home::new("apply-file-resource");
    let path = home.path(&[".claude", "CLAUDE.md"]);
    std::fs::write(&path, "old").unwrap();
    let hash = crate::library::hash::hash_file_bytes(b"new");
    let operation = ApplyOperation {
        resource_key: "instruction:global".into(),
        location_id: "claude-instructions".into(),
        slug: "global".into(),
        operation: "overwrite".into(),
        kind: ResourceKind::File,
        expected_content_hash: hash,
        destination_root: path.to_string_lossy().into_owned(),
        directory: None,
        contents: Some(Arc::new(b"new".to_vec())),
        adaptation: Some(serde_json::json!({
            "strategy": "verbatim", "lossy": false, "requiresReview": false, "notes": [], "extra": 1
        })),
    };
    let result = run(&home, &[operation]);
    assert!(result.failed.is_empty(), "received {result:?}");
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "new");
    assert_eq!(
        result.applied[0].adaptation,
        Some(
            serde_json::json!({ "strategy": "verbatim", "lossy": false, "requiresReview": false, "notes": [] })
        ),
        "only the schema's members are echoed"
    );
    let undone = undo(&home, &result.backup_id.unwrap());
    assert_eq!(undone.restored.len(), 1, "received {undone:?}");
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "old");
}

/// A regular file swapped in at the destination after the first check but
/// before the staged tree is swapped in is refused by the second check;
/// the swapped-in file and nothing else survives.
#[test]
fn a_path_swapped_between_check_and_swap_is_refused() {
    let home = Home::new("apply-path-swap");
    let destination = skills(&home, "gh");
    let source = home.skill(&home.scratch.join("source"), "body");
    let hash = home.hash(&source, ResourceKind::Directory);
    let swapped = destination.clone();
    home.fs
        .before(FsOp::Copy(CopyPurpose::Stage), "", move |_| {
            std::fs::write(&swapped, "somebody else's file").unwrap();
        });
    let result = run(
        &home,
        &[skill_op(
            &home,
            "claude-skills",
            &[".claude", "skills"],
            &source,
            &hash,
        )],
    );
    assert_eq!(
        result.failed[0].reason, "guard-rejected",
        "received {result:?}"
    );
    assert!(
        result.failed[0]
            .message
            .contains("is not a regular directory")
    );
    assert_eq!(
        std::fs::read_to_string(&destination).unwrap(),
        "somebody else's file"
    );
    let siblings = std::fs::read_dir(home.path(&[".claude", "skills"]))
        .unwrap()
        .count();
    assert_eq!(siblings, 1, "the staged tree is cleaned up");
}

/// A destination file made read-only after resolution is refused by the
/// atomic writer's own writability check; the original bytes survive.
#[cfg(unix)]
#[test]
fn a_permission_change_before_the_commit_is_refused() {
    use std::os::unix::fs::PermissionsExt;
    let home = Home::new("apply-permission-change");
    let path = home.path(&[".claude", "CLAUDE.md"]);
    std::fs::write(&path, "old").unwrap();
    let locked = path.clone();
    home.fs.before(FsOp::WriteFile, "CLAUDE.md", move |_| {
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o444)).unwrap();
    });
    let operation = ApplyOperation {
        resource_key: "instruction:global".into(),
        location_id: "claude-instructions".into(),
        slug: "global".into(),
        operation: "overwrite".into(),
        kind: ResourceKind::File,
        expected_content_hash: crate::library::hash::hash_file_bytes(b"new"),
        destination_root: path.to_string_lossy().into_owned(),
        directory: None,
        contents: Some(Arc::new(b"new".to_vec())),
        adaptation: None,
    };
    let result = run(&home, &[operation]);
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(
        result.failed[0].reason, "write-failed",
        "received {result:?}"
    );
    assert!(result.failed[0].message.contains("not writable"));
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "old");
}
