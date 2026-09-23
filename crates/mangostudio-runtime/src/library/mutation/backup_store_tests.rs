//! Ports of `apps/api/tests/unit/modules/library/backup-store.test.ts` and
//! `apps/shared/tests/unit/library/machine/backup-store.test.ts`, plus the
//! manifest-less retention rule this store adds (see the module docs).

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use serde_json::{Value, json};

use super::*;
use crate::library::mutation::fakes::ScriptedFs;
use crate::library::mutation::paths::path_string;
use crate::test_support::{ScratchDir, scratch_dir};

struct Fixture {
    _scratch: ScratchDir,
    root: std::path::PathBuf,
    fs: Arc<ScriptedFs>,
    store: BackupStore,
}

fn fixture(name: &str) -> Fixture {
    let scratch = scratch_dir(name);
    let root = scratch.join("backups");
    let fs = ScriptedFs::new();
    let counter = Arc::new(AtomicUsize::new(0));
    let store = BackupStore {
        fs: Arc::clone(&fs) as Arc<dyn MutationFs>,
        root: path_string(&root),
        platform: crate::health::node_platform().to_string(),
        retention_count: DEFAULT_RETENTION_COUNT,
        retention_bytes: DEFAULT_RETENTION_BYTES,
        now_ms: Arc::new(|| 1_758_624_944_087.0),
        random_suffix: Arc::new(move || format!("{:016x}", counter.fetch_add(1, Ordering::SeqCst))),
    };
    Fixture {
        _scratch: scratch,
        root,
        fs,
        store,
    }
}

fn entry(resource_key: &str) -> BackupEntry {
    let slug = resource_key.split(':').nth(1).unwrap_or(resource_key);
    BackupEntry {
        location_id: "claude-skills".into(),
        slug: slug.into(),
        kind: ResourceKind::Directory,
        destination_path: format!("/home/test/.claude/skills/{slug}"),
        resolved_path: format!("/home/test/.claude/skills/{slug}"),
        backup_path: None,
        written_content_hash: "hash".into(),
        resource_key: Some(resource_key.into()),
    }
}

fn manifest(backup_id: &str, entries: Vec<BackupEntry>) -> BackupManifest {
    BackupManifest {
        version: 3,
        backup_id: backup_id.into(),
        created_at_ms: 1.0,
        entries,
        operation: Some(SetOperation::Propagation),
        environment_id: None,
        pinned: None,
        last_copy_resource_keys: None,
    }
}

/// A set directory holding one `claude-skills/<slug>` file of `bytes`
/// bytes, with a manifest unless `with_manifest` is false, and a pinned
/// mtime that orders it.
fn seed(fixture: &Fixture, id: &str, mtime_ms: f64, bytes: usize, set: Option<BackupManifest>) {
    let dir = fixture.root.join(id);
    std::fs::create_dir_all(dir.join("claude-skills")).unwrap();
    std::fs::write(dir.join("claude-skills").join("gh"), vec![b'x'; bytes]).unwrap();
    if let Some(set) = set {
        fixture.store.write_manifest(&set).unwrap();
    }
    fixture.fs.pin_mtime(&dir, mtime_ms);
}

fn ids(fixture: &Fixture) -> Vec<String> {
    let mut ids: Vec<String> = std::fs::read_dir(&fixture.root)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    ids.sort();
    ids
}

#[test]
fn a_backup_id_is_the_iso_timestamp_and_a_hex_suffix_in_one_segment() {
    let fixture = fixture("backup-id");
    let id = fixture.store.create_backup_id();
    assert_eq!(id, "2025-09-23T10-55-44.087Z-0000000000000000");
    assert!(is_valid_backup_id(&id));
    for escaping in ["", ".", "..", "../x", "a/b", "a\\b", ".hidden"] {
        assert!(
            !is_valid_backup_id(escaping),
            "expected {escaping:?} to be refused as a backup id"
        );
        assert_eq!(
            fixture.store.set_path(escaping),
            Err(StoreError::InvalidId(escaping.into()))
        );
    }
    assert!(is_valid_backup_id("a.b-c_D9"));
}

#[test]
fn iso_strings_match_date_to_iso_string() {
    assert_eq!(iso_string(0.0), "1970-01-01T00:00:00.000Z");
    assert_eq!(iso_string(951_782_400_000.0), "2000-02-29T00:00:00.000Z");
    assert_eq!(iso_string(4_102_444_799_999.0), "2099-12-31T23:59:59.999Z");
}

#[test]
fn backing_up_copies_the_destination_under_its_location_and_slug() {
    let fixture = fixture("backup-copy");
    let source = fixture._scratch.join("gh");
    std::fs::create_dir_all(&source).unwrap();
    std::fs::write(source.join("SKILL.md"), "before").unwrap();
    let copied = fixture
        .store
        .backup_existing(&path_string(&source), "claude-skills", "gh", "set-1")
        .unwrap();
    assert_eq!(
        Path::new(&copied),
        fixture.root.join("set-1").join("claude-skills").join("gh")
    );
    assert_eq!(
        std::fs::read_to_string(Path::new(&copied).join("SKILL.md")).unwrap(),
        "before"
    );
    assert_eq!(
        fixture
            .store
            .backup_existing(&path_string(&source), "claude-skills", "gh", "../escape"),
        Err(StoreError::InvalidId("../escape".into()))
    );
}

#[test]
fn a_manifest_round_trips_in_typescript_member_order() {
    let fixture = fixture("backup-manifest-round-trip");
    let mut set = manifest("set-1", vec![entry("skill:gh")]);
    set.entries[0].backup_path = Some("/b/set-1/claude-skills/gh".into());
    set.environment_id = Some("box".into());
    set.pinned = Some(true);
    set.last_copy_resource_keys = Some(vec!["skill:gh".into()]);
    fixture.store.write_manifest(&set).unwrap();
    assert_eq!(fixture.store.read_manifest("set-1").unwrap(), Some(set));
    let text = std::fs::read_to_string(fixture.root.join("set-1").join("manifest.json")).unwrap();
    let order: Vec<&str> = [
        "\"version\"",
        "\"backupId\"",
        "\"createdAtMs\"",
        "\"entries\"",
        "\"locationId\"",
        "\"writtenContentHash\"",
        "\"resourceKey\"",
        "\"backupPath\"",
        "\"operation\"",
        "\"environmentId\"",
        "\"pinned\"",
        "\"lastCopyResourceKeys\"",
    ]
    .into_iter()
    .collect();
    let positions: Vec<usize> = order.iter().map(|key| text.find(key).unwrap()).collect();
    assert!(
        positions.windows(2).all(|pair| pair[0] < pair[1]),
        "expected JSON.stringify member order | received {text}"
    );
    assert!(
        text.starts_with("{\n  \"version\": 3,\n"),
        "received {text}"
    );
    assert!(text.ends_with("}\n"), "a manifest ends with a newline");
    let parsed: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(parsed["entries"][0]["kind"], json!("directory"));
}

#[test]
fn a_v1_manifest_reads_unchanged_and_lists_as_unknown() {
    let fixture = fixture("backup-manifest-v1");
    let dir = fixture.root.join("old");
    std::fs::create_dir_all(&dir).unwrap();
    let v1 = json!({
        "version": 1,
        "backupId": "old",
        "createdAtMs": 5,
        "entries": [{
            "locationId": "claude-skills", "slug": "gh", "kind": "directory",
            "destinationPath": "/d", "resolvedPath": "/d", "writtenContentHash": "h"
        }]
    });
    std::fs::write(dir.join("manifest.json"), v1.to_string()).unwrap();
    let read = fixture.store.read_manifest("old").unwrap().unwrap();
    assert_eq!(
        (read.version, read.operation, read.environment_id),
        (1, None, None)
    );
    let rows = fixture.store.list().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].operation, "unknown");
    assert!(
        rows[0].resource_keys.is_empty(),
        "a v1 set names no resources"
    );
    assert_eq!(rows[0].created_at_ms, json!(5));
}

#[test]
fn a_manifest_is_manifest_refuses_is_absent_rather_than_a_guess() {
    let fixture = fixture("backup-manifest-refused");
    let base = json!({ "version": 3, "backupId": "x", "createdAtMs": 1, "entries": [] });
    let refused = [
        ("version", json!(4)),
        ("operation", json!("install")),
        ("environmentId", Value::Null),
        ("pinned", json!("yes")),
        ("lastCopyResourceKeys", json!([1])),
        ("entries", json!([{ "locationId": "claude-skills" }])),
        ("createdAtMs", json!("1")),
    ];
    for (key, value) in refused {
        let mut candidate = base.clone();
        candidate[key] = value.clone();
        assert_eq!(
            BackupManifest::from_json(&candidate),
            None,
            "expected {key} = {value} to be refused"
        );
    }
    assert!(BackupManifest::from_json(&base).is_some());
    let dir = fixture.root.join("corrupt");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("manifest.json"), "{ not json").unwrap();
    assert_eq!(fixture.store.read_manifest("corrupt"), Ok(None));
    assert_eq!(fixture.store.read_manifest("never-written"), Ok(None));
    assert_eq!(
        fixture.store.read_manifest("../x"),
        Err(StoreError::InvalidId("../x".into())),
        "a malformed id is an error the caller maps to missing, not an absent set"
    );
}

#[test]
fn restoring_puts_the_backed_up_content_back() {
    let fixture = fixture("backup-restore");
    let destination = fixture._scratch.join("gh");
    std::fs::create_dir_all(&destination).unwrap();
    std::fs::write(destination.join("SKILL.md"), "before").unwrap();
    let backup_path = fixture
        .store
        .backup_existing(&path_string(&destination), "claude-skills", "gh", "set-1")
        .unwrap();
    std::fs::write(destination.join("SKILL.md"), "after").unwrap();
    std::fs::write(destination.join("extra.md"), "new").unwrap();
    let mut restored = entry("skill:gh");
    restored.resolved_path = path_string(&destination);
    restored.backup_path = Some(backup_path);
    fixture.store.restore_entry(&restored).unwrap();
    assert_eq!(
        std::fs::read_to_string(destination.join("SKILL.md")).unwrap(),
        "before"
    );
    assert!(
        !destination.join("extra.md").exists(),
        "a restore replaces the tree, it does not merge into it"
    );
    restored.backup_path = None;
    assert!(
        fixture
            .store
            .restore_entry(&restored)
            .unwrap_err()
            .to_string()
            .contains("has nothing to restore")
    );
}

#[test]
fn prune_keeps_the_newest_sets_up_to_the_count() {
    let mut fixture = fixture("backup-prune-count");
    for (index, id) in ["a", "b", "c"].iter().enumerate() {
        seed(&fixture, id, index as f64, 1, Some(manifest(id, vec![])));
    }
    fixture.store.retention_count = 2.0;
    fixture.store.prune(None).unwrap();
    assert_eq!(ids(&fixture), vec!["b", "c"]);
}

#[test]
fn prune_stops_retaining_once_the_byte_budget_is_spent() {
    let mut fixture = fixture("backup-prune-bytes");
    seed(&fixture, "old", 1.0, 10, Some(manifest("old", vec![])));
    seed(&fixture, "new", 2.0, 10, Some(manifest("new", vec![])));
    let manifest_bytes = std::fs::metadata(fixture.root.join("new").join("manifest.json"))
        .unwrap()
        .len() as f64;
    fixture.store.retention_bytes = 10.0 + manifest_bytes;
    fixture.store.prune(None).unwrap();
    assert_eq!(ids(&fixture), vec!["new"]);
}

#[test]
fn prune_always_keeps_the_set_the_current_apply_wrote() {
    let mut fixture = fixture("backup-prune-current");
    seed(
        &fixture,
        "current",
        1.0,
        1,
        Some(manifest("current", vec![])),
    );
    seed(&fixture, "newer", 2.0, 1, Some(manifest("newer", vec![])));
    fixture.store.retention_count = 1.0;
    fixture.store.prune(Some("current")).unwrap();
    assert_eq!(ids(&fixture), vec!["current"]);
}

#[test]
fn prune_never_deletes_a_directory_not_shaped_like_a_set() {
    let mut fixture = fixture("backup-prune-foreign");
    std::fs::create_dir_all(fixture.root.join("photos").join("2024")).unwrap();
    seed(&fixture, "a", 1.0, 1, Some(manifest("a", vec![])));
    seed(&fixture, "b", 2.0, 1, Some(manifest("b", vec![])));
    fixture.store.retention_count = 1.0;
    fixture.store.prune(None).unwrap();
    assert_eq!(ids(&fixture), vec!["b", "photos"]);
}

#[test]
fn prune_and_listing_are_quiet_before_the_first_backup() {
    let fixture = fixture("backup-prune-empty");
    assert_eq!(fixture.store.prune(None), Ok(()));
    assert_eq!(fixture.store.list(), Ok(Vec::new()));
}

#[test]
fn a_pinned_set_survives_count_eviction_and_is_charged_first() {
    let mut fixture = fixture("backup-prune-pinned");
    let mut pinned = manifest("pinned", vec![]);
    pinned.pinned = Some(true);
    seed(&fixture, "pinned", 0.0, 10, Some(pinned));
    seed(&fixture, "a", 1.0, 10, Some(manifest("a", vec![])));
    seed(&fixture, "b", 2.0, 10, Some(manifest("b", vec![])));
    fixture.store.retention_count = 1.0;
    fixture.store.prune(None).unwrap();
    assert_eq!(ids(&fixture), vec!["b", "pinned"]);

    let rows = fixture.store.list().unwrap();
    let budget: u64 = rows.iter().map(|row| row.size_bytes).sum();
    fixture.store.retention_count = 10.0;
    fixture.store.retention_bytes = (budget - 1) as f64;
    fixture.store.prune(None).unwrap();
    assert_eq!(
        ids(&fixture),
        vec!["pinned"],
        "pinned bytes are charged first, so the ordinary set is squeezed out"
    );
}

#[test]
fn prune_refuses_a_retention_count_that_keeps_nothing() {
    let mut fixture = fixture("backup-prune-invalid-count");
    seed(&fixture, "a", 1.0, 1, Some(manifest("a", vec![])));
    for count in [0.0, -1.0, 1.5, f64::NAN] {
        fixture.store.retention_count = count;
        assert_eq!(
            fixture.store.prune(None),
            Err(StoreError::InvalidRetention),
            "expected count {count} to be refused"
        );
        assert!(
            fixture.store.list().is_ok(),
            "listing never refuses a budget, whatever count {count} means"
        );
    }
}

#[test]
fn listing_reports_cost_pins_and_contents_and_agrees_with_prune() {
    let mut fixture = fixture("backup-list");
    let mut pinned = manifest(
        "pinned",
        vec![entry("skill:b"), entry("skill:a"), entry("skill:b")],
    );
    pinned.pinned = Some(true);
    pinned.last_copy_resource_keys = Some(vec!["skill:a".into()]);
    pinned.operation = Some(SetOperation::Removal);
    seed(&fixture, "pinned", 0.0, 7, Some(pinned));
    seed(
        &fixture,
        "old",
        1.0,
        3,
        Some(manifest("old", vec![entry("skill:x")])),
    );
    seed(&fixture, "new", 2.0, 3, Some(manifest("new", vec![])));
    fixture.store.retention_count = 1.0;
    let rows = fixture.store.list().unwrap();
    let summary: Vec<(&str, bool, bool, &str)> = rows
        .iter()
        .map(|row| {
            (
                row.backup_id.as_str(),
                row.pinned,
                row.evicts_next,
                row.operation,
            )
        })
        .collect();
    assert_eq!(
        summary,
        vec![
            ("new", false, false, "propagation"),
            ("old", false, true, "propagation"),
            ("pinned", true, false, "removal"),
        ],
        "newest first; exactly the set the next prune would drop is marked"
    );
    assert_eq!(rows[2].resource_keys, vec!["skill:a", "skill:b"]);
    assert_eq!(rows[2].last_copy_resource_keys, vec!["skill:a"]);
    assert_eq!(rows[2].entry_count, 3);
    assert!(rows[2].size_bytes >= 7);
    let evicting: Vec<String> = rows
        .iter()
        .filter(|row| row.evicts_next)
        .map(|row| row.backup_id.clone())
        .collect();
    fixture.store.prune(None).unwrap();
    assert!(
        evicting.iter().all(|id| !ids(&fixture).contains(id)),
        "listing and prune share one retention rule"
    );
    fixture.store.retention_count = 0.0;
    assert!(
        fixture
            .store
            .list()
            .unwrap()
            .iter()
            .all(|row| !row.pinned || !row.evicts_next),
        "a pinned set never evicts, at any budget"
    );
}

#[test]
fn an_unreadable_manifest_is_listed_with_its_size() {
    let fixture = fixture("backup-list-unreadable");
    seed(&fixture, "broken", 1.0, 4, None);
    std::fs::write(fixture.root.join("broken").join("manifest.json"), "{").unwrap();
    let rows = fixture.store.list().unwrap();
    assert_eq!(rows.len(), 1);
    assert!(!rows[0].manifest_readable);
    assert_eq!(rows[0].entry_count, 0);
    assert_eq!(
        rows[0].size_bytes, 5,
        "the manifest's own bytes are charged"
    );
    assert_eq!(rows[0].created_at_ms, json!(1));
}

/// The one deliberate difference from TypeScript: retention never evicts a
/// set without a readable manifest — an uncommitted recovery set.
#[test]
fn retention_never_evicts_an_uncommitted_recovery_set() {
    let mut fixture = fixture("backup-prune-uncommitted");
    seed(&fixture, "in-flight", 0.0, 4, None);
    seed(&fixture, "a", 1.0, 1, Some(manifest("a", vec![])));
    seed(&fixture, "b", 2.0, 1, Some(manifest("b", vec![])));
    fixture.store.retention_count = 1.0;
    let listed = fixture.store.list().unwrap();
    let in_flight = listed
        .iter()
        .find(|row| row.backup_id == "in-flight")
        .unwrap();
    assert!(
        !in_flight.evicts_next,
        "expected evictsNext false for a manifest-less set | received true"
    );
    fixture.store.prune(None).unwrap();
    assert_eq!(
        ids(&fixture),
        vec!["b", "in-flight"],
        "expected the uncommitted set to survive retention | received its eviction"
    );
    let collected = fixture.store.gc(&[]).unwrap();
    assert!(collected.pruned.is_empty(), "received {collected:?}");
    let purged = fixture.store.gc(&["in-flight".to_string()]).unwrap();
    assert_eq!(
        purged.purged,
        vec!["in-flight"],
        "an explicit purge still can"
    );
    assert_eq!(ids(&fixture), vec!["b"]);
}

#[test]
fn purge_is_explicit_and_idempotent() {
    let fixture = fixture("backup-purge");
    let mut pinned = manifest("pinned", vec![]);
    pinned.pinned = Some(true);
    seed(&fixture, "pinned", 1.0, 1, Some(pinned));
    assert_eq!(fixture.store.purge_set("pinned"), Ok(true));
    assert_eq!(fixture.store.purge_set("pinned"), Ok(false));
    assert!(ids(&fixture).is_empty());
}

#[test]
fn discarding_one_set_leaves_the_others() {
    let fixture = fixture("backup-discard");
    seed(&fixture, "a", 1.0, 1, Some(manifest("a", vec![])));
    seed(&fixture, "b", 2.0, 1, Some(manifest("b", vec![])));
    fixture.store.discard_set("a").unwrap();
    assert_eq!(ids(&fixture), vec!["b"]);
}

#[test]
fn gc_purges_named_sets_and_reports_what_retention_took() {
    let mut fixture = fixture("backup-gc");
    for (index, id) in ["a", "b", "c", "d"].iter().enumerate() {
        seed(&fixture, id, index as f64, 1, Some(manifest(id, vec![])));
    }
    fixture.store.retention_count = 2.0;
    let result = fixture
        .store
        .gc(&["d".to_string(), "gone".to_string()])
        .unwrap();
    assert_eq!(
        result,
        GcResult {
            purged: vec!["d".into(), "gone".into()],
            pruned: vec!["a".into()],
        }
    );
    assert_eq!(ids(&fixture), vec!["b", "c"]);
    fixture.store.retention_count = 10.0;
    assert_eq!(
        fixture.store.gc(&[]).unwrap(),
        GcResult::default(),
        "nothing is taken when no bound is exceeded"
    );
    assert_eq!(
        fixture.store.gc(&["../x".to_string()]),
        Err(StoreError::InvalidId("../x".into()))
    );
}

/// `DEFAULT_RETENTION_COUNT` and `DEFAULT_RETENTION_BYTES` in
/// `backup-store.ts`: ten sets, 512 MiB.
#[test]
fn retention_defaults_match_typescript() {
    assert_eq!(DEFAULT_RETENTION_COUNT, 10.0);
    assert_eq!(
        DEFAULT_RETENTION_BYTES, 536_870_912.0,
        "expected 512 MiB | received {DEFAULT_RETENTION_BYTES}"
    );
}

/// Every manifest version reads, v2 included (operation and resource keys,
/// no environment).
#[test]
fn a_v2_manifest_reads_with_its_operation_and_keys() {
    let v2 = json!({
        "version": 2,
        "backupId": "v2",
        "createdAtMs": 7,
        "operation": "removal",
        "entries": [{
            "locationId": "claude-skills", "slug": "gh", "kind": "directory",
            "destinationPath": "/d", "resolvedPath": "/d", "writtenContentHash": "h",
            "resourceKey": "skill:gh"
        }]
    });
    let read = BackupManifest::from_json(&v2)
        .unwrap_or_else(|| panic!("expected a v2 manifest to parse | received None"));
    assert_eq!(
        (read.version, read.operation, read.environment_id.as_deref()),
        (2, Some(SetOperation::Removal), None)
    );
    assert_eq!(read.entries[0].resource_key.as_deref(), Some("skill:gh"));
}

/// A fractional `createdAtMs` (a hand-written or foreign manifest) is kept
/// as written, not truncated, when the manifest is written back.
#[test]
fn a_fractional_timestamp_round_trips_unchanged() {
    let mut set = manifest("fraction", vec![]);
    set.created_at_ms = 1.5;
    let text = set.to_json().to_pretty();
    assert!(
        text.contains("\"createdAtMs\": 1.5"),
        "expected createdAtMs 1.5 | received {text}"
    );
    set.created_at_ms = 42.0;
    assert!(set.to_json().to_pretty().contains("\"createdAtMs\": 42,"));
}

/// A foreign directory under the root — one holding a plain file, one
/// holding a subdirectory that is not a location id — is not a set: it is
/// neither listed nor retained on retention's behalf.
#[test]
fn only_manifest_or_location_shaped_directories_are_sets() {
    let fixture = fixture("backup-foreign-shapes");
    std::fs::create_dir_all(fixture.root.join("notes")).unwrap();
    std::fs::write(fixture.root.join("notes").join("todo.txt"), "x").unwrap();
    std::fs::create_dir_all(fixture.root.join("photos").join("2024")).unwrap();
    seed(&fixture, "a", 1.0, 1, Some(manifest("a", vec![])));
    let listed: Vec<String> = fixture
        .store
        .list()
        .unwrap()
        .into_iter()
        .map(|row| row.backup_id)
        .collect();
    assert_eq!(
        listed,
        vec!["a"],
        "expected only the real set | received {listed:?}"
    );
}

/// Only "not found" means absent: a backup root that cannot be listed,
/// and a manifest that cannot be read, are errors rather than silence.
#[test]
fn unreadable_stores_are_errors_not_empty_answers() {
    let fixture = fixture("backup-unreadable-root");
    std::fs::create_dir_all(fixture.root.parent().unwrap()).unwrap();
    std::fs::write(&fixture.root, "a file where the root belongs").unwrap();
    assert!(
        matches!(fixture.store.list(), Err(StoreError::Io(_))),
        "expected an I/O error for a root that is a file | received {:?}",
        fixture.store.list()
    );
}

#[cfg(unix)]
#[test]
fn an_unreadable_manifest_is_an_error_not_a_missing_set() {
    use std::os::unix::fs::PermissionsExt;
    if nix::unistd::geteuid().is_root() {
        return;
    }
    let fixture = fixture("backup-unreadable-manifest");
    seed(&fixture, "locked", 1.0, 1, Some(manifest("locked", vec![])));
    let path = fixture.root.join("locked").join("manifest.json");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();
    let read = fixture.store.read_manifest("locked");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert!(
        matches!(read, Err(StoreError::Io(_))),
        "expected a permission error, not a pruned set | received {read:?}"
    );
}

/// The set an apply is writing is charged to the byte budget, and it is
/// that set — found by its id — that is charged.
#[test]
fn prune_charges_the_current_set_it_names() {
    let sizes = |fixture: &Fixture| -> std::collections::HashMap<String, f64> {
        fixture
            .store
            .list()
            .unwrap()
            .into_iter()
            .map(|row| (row.backup_id, row.size_bytes as f64))
            .collect()
    };
    // Equal-size current and newer sets, one byte short of both: the newer
    // one goes, because the current one's bytes are already spent.
    let mut fixture = fixture("backup-prune-current-bytes");
    seed(
        &fixture,
        "current",
        1.0,
        10,
        Some(manifest("current", vec![])),
    );
    seed(&fixture, "newer", 2.0, 10, Some(manifest("newer", vec![])));
    let size = sizes(&fixture);
    fixture.store.retention_bytes = size["current"] + size["newer"] - 1.0;
    fixture.store.prune(Some("current")).unwrap();
    assert_eq!(
        ids(&fixture),
        vec!["current"],
        "expected the newer set evicted"
    );

    // Exactly within budget: both stay (the budget is a sum, not a product).
    let mut fixture = self::fixture("backup-prune-current-sum");
    seed(
        &fixture,
        "current",
        1.0,
        2,
        Some(manifest("current", vec![])),
    );
    seed(&fixture, "newer", 2.0, 3, Some(manifest("newer", vec![])));
    let size = sizes(&fixture);
    fixture.store.retention_bytes = size["current"] + size["newer"];
    fixture.store.prune(Some("current")).unwrap();
    assert_eq!(ids(&fixture), vec!["current", "newer"]);

    // A large newest set that fits beside the small current set is kept: the
    // charge belongs to the named set, not to whichever set is listed first.
    let mut fixture = self::fixture("backup-prune-current-identity");
    seed(
        &fixture,
        "current",
        1.0,
        1,
        Some(manifest("current", vec![])),
    );
    seed(&fixture, "middle", 2.0, 1, Some(manifest("middle", vec![])));
    seed(&fixture, "big", 3.0, 400, Some(manifest("big", vec![])));
    let size = sizes(&fixture);
    fixture.store.retention_bytes = size["current"] + size["middle"] + size["big"];
    fixture.store.prune(Some("current")).unwrap();
    assert_eq!(ids(&fixture), vec!["big", "current", "middle"]);
}
