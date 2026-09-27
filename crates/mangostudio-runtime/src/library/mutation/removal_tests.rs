//! Ports of `apps/api/tests/unit/modules/library/tree-removal.test.ts` and
//! the engine-level cases of `removal-apply.test.ts` (backup, staging,
//! pinning, atomicity, compensation failure, withheld handles), with
//! isolated fault fixtures for each failure.

use std::sync::atomic::{AtomicUsize, Ordering};

use super::*;
use crate::library::mutation::disk::NativeMutationFs;
use crate::library::mutation::fakes::{FsOp, Home};
use crate::library::mutation::undo::execute_undo;

fn never() -> Option<Interrupt> {
    None
}

fn skill_removal(
    home: &Home,
    location_id: &str,
    root: &[&str],
    last_copy: bool,
) -> RemovalOperation {
    let mut path: Vec<&str> = root.to_vec();
    path.push("gh");
    let destination = home.path(&path);
    RemovalOperation {
        resource_key: "skill:gh".into(),
        location_id: location_id.into(),
        slug: "gh".into(),
        kind: ResourceKind::Directory,
        expected_path: destination.to_string_lossy().into_owned(),
        expected_content_hash: home.hash(&destination, ResourceKind::Directory),
        last_copy,
    }
}

fn run(home: &Home, operations: &[RemovalOperation], last_copy: &[String]) -> RemovalResult {
    run_with(home, operations, last_copy, &never)
}

fn run_with(
    home: &Home,
    operations: &[RemovalOperation],
    last_copy: &[String],
    interrupted: &dyn Fn() -> Option<Interrupt>,
) -> RemovalResult {
    execute_removal(
        operations,
        &RemovalContext {
            store: &home.store,
            hasher: home.hasher.as_ref(),
            env: &home.env,
            environment_id: None,
            backup_id: None,
            last_copy_resource_keys: last_copy,
            interrupted,
        },
    )
}

fn tree(path: &std::path::Path) -> Vec<(String, Vec<u8>)> {
    let mut files = Vec::new();
    let mut pending = vec![path.to_path_buf()];
    while let Some(dir) = pending.pop() {
        for entry in std::fs::read_dir(&dir).unwrap().filter_map(Result::ok) {
            let entry_path = entry.path();
            if entry_path.is_dir() {
                pending.push(entry_path);
            } else {
                let relative = entry_path
                    .strip_prefix(path)
                    .unwrap()
                    .to_string_lossy()
                    .into_owned();
                files.push((relative, std::fs::read(&entry_path).unwrap()));
            }
        }
    }
    files.sort();
    files
}

#[test]
fn staging_moves_the_whole_tree_aside_and_rollback_puts_it_back() {
    let home = Home::new("removal-stage");
    let destination = home.skill(&home.path(&[".claude", "skills", "gh"]), "body");
    let before = tree(&destination);
    let platform = crate::health::node_platform();
    let staged = stage_removal(
        &NativeMutationFs,
        platform,
        &destination.to_string_lossy(),
        "s1",
    )
    .unwrap_or_else(|error| panic!("expected staging to succeed | received {error:?}"));
    assert!(!destination.exists(), "nothing is left at the destination");
    assert!(
        staged.stage_path.ends_with(".gh.s1.removing"),
        "received {}",
        staged.stage_path
    );
    staged.rollback(&NativeMutationFs).unwrap();
    assert_eq!(tree(&destination), before, "rollback is byte-for-byte");

    let staged = stage_removal(
        &NativeMutationFs,
        platform,
        &destination.to_string_lossy(),
        "s2",
    )
    .unwrap_or_else(|error| panic!("expected staging to succeed | received {error:?}"));
    staged.commit(&NativeMutationFs).unwrap();
    assert!(
        !std::path::Path::new(&staged.stage_path).exists(),
        "commit deletes the staged tree"
    );
}

#[test]
fn staging_refuses_a_temp_path_that_is_already_occupied() {
    let home = Home::new("removal-stage-occupied");
    let destination = home.skill(&home.path(&[".claude", "skills", "gh"]), "body");
    std::fs::create_dir_all(home.path(&[".claude", "skills", ".gh.s1.removing"])).unwrap();
    let refused = stage_removal(
        &NativeMutationFs,
        crate::health::node_platform(),
        &destination.to_string_lossy(),
        "s1",
    )
    .unwrap_err();
    assert!(
        matches!(&refused, StageError::Verification(message) if message.contains("refusing to overwrite it")),
        "received {refused:?}"
    );
    assert!(destination.exists());
}

#[test]
fn removes_a_skill_tree_backs_it_up_and_hands_back_the_undo_handle() {
    let home = Home::new("removal-basic");
    let destination = home.skill(&home.path(&[".claude", "skills", "gh"]), "body");
    let before = tree(&destination);
    let operation = skill_removal(&home, "claude-skills", &[".claude", "skills"], false);
    let result = run(&home, std::slice::from_ref(&operation), &[]);
    assert!(result.failed.is_empty(), "received {result:?}");
    let backup_id = result.backup_id.clone().unwrap();
    assert_eq!(result.backups[0].backup_id, backup_id);
    assert_eq!(
        result.removed[0].content_hash,
        operation.expected_content_hash
    );
    assert!(!destination.exists());
    let leftovers: Vec<_> = std::fs::read_dir(home.path(&[".claude", "skills"]))
        .unwrap()
        .filter_map(Result::ok)
        .collect();
    assert!(
        leftovers.is_empty(),
        "no staged temp tree remains once committed"
    );
    let manifest = home.manifest(&backup_id);
    assert_eq!(manifest["operation"], "removal");
    assert_eq!(manifest["entries"][0]["resourceKey"], "skill:gh");
    assert!(
        manifest.get("pinned").is_none(),
        "an ordinary removal is not pinned"
    );

    let undone = execute_undo(
        &backup_id,
        &home.store,
        home.hasher.as_ref(),
        &home.env,
        &never,
    )
    .unwrap();
    assert_eq!(undone.restored.len(), 1, "received {undone:?}");
    assert_eq!(tree(&destination), before, "the undo is byte-identical");
}

#[test]
fn pins_the_set_when_it_holds_the_last_copy() {
    let home = Home::new("removal-pinned");
    home.skill(&home.path(&[".claude", "skills", "gh"]), "body");
    let operation = skill_removal(&home, "claude-skills", &[".claude", "skills"], true);
    let result = run(&home, &[operation], &["skill:gh".into()]);
    assert!(result.removed[0].last_copy);
    let manifest = home.manifest(&result.backup_id.unwrap());
    assert_eq!(manifest["pinned"], true);
    assert_eq!(
        manifest["lastCopyResourceKeys"],
        serde_json::json!(["skill:gh"])
    );
}

#[test]
fn leaves_every_tree_byte_identical_when_a_later_removal_fails() {
    let home = Home::new("removal-atomic");
    let first = home.skill(&home.path(&[".claude", "skills", "gh"]), "one");
    let second = home.skill(&home.path(&[".agents", "skills", "gh"]), "two");
    let (before_first, before_second) = (tree(&first), tree(&second));
    let operations = vec![
        skill_removal(&home, "claude-skills", &[".claude", "skills"], false),
        skill_removal(&home, "agents-skills", &[".agents", "skills"], false),
        skill_removal(&home, "claude-skills", &[".claude", "skills"], false),
    ];
    home.fs.fail(FsOp::Rename, ".agents", 0);
    let result = run(&home, &operations, &[]);
    assert!(
        !result.partial && result.removed.is_empty(),
        "received {result:?}"
    );
    assert_eq!(result.failed[0].location_id, "agents-skills");
    assert_eq!(result.failed[0].reason, "remove-failed");
    assert_eq!(
        result
            .kept
            .iter()
            .map(|kept| kept.reason)
            .collect::<Vec<_>>(),
        vec!["rolled-back", "not-attempted"],
        "every reviewed location is accounted for"
    );
    assert_eq!(tree(&first), before_first);
    assert_eq!(tree(&second), before_second);
    assert!(result.backups.is_empty());
}

#[test]
fn reports_only_the_copies_whose_compensation_failed_as_removed() {
    let home = Home::new("removal-uncompensated");
    let first = home.skill(&home.path(&[".claude", "skills", "gh"]), "one");
    home.skill(&home.path(&[".agents", "skills", "gh"]), "two");
    let operations = vec![
        skill_removal(&home, "claude-skills", &[".claude", "skills"], false),
        skill_removal(&home, "agents-skills", &[".agents", "skills"], false),
    ];
    // The second staging rename fails; renaming the first tree home fails too.
    home.fs.fail(FsOp::Rename, ".agents", 0);
    home.fs.fail(
        FsOp::Rename,
        &format!("claude{0}skills{0}gh", std::path::MAIN_SEPARATOR),
        0,
    );
    let result = run(&home, &operations, &[]);
    assert!(result.partial, "received {result:?}");
    assert_eq!(result.removed.len(), 1);
    assert_eq!(result.removed[0].location_id, "claude-skills");
    assert!(!first.exists());
    let backup_id = result
        .backup_id
        .clone()
        .expect("the set holding the only copy is named");
    assert!(home.set(&backup_id).join("manifest.json").exists());
}

#[test]
fn withholds_a_handle_undo_could_not_resolve() {
    let home = Home::new("removal-manifest-fails");
    let destination = home.skill(&home.path(&[".claude", "skills", "gh"]), "body");
    home.fs.fail(FsOp::WriteText, "manifest.json", 0);
    let operation = skill_removal(&home, "claude-skills", &[".claude", "skills"], false);
    let result = run(&home, &[operation], &[]);
    assert!(
        result.backups.is_empty() && result.backup_id.is_none(),
        "received {result:?}"
    );
    assert_eq!(result.failed[0].reason, "remove-failed");
    assert!(
        result.failed[0]
            .message
            .contains("cannot be undone automatically")
    );
    assert_eq!(result.kept[0].reason, "rolled-back");
    assert!(destination.exists(), "the staged tree was renamed home");
}

#[test]
fn fails_and_rolls_back_when_a_destination_survives_its_own_removal() {
    let home = Home::new("removal-survives");
    let destination = home.skill(&home.path(&[".claude", "skills", "gh"]), "body");
    // The only existence probe of the destination itself is the
    // post-rename verification: recreate it just before that probe.
    home.fs.before(FsOp::Exists, ".claude", |path| {
        if path.ends_with(std::path::Path::new("skills").join("gh")) {
            std::fs::create_dir_all(path).unwrap();
        }
    });
    let operation = skill_removal(&home, "claude-skills", &[".claude", "skills"], false);
    let result = run(&home, &[operation], &[]);
    assert_eq!(
        result.failed[0].reason, "verification-failed",
        "received {result:?}"
    );
    assert!(
        result.failed[0]
            .message
            .contains("still exists after being removed")
    );
    assert!(result.removed.is_empty());
    assert!(
        destination.exists(),
        "the destination is never reported removed"
    );
}

#[test]
fn refuses_to_remove_a_copy_whose_bytes_changed_since_the_preview() {
    let home = Home::new("removal-changed");
    let destination = home.skill(&home.path(&[".claude", "skills", "gh"]), "body");
    let operation = skill_removal(&home, "claude-skills", &[".claude", "skills"], false);
    std::fs::write(destination.join("SKILL.md"), "edited").unwrap();
    let result = run(&home, &[operation], &[]);
    assert_eq!(
        result.failed[0].reason, "guard-rejected",
        "received {result:?}"
    );
    assert!(result.failed[0].message.contains("the preview described"));
    assert_eq!(
        std::fs::read_to_string(destination.join("SKILL.md")).unwrap(),
        "edited"
    );
}

#[test]
fn refuses_a_path_the_preview_did_not_name() {
    let home = Home::new("removal-path-guard");
    home.skill(&home.path(&[".claude", "skills", "gh"]), "body");
    let mut operation = skill_removal(&home, "claude-skills", &[".claude", "skills"], false);
    operation.expected_path = "/somebody/else/.claude/skills/gh".into();
    let result = run(&home, &[operation], &[]);
    assert_eq!(
        result.failed[0].reason, "guard-rejected",
        "received {result:?}"
    );
    assert!(result.failed[0].message.contains("not the previewed"));
}

#[test]
fn a_backup_failure_is_reported_as_backup_failed() {
    let home = Home::new("removal-backup-fails");
    let destination = home.skill(&home.path(&[".claude", "skills", "gh"]), "body");
    home.fs.fail(
        FsOp::Copy(crate::library::mutation::disk::CopyPurpose::Backup),
        "",
        0,
    );
    let operation = skill_removal(&home, "claude-skills", &[".claude", "skills"], false);
    let result = run(&home, &[operation], &[]);
    assert_eq!(
        result.failed[0].reason, "backup-failed",
        "received {result:?}"
    );
    assert!(destination.exists());
}

#[test]
fn an_interruption_between_removals_restores_the_staged_trees() {
    let home = Home::new("removal-interrupt");
    let first = home.skill(&home.path(&[".claude", "skills", "gh"]), "one");
    home.skill(&home.path(&[".agents", "skills", "gh"]), "two");
    let operations = vec![
        skill_removal(&home, "claude-skills", &[".claude", "skills"], false),
        skill_removal(&home, "agents-skills", &[".agents", "skills"], false),
    ];
    let checks = AtomicUsize::new(0);
    let interrupted =
        || (checks.fetch_add(1, Ordering::SeqCst) >= 1).then_some(Interrupt::Cancelled);
    let result = run_with(&home, &operations, &[], &interrupted);
    assert_eq!(
        result.failed[0].message,
        Interrupt::Cancelled.message(),
        "received {result:?}"
    );
    assert_eq!(result.kept[0].reason, "rolled-back");
    assert!(first.exists());
    assert!(
        !home
            .backups
            .join("2025-09-23T10-55-44.087Z-0000000000000000")
            .exists()
    );
}
