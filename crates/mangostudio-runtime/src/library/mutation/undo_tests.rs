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
    removal_set_in_location(home, backup_id, destination, "claude-skills")
}

fn removal_set_in_location(
    home: &Home,
    backup_id: &str,
    destination: &std::path::Path,
    location_id: &str,
) -> BackupEntry {
    let backup_path = home
        .store
        .backup_existing(&destination.to_string_lossy(), location_id, "gh", backup_id)
        .unwrap();
    BackupEntry {
        location_id: location_id.into(),
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

#[cfg(unix)]
#[test]
fn restores_a_removed_skill_under_a_dangling_directory_root() {
    let home = Home::new("undo-dangling-directory-root");
    let location = home.path(&[".claude", "skills"]);
    let real = home.path(&[".claude", "dotfiles"]);
    std::fs::rename(&location, &real).unwrap();
    let target = "dotfiles/";
    std::os::unix::fs::symlink(target, &location).unwrap();
    let destination = home.skill(&real.join("gh"), "body");
    let original = std::fs::read(destination.join("SKILL.md")).unwrap();
    let entry = removal_set(&home, "set", &destination);
    write(&home, "set", vec![entry]);
    std::fs::remove_dir_all(&real).unwrap();

    let report = run(&home, "set").unwrap();

    assert_eq!(report.restored.len(), 1, "received {report:?}");
    assert_eq!(std::fs::read_link(&location).unwrap().as_os_str(), target);
    assert_eq!(
        std::fs::read(destination.join("SKILL.md")).unwrap(),
        original
    );
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

fn symlink_directory(target: &std::path::Path, link: &std::path::Path) {
    #[cfg(unix)]
    std::os::unix::fs::symlink(target, link).unwrap();
    #[cfg(windows)]
    std::os::windows::fs::symlink_dir(target, link).unwrap();
}

#[test]
fn undo_checks_the_registry_write_policy_before_removing_resources() {
    let home = Home::new("undo-location-policy");
    let settings = home.path(&[".claude", "settings.json"]);
    std::fs::write(&settings, "{}").unwrap();
    let command = home.skill(&home.path(&[".claude", "commands", "gh.md"]), "keep");
    for (location, slug, path, kind, refusal) in [
        (
            "claude-settings",
            "settings",
            settings,
            ResourceKind::File,
            WriteFailure::ReadOnlyLocation,
        ),
        (
            "claude-commands",
            "gh",
            command,
            ResourceKind::Directory,
            WriteFailure::WrongLayout,
        ),
    ] {
        let destination_path = path.to_string_lossy().into_owned();
        write(
            &home,
            "set",
            vec![BackupEntry {
                location_id: location.into(),
                slug: slug.into(),
                kind,
                resolved_path: resolve_through_existing_ancestor(&destination_path).unwrap(),
                destination_path,
                backup_path: None,
                written_content_hash: home.hash(&path, kind),
                resource_key: None,
            }],
        );

        let outcome = run(&home, "set");
        assert!(
            matches!(&outcome, Err(UndoError::Refused(error)) if error.reason == refusal),
            "expected {refusal:?} for location {location} | received {outcome:?}"
        );
        assert!(path.exists(), "the resource is untouched");
    }
}

#[test]
fn a_directory_location_itself_is_never_a_resource_destination() {
    let home = Home::new("undo-location-root");
    let location = home.path(&[".claude", "skills"]);
    let skill = home.skill(&location.join("gh"), "keep");
    let mut entry = removal_set(&home, "set", &location);
    entry.backup_path = None;
    write(&home, "set", vec![entry]);

    let outcome = run(&home, "set");
    assert!(
        matches!(&outcome, Err(UndoError::Refused(error)) if error.reason == WriteFailure::PathEscape),
        "expected the location root to be refused | received {outcome:?}"
    );
    assert!(skill.join("SKILL.md").exists(), "the resource is untouched");
}

#[test]
fn a_redirected_manifest_is_never_opened_by_undo() {
    let home = Home::new("undo-redirected-manifest");
    let destination = home.skill(&home.path(&[".claude", "skills", "gh"]), "keep");
    let mut entry = removal_set(&home, "set", &destination);
    entry.backup_path = None;
    write(&home, "set", vec![entry]);

    let backup_set = home.backups.join("set");
    let outside = home.scratch.join("outside-set");
    std::fs::rename(&backup_set, &outside).unwrap();
    symlink_directory(&outside, &backup_set);

    let outcome = run(&home, "set");
    assert!(
        matches!(&outcome, Err(UndoError::Missing(_))),
        "expected the redirected backup manifest to be ignored | received {outcome:?}"
    );
    assert!(
        destination.join("SKILL.md").exists(),
        "the redirected manifest cannot drive undo"
    );
}

#[test]
fn undo_selects_only_the_requested_manifest_and_its_own_backup_members() {
    let home = Home::new("undo-set-identity");
    let destination = home.skill(&home.path(&[".claude", "skills", "gh"]), "keep");
    let mut other_entry = removal_set(&home, "other", &destination);
    let other_backup = other_entry.backup_path.take().unwrap();
    write(&home, "other", vec![other_entry.clone()]);

    let requested = home.backups.join("requested");
    symlink_directory(&home.backups.join("other"), &requested);
    let redirected = run(&home, "requested");
    assert!(
        matches!(&redirected, Err(UndoError::Missing(_))),
        "expected the redirected set to be missing | received {redirected:?}"
    );
    assert!(destination.join("SKILL.md").exists());

    #[cfg(unix)]
    std::fs::remove_file(&requested).unwrap();
    #[cfg(windows)]
    std::fs::remove_dir(&requested).unwrap();
    std::fs::create_dir(&requested).unwrap();
    std::fs::copy(
        home.backups.join("other").join("manifest.json"),
        requested.join("manifest.json"),
    )
    .unwrap();
    let mismatched = run(&home, "requested");
    assert!(
        matches!(&mismatched, Err(UndoError::Missing(_))),
        "expected the mismatched manifest to be missing | received {mismatched:?}"
    );

    other_entry.backup_path = Some(other_backup);
    write(&home, "requested", vec![other_entry]);
    std::fs::remove_dir_all(&destination).unwrap();
    let report = run(&home, "requested").unwrap();
    assert_eq!(
        report
            .skipped
            .iter()
            .map(|entry| entry.reason)
            .collect::<Vec<_>>(),
        ["backup-missing"],
        "expected the other set's member to be skipped | received {report:?}"
    );
    assert!(!destination.exists());
}

#[cfg(unix)]
#[test]
fn undo_uses_the_same_configured_backup_root_spelling_as_the_writer() {
    let mut home = Home::new("undo-normalized-backup-root");
    let physical = home.scratch.join("physical");
    std::fs::create_dir_all(physical.join("nested")).unwrap();
    std::fs::create_dir(physical.join("backups")).unwrap();
    let redirect = home.scratch.join("redirect");
    symlink_directory(&physical.join("nested"), &redirect);
    home.store.root = format!("{}/../backups", redirect.display());

    let destination = home.skill(&home.path(&[".claude", "skills", "gh"]), "original");
    let entry = removal_set(&home, "set", &destination);
    write(&home, "set", vec![entry]);
    std::fs::remove_dir_all(&destination).unwrap();
    let outcome = run(&home, "set");
    assert!(
        matches!(&outcome, Ok(report) if report.restored.len() == 1),
        "expected undo to read the backup where the store wrote it | received {outcome:?}"
    );
    assert!(destination.join("SKILL.md").exists());
}

#[test]
fn a_redirected_destination_ancestor_refuses_restore_and_removal() {
    for had_backup in [true, false] {
        let home = Home::new("undo-redirected-destination");
        let ancestor = home.path(&[".claude", "skills", "nested"]);
        let destination = home.skill(&ancestor.join("gh"), "original");
        let mut entry = removal_set(&home, "set", &destination);
        if !had_backup {
            entry.backup_path = None;
        }
        write(&home, "set", vec![entry]);

        // A raw filesystem operation on the recorded path now reaches
        // outside the registry location, without changing the written hash.
        let outside = home.scratch.join("outside-location");
        let outside_skill = home.skill(&outside.join("gh"), "original");
        let outside_before = std::fs::read(outside_skill.join("SKILL.md")).unwrap();
        std::fs::remove_dir_all(&ancestor).unwrap();
        symlink_directory(&outside, &ancestor);

        let outcome = run(&home, "set");
        assert!(
            matches!(&outcome, Err(UndoError::Refused(error)) if error.reason == WriteFailure::PathEscape),
            "expected PathEscape for a redirected destination | received {outcome:?}"
        );
        assert_eq!(
            std::fs::read(outside_skill.join("SKILL.md")).unwrap(),
            outside_before
        );
    }
}

#[test]
fn a_redirected_backup_ancestor_is_skipped_as_missing() {
    use std::path::Path;

    let home = Home::new("undo-redirected-backup");
    let destination = home.skill(&home.path(&[".claude", "skills", "gh"]), "original");
    let entry = removal_set(&home, "set", &destination);
    let member_parent = Path::new(entry.backup_path.as_deref().unwrap())
        .parent()
        .unwrap()
        .to_owned();
    write(&home, "set", vec![entry]);

    let outside = home.scratch.join("outside-backup");
    home.skill(&outside.join("gh"), "planted backup content");
    std::fs::remove_dir_all(&destination).unwrap();
    std::fs::remove_dir_all(&member_parent).unwrap();
    symlink_directory(&outside, &member_parent);

    let report = run(&home, "set").unwrap();
    assert_eq!(
        report
            .skipped
            .iter()
            .map(|entry| entry.reason)
            .collect::<Vec<_>>(),
        ["backup-missing"],
        "expected the redirected member to be skipped | received {report:?}"
    );
    assert!(
        !destination.exists(),
        "outside content must never be restored"
    );
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

#[cfg(unix)]
#[test]
fn a_fifo_at_a_file_destination_is_refused_before_hashing() {
    use crate::library::mutation::hashing::HashError;
    use nix::sys::stat::Mode;
    use nix::unistd::mkfifo;

    let home = Home::new("undo-fifo-destination");
    let destination = home.path(&[".claude", "CLAUDE.md"]);
    std::fs::write(&destination, "original").unwrap();
    let hash = home.hash(&destination, ResourceKind::File);
    let destination_path = destination.to_string_lossy().into_owned();
    write(
        &home,
        "set",
        vec![BackupEntry {
            location_id: "claude-instructions".into(),
            slug: "global".into(),
            kind: ResourceKind::File,
            resolved_path: resolve_through_existing_ancestor(&destination_path).unwrap(),
            destination_path,
            backup_path: None,
            written_content_hash: hash,
            resource_key: None,
        }],
    );
    std::fs::remove_file(&destination).unwrap();
    mkfifo(&destination, Mode::S_IRUSR | Mode::S_IWUSR).unwrap();
    home.hasher.answer_once(
        &destination.to_string_lossy(),
        Err(HashError::Io("attempted to open FIFO for hashing".into())),
    );

    let outcome = run(&home, "set");
    assert!(
        matches!(&outcome, Err(UndoError::Refused(error)) if error.reason == WriteFailure::UnexpectedEntryType),
        "expected the FIFO to be refused before hashing | received {outcome:?}"
    );
}

#[test]
fn an_existing_destination_with_an_unavailable_hash_is_left_alone() {
    use crate::library::mutation::hashing::HashError;

    for had_backup in [true, false] {
        let home = Home::new("undo-unverifiable");
        let destination = home.skill(&home.path(&[".claude", "skills", "gh"]), "original");
        let mut entry = removal_set(&home, "set", &destination);
        if !had_backup {
            entry.backup_path = None;
        }
        write(&home, "set", vec![entry]);
        let current = destination.join("SKILL.md");
        std::fs::write(&current, "new contents with an unreadable hash").unwrap();
        home.hasher.answer_once(
            &destination.to_string_lossy(),
            Err(HashError::Io("fixture hash read failed".into())),
        );

        let outcome = run(&home, "set");
        assert!(
            matches!(&outcome, Err(UndoError::Failed(error)) if error.contains("fixture hash read failed")),
            "expected an unverifiable destination to be refused | received {outcome:?}"
        );
        assert_eq!(
            std::fs::read_to_string(current).unwrap(),
            "new contents with an unreadable hash"
        );
    }
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
    let stopped = execute_undo(
        "set",
        &home.store,
        home.hasher.as_ref(),
        &home.env,
        &interrupted,
    );
    assert!(
        matches!(&stopped, Err(UndoError::Interrupted(Interrupt::Cancelled, partial)) if partial.skipped.is_empty()),
        "expected an interruption before the first entry | received {stopped:?}"
    );
}

/// An undo interrupted between entries reports what it already restored.
#[test]
fn an_interrupted_undo_reports_what_it_already_restored() {
    let home = Home::new("undo-interrupted-partial");
    let first = home.skill(&home.path(&[".claude", "skills", "gh"]), "one");
    let second = home.skill(&home.path(&[".agents", "skills", "gh"]), "two");
    let mut entries = vec![removal_set(&home, "set", &first)];
    let agents = removal_set_in_location(&home, "set", &second, "agents-skills");
    entries.push(agents);
    std::fs::remove_dir_all(&first).unwrap();
    std::fs::remove_dir_all(&second).unwrap();
    write(&home, "set", entries);
    let checks = std::sync::atomic::AtomicUsize::new(0);
    let interrupted = || {
        (checks.fetch_add(1, std::sync::atomic::Ordering::SeqCst) >= 1)
            .then_some(Interrupt::Cancelled)
    };
    let stopped = execute_undo(
        "set",
        &home.store,
        home.hasher.as_ref(),
        &home.env,
        &interrupted,
    );
    let Err(UndoError::Interrupted(Interrupt::Cancelled, partial)) = stopped else {
        panic!("expected an interrupted undo | received {stopped:?}");
    };
    assert_eq!(
        partial
            .restored
            .iter()
            .map(|entry| entry.location_id.as_str())
            .collect::<Vec<_>>(),
        vec!["agents-skills"],
        "entries are undone newest first, and the report names the one that landed"
    );
    assert!(second.exists() && !first.exists());
}

#[test]
fn an_unknown_location_is_refused_rather_than_guessed() {
    let home = Home::new("undo-unknown-location");
    let destination = home.skill(&home.path(&[".claude", "skills", "gh"]), "body");
    let mut entry = removal_set(&home, "set", &destination);
    entry.location_id = "not-a-location".into();
    write(&home, "set", vec![entry]);
    assert!(matches!(
        run(&home, "set"),
        Err(UndoError::Refused(error)) if error.reason == WriteFailure::UnsupportedLocation
            && error.message.contains("not-a-location")
    ));
}
