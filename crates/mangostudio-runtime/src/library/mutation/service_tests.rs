//! The write lane through its handlers: argument refusals before any
//! effect, consent (`library.backups` needs library only; the four writes
//! also need fsWrite), the owner that serializes one backup root, and the
//! three cancellation regimes — before the owner, under the owner before
//! the first effect, and during effects.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use mango_protocol::error::codes;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::*;
use crate::library::mutation::disk::CopyPurpose;
use crate::library::mutation::fakes::{FsOp, ScriptedFs, ScriptedHasher};
use crate::probing::host::compose_runtime_path_env;
use crate::runtime_home::RuntimeSlot;
use crate::test_support::{ScratchDir, scratch_dir};

const SKILL: &str = "---\nname: gh\ndescription: d\n---\nbody\n";

struct Lane {
    service: Arc<MutationService>,
    fs: Arc<ScriptedFs>,
    home: std::path::PathBuf,
    backups: String,
    consent_home: ScratchDir,
    _scratch: ScratchDir,
}

fn lane(name: &str) -> Lane {
    let scratch = scratch_dir(name);
    let consent_home = scratch_dir("library-write-consent");
    let home = scratch.join("home");
    std::fs::create_dir_all(home.join(".claude").join("skills")).unwrap();
    let fs = ScriptedFs::new();
    let home_text = home.to_string_lossy().into_owned();
    let service = MutationService {
        consent: Arc::new(ConsentSource::new(
            RuntimeSlot::Host,
            consent_home.to_path_buf(),
        )),
        path_env: Arc::new(move |overrides| {
            compose_runtime_path_env(
                HashMap::new(),
                home_text.clone(),
                crate::health::node_platform(),
                overrides,
            )
        }),
        fs: Arc::clone(&fs) as Arc<dyn MutationFs>,
        hasher: ScriptedHasher::new(),
        owners: PathLocks::new(),
        platform: crate::health::node_platform().to_string(),
        now_ms: Arc::new(|| 1_758_624_944_087.0),
        random_suffix: Arc::new(random_suffix),
    };
    Lane {
        service: Arc::new(service),
        fs,
        backups: scratch.join("backups").to_string_lossy().into_owned(),
        home,
        consent_home,
        _scratch: scratch,
    }
}

fn allow(lane: &Lane, allow: Value) {
    crate::runtime_home::write_runtime_slot_config(
        RuntimeSlot::Host,
        &lane.consent_home,
        &[("allow", Some(allow))],
    )
    .unwrap();
}

/// A one-file apply of `CLAUDE.md` carrying `body`.
fn apply_params(lane: &Lane, body: &str) -> ApplyParams {
    let path = lane.home.join(".claude").join("CLAUDE.md");
    serde_json::from_value(json!({
        "backupRoot": lane.backups,
        "operations": [{
            "resourceKey": "instruction:global",
            "locationId": "claude-instructions",
            "slug": "global",
            "operation": "create",
            "kind": "file",
            "expectedContentHash": crate::library::hash::hash_file_bytes(body.as_bytes()),
            "destinationRoot": path,
            "contentRef": "c1",
        }],
        "contents": { "c1": STANDARD.encode(body) },
    }))
    .unwrap()
}

fn store_params(lane: &Lane) -> StoreParams {
    serde_json::from_value(json!({ "backupRoot": lane.backups })).unwrap()
}

fn claude_md(lane: &Lane) -> std::path::PathBuf {
    lane.home.join(".claude").join("CLAUDE.md")
}

#[tokio::test]
async fn malformed_frames_are_refused_before_any_effect() {
    let lane = lane("library-write-arguments");
    let mut relative = apply_params(&lane, "x");
    relative.backup_root = "backups".into();
    let mut missing = apply_params(&lane, "x");
    missing.contents = None;
    let mut not_base64 = apply_params(&lane, "x");
    not_base64.contents = Some(HashMap::from([("c1".to_string(), "***".to_string())]));
    let mut no_source: ApplyParams = apply_params(&lane, "x");
    no_source.operations[0].kind = "directory".into();
    let cases = [
        (relative, "requires an absolute backupRoot"),
        (missing, "names no content in this frame"),
        (not_base64, "is not base64"),
        (no_source, "requires sourceDir or files"),
    ];
    for (params, expected) in cases {
        let error = lane
            .service
            .apply(params, CancellationToken::new())
            .await
            .unwrap_err();
        assert_eq!(error.details.as_ref().unwrap()["kind"], "tool_argument");
        assert!(
            error.message.contains(expected),
            "expected a refusal containing {expected:?} | received {:?}",
            error.message
        );
    }
    assert!(!std::path::Path::new(&lane.backups).exists());
    assert!(!claude_md(&lane).exists());
}

/// `library.backups` is a read: callable with library consent alone
/// (the `readonly` preset), while every write is refused as a consent
/// denial naming fsWrite, with nothing written.
#[tokio::test]
async fn readonly_consent_lists_backups_and_refuses_every_write() {
    let lane = lane("library-write-readonly");
    allow(&lane, json!({ "library": true, "fsWrite": false }));
    let listed = lane
        .service
        .backups(store_params(&lane), CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(listed, json!({ "sets": [] }));
    let undo: UndoParams =
        serde_json::from_value(json!({ "backupRoot": lane.backups, "backupId": "x" })).unwrap();
    let remove: RemoveParams =
        serde_json::from_value(json!({ "backupRoot": lane.backups, "operations": [] })).unwrap();
    let refusals = [
        lane.service
            .apply(apply_params(&lane, "x"), CancellationToken::new())
            .await
            .err(),
        lane.service
            .remove(remove, CancellationToken::new())
            .await
            .err(),
        lane.service
            .undo(undo, CancellationToken::new())
            .await
            .err(),
        lane.service
            .gc(store_params(&lane), CancellationToken::new())
            .await
            .err(),
    ];
    for refusal in refusals {
        let refusal = refusal.expect("a write without fsWrite must be refused");
        assert_eq!(refusal.code, codes::DENIED, "received {refusal:?}");
        assert_eq!(refusal.details.unwrap()["missing"], json!(["fsWrite"]));
    }
    assert!(!claude_md(&lane).exists());

    allow(&lane, json!({ "library": false }));
    let denied = lane
        .service
        .backups(store_params(&lane), CancellationToken::new())
        .await
        .unwrap_err();
    assert_eq!(denied.details.unwrap()["missing"], json!(["library"]));
}

#[tokio::test]
async fn an_apply_and_its_undo_round_trip_through_the_handlers() {
    let lane = lane("library-write-round-trip");
    std::fs::write(claude_md(&lane), "old").unwrap();
    let result = lane
        .service
        .apply(apply_params(&lane, "new"), CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(result["failed"], json!([]), "received {result}");
    assert_eq!(std::fs::read_to_string(claude_md(&lane)).unwrap(), "new");
    let backup_id = result["backupId"].as_str().unwrap().to_string();
    let listed = lane
        .service
        .backups(store_params(&lane), CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(listed["sets"][0]["backupId"], json!(backup_id));
    assert_eq!(listed["sets"][0]["operation"], "propagation");
    assert!(
        std::path::Path::new(&lane.backups)
            .join(&backup_id)
            .exists(),
        "listing never prunes"
    );
    let undo: UndoParams =
        serde_json::from_value(json!({ "backupRoot": lane.backups, "backupId": backup_id }))
            .unwrap();
    let undone = lane
        .service
        .undo(undo, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(
        undone["restored"].as_array().unwrap().len(),
        1,
        "received {undone}"
    );
    assert_eq!(std::fs::read_to_string(claude_md(&lane)).unwrap(), "old");
}

#[tokio::test]
async fn a_missing_set_is_the_kind_the_hub_answers_404_for() {
    let lane = lane("library-write-missing");
    for backup_id in ["never-written", "../escape"] {
        let undo: UndoParams =
            serde_json::from_value(json!({ "backupRoot": lane.backups, "backupId": backup_id }))
                .unwrap();
        let error = lane
            .service
            .undo(undo, CancellationToken::new())
            .await
            .unwrap_err();
        assert_eq!(error.code, codes::INTERNAL);
        assert_eq!(
            error.details.unwrap()["kind"],
            json!(LIBRARY_BACKUP_MISSING_KIND),
            "expected {backup_id:?} to be reported missing"
        );
    }
}

#[tokio::test]
async fn cancellation_before_the_owner_is_held_refuses_with_no_effect() {
    let lane = lane("library-write-cancel-early");
    let cancel = CancellationToken::new();
    cancel.cancel();
    let error = lane
        .service
        .apply(apply_params(&lane, "new"), cancel)
        .await
        .unwrap_err();
    assert_eq!(error.code, codes::CANCELLED);
    assert!(!claude_md(&lane).exists());
    assert!(!std::path::Path::new(&lane.backups).exists());
}

/// The owner-recheck fixture: B queues behind A on the root lock, consent
/// is withdrawn while A runs, A finishes, and B is refused under the owner
/// with no effects — authority is re-read after ownership, not before.
#[tokio::test]
async fn a_queued_write_rechecks_consent_under_the_owner() {
    let lane = lane("library-write-owner-recheck");
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(AtomicBool::new(false));
    {
        let entered = Arc::clone(&entered);
        let release = Arc::clone(&release);
        lane.fs.before(FsOp::WriteFile, "CLAUDE.md", move |_| {
            entered.notify_one();
            while !release.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(5));
            }
        });
    }
    let first = tokio::spawn({
        let service = Arc::clone(&lane.service);
        let params = apply_params(&lane, "first");
        async move { service.apply(params, CancellationToken::new()).await }
    });
    entered.notified().await;
    let second = tokio::spawn({
        let service = Arc::clone(&lane.service);
        let mut params = apply_params(&lane, "second");
        params.operations[0].slug = "global".into();
        async move { service.apply(params, CancellationToken::new()).await }
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(
        !second.is_finished(),
        "the second write waits for the owner"
    );
    allow(&lane, json!({ "fsWrite": false }));
    release.store(true, Ordering::SeqCst);
    let first = first.await.unwrap().unwrap();
    assert_eq!(
        first["failed"],
        json!([]),
        "the running write completes: {first}"
    );
    let second = second.await.unwrap().unwrap_err();
    assert_eq!(second.code, codes::DENIED, "received {second:?}");
    assert_eq!(std::fs::read_to_string(claude_md(&lane)).unwrap(), "first");
}

/// Cancellation that lands while the owner is waiting for a running
/// mutation refuses the waiter; cancellation of the running one lets its
/// current operation finish and compensates at the next boundary, and a
/// `gc` queued behind it cannot collect the set it is filling.
#[tokio::test]
async fn cancel_versus_commit_retains_the_owner_until_the_boundary() {
    let lane = lane("library-write-cancel-commit");
    std::fs::create_dir_all(lane.home.join(".agents").join("skills")).unwrap();
    let source = lane.home.join("source");
    std::fs::create_dir_all(&source).unwrap();
    std::fs::write(source.join("SKILL.md"), SKILL).unwrap();
    let hash = crate::library::mutation::disk::NativeHasher
        .hash_at(&source.to_string_lossy(), ResourceKind::Directory)
        .unwrap();
    let operation = |location: &str, root: std::path::PathBuf| {
        json!({
            "resourceKey": "skill:gh", "locationId": location, "slug": "gh",
            "operation": "create", "kind": "directory", "expectedContentHash": hash,
            "destinationRoot": root, "sourceDir": source,
        })
    };
    let params: ApplyParams = serde_json::from_value(json!({
        "backupRoot": lane.backups,
        "operations": [
            operation("claude-skills", lane.home.join(".claude").join("skills")),
            operation("agents-skills", lane.home.join(".agents").join("skills")),
        ],
    }))
    .unwrap();
    let cancel = CancellationToken::new();
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(AtomicBool::new(false));
    {
        let (entered, release, cancel) =
            (Arc::clone(&entered), Arc::clone(&release), cancel.clone());
        lane.fs
            .before(FsOp::Copy(CopyPurpose::Stage), ".claude", move |_| {
                // Mid-effect: the first destination is being staged.
                cancel.cancel();
                entered.notify_one();
                while !release.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(5));
                }
            });
    }
    let running = tokio::spawn({
        let service = Arc::clone(&lane.service);
        let cancel = cancel.clone();
        async move { service.apply(params, cancel).await }
    });
    entered.notified().await;
    let waiter_cancel = CancellationToken::new();
    let waiter = tokio::spawn({
        let service = Arc::clone(&lane.service);
        let params = apply_params(&lane, "late");
        let waiter_cancel = waiter_cancel.clone();
        async move { service.apply(params, waiter_cancel).await }
    });
    let gc = tokio::spawn({
        let service = Arc::clone(&lane.service);
        let params: StoreParams = serde_json::from_value(json!({
            "backupRoot": lane.backups, "retentionCount": 1,
            "purgeBackupIds": ["2025-09-23T10-55-44.087Z-in-flight"],
        }))
        .unwrap();
        async move { service.gc(params, CancellationToken::new()).await }
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    waiter_cancel.cancel();
    let refused = waiter.await.unwrap().unwrap_err();
    assert_eq!(
        refused.code,
        codes::CANCELLED,
        "the waiter is refused: {refused:?}"
    );
    assert!(!gc.is_finished(), "gc waits for the owner");
    release.store(true, Ordering::SeqCst);

    let result = running.await.unwrap().unwrap();
    assert_eq!(result["applied"], json!([]), "received {result}");
    assert_eq!(result["partial"], json!(false));
    assert_eq!(result["failed"][0]["locationId"], "agents-skills");
    assert_eq!(
        result["failed"][0]["message"],
        Interrupt::Cancelled.message()
    );
    assert!(
        !lane.home.join(".claude").join("skills").join("gh").exists(),
        "the operation that was mid-effect finished, then was compensated"
    );
    assert!(gc.await.unwrap().is_ok());
    assert!(
        !claude_md(&lane).exists(),
        "the refused waiter wrote nothing"
    );
}

#[tokio::test]
async fn gc_purges_and_prunes_under_the_owner() {
    let lane = lane("library-write-gc");
    let first = lane
        .service
        .apply(apply_params(&lane, "one"), CancellationToken::new())
        .await
        .unwrap();
    let backup_id = first["backupId"].as_str().unwrap().to_string();
    let params: StoreParams = serde_json::from_value(
        json!({ "backupRoot": lane.backups, "purgeBackupIds": [backup_id, "gone"] }),
    )
    .unwrap();
    let collected = lane
        .service
        .gc(params, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(
        collected,
        json!({ "purged": [backup_id, "gone"], "pruned": [] })
    );
    let listed = lane
        .service
        .backups(store_params(&lane), CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(listed, json!({ "sets": [] }));
}
