//! Undo against sets on disk: restore, remove, the untrusted-manifest
//! refusals from `apply-writes.test.ts`, and the skip reasons.

use super::*;
use crate::library::mutation::backup_store::{BackupManifest, SetOperation};
use crate::library::mutation::fakes::Home;
use crate::library::mutation::paths::ResourceKind;

fn never() -> Option<Interrupt> {
    None
}

/// A removal-shaped set for `destination`: a copy of it under the backup
/// root and an entry recording its current hash.
fn removal_set(home: &Home, backup_id: &str, destination: &std::path::Path) -> BackupEntry {
    let backup_path = home
        .store
        .backup_existing(
            &destination.to_string_lossy(),
            "claude-skills",
            "gh",
            backup_id,
        )
        .unwrap();
    BackupEntry {
        location_id: "claude-skills".into(),
        slug: "gh".into(),
        kind: ResourceKind::Directory,
        destination_path: destination.to_string_lossy().into_owned(),
        resolved_path: super::super::paths::resolve_through_existing_ancestor(
            &destination.to_string_lossy(),
        )
        .unwrap(),
        backup_path: Some(backup_path),
        written_content_hash: home.hash(destination, ResourceKind::Directory),
        resource_key: Some("skill:gh".into()),
    }
}

fn write(home: &Home, backup_id: &str, entries: Vec<BackupEntry>) {
    home.store
        .write_manifest(&BackupManifest {
            version: 3,
            backup_id: backup_id.into(),
            created_at_ms: 1.0,
            entries,
            operation: Some(SetOperation::Removal),
            environment_id: None,
            pinned: None,
            last_copy_resource_keys: None,
        })
        .unwrap();
}

fn run(home: &Home, backup_id: &str) -> Result<UndoResult, UndoError> {
    execute_undo(
        backup_id,
        &home.store,
        home.hasher.as_ref(),
        &home.env,
        &never,
    )
}

#[test]
fn a_missing_or_malformed_set_is_backup_missing() {
    let home = Home::new("undo-missing");
    for id in ["never-written", "../escape", ".hidden"] {
        assert!(
            matches!(run(&home, id), Err(UndoError::Missing(message)) if message.contains("is retained")),
            "expected {id:?} to be reported missing"
        );
    }
}

#[test]
fn an_entry_outside_its_location_refuses_the_whole_undo() {
    let home = Home::new("undo-forged");
    let destination = home.skill(&home.path(&[".claude", "skills", "gh"]), "body");
    let mut entry = removal_set(&home, "set", &destination);
    std::fs::remove_dir_all(&destination).unwrap();
    let outsider = home.scratch.join("not-a-library-path");
    std::fs::create_dir_all(&outsider).unwrap();
    entry.resolved_path = outsider.to_string_lossy().into_owned();
    write(&home, "set", vec![entry]);
    let refused = run(&home, "set").unwrap_err();
    assert!(
        matches!(&refused, UndoError::Refused(error) if error.message.contains("outside location \"claude-skills\"")),
        "received {refused:?}"
    );
    assert!(outsider.exists(), "nothing outside the location is touched");
    assert!(!destination.exists());
}

#[test]
fn a_backup_path_outside_the_backup_root_is_skipped_as_missing() {
    let home = Home::new("undo-backup-outside");
    let destination = home.skill(&home.path(&[".claude", "skills", "gh"]), "body");
    let mut entry = removal_set(&home, "set", &destination);
    std::fs::remove_dir_all(&destination).unwrap();
    let elsewhere = home.skill(&home.scratch.join("elsewhere"), "planted");
    entry.backup_path = Some(elsewhere.to_string_lossy().into_owned());
    write(&home, "set", vec![entry]);
    let report = run(&home, "set").unwrap();
    assert_eq!(
        report.skipped[0].reason, "backup-missing",
        "received {report:?}"
    );
    assert!(!destination.exists(), "the planted tree is never copied in");
}

#[test]
fn a_destination_changed_since_the_apply_is_left_alone() {
    let home = Home::new("undo-changed");
    let destination = home.skill(&home.path(&[".claude", "skills", "gh"]), "body");
    let entry = removal_set(&home, "set", &destination);
    std::fs::write(destination.join("SKILL.md"), "edited afterwards").unwrap();
    write(&home, "set", vec![entry]);
    let report = run(&home, "set").unwrap();
    assert_eq!(
        report.skipped[0].reason, "changed-since-apply",
        "received {report:?}"
    );
    assert_eq!(
        std::fs::read_to_string(destination.join("SKILL.md")).unwrap(),
        "edited afterwards"
    );
}

#[test]
fn a_pruned_copy_is_skipped_and_an_interrupt_stops_between_entries() {
    let home = Home::new("undo-pruned-copy");
    let destination = home.skill(&home.path(&[".claude", "skills", "gh"]), "body");
    let entry = removal_set(&home, "set", &destination);
    std::fs::remove_dir_all(&destination).unwrap();
    std::fs::remove_dir_all(entry.backup_path.as_deref().unwrap()).unwrap();
    write(&home, "set", vec![entry]);
    let report = run(&home, "set").unwrap();
    assert_eq!(
        report.skipped[0].reason, "backup-missing",
        "received {report:?}"
    );
    let interrupted = || Some(Interrupt::Cancelled);
    assert_eq!(
        execute_undo(
            "set",
            &home.store,
            home.hasher.as_ref(),
            &home.env,
            &interrupted
        ),
        Err(UndoError::Interrupted(Interrupt::Cancelled))
    );
}

#[test]
fn an_unreadable_location_is_refused_rather_than_guessed() {
    let home = Home::new("undo-unknown-location");
    let destination = home.skill(&home.path(&[".claude", "skills", "gh"]), "body");
    let mut entry = removal_set(&home, "set", &destination);
    entry.location_id = "not-a-location".into();
    write(&home, "set", vec![entry]);
    assert!(matches!(
        run(&home, "set"),
        Err(UndoError::Refused(error)) if error.message.contains("does not resolve on this machine")
    ));
}
