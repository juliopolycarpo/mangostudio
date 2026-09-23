//! TypeScript-written backup sets, consumed by this port: the TS→Rust half
//! of backup compatibility. Replays the `backups` section of
//! `tests/fixtures/ts-library/corpus.json`, which
//! `apps/runtime/scripts/library-backup-fixtures.ts` records from the real
//! TypeScript write engines (a propagation with an overwrite and a create,
//! a transferred directory tree, a pinned removal, and a v1 manifest).
//!
//! The snapshot taken right after those writes is rebuilt here byte for
//! byte — manifests included, with only the scratch root and separator
//! substituted for this machine — and then listed and undone by the Rust
//! store. Every expectation is what TypeScript answered from the same
//! snapshot; none is restated. Regenerate with
//! `bun run --filter @mangostudio/runtime fixtures:library`.

use std::path::Path;
use std::sync::Arc;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::Value;

use super::backup_store::{BackupManifest, BackupStore};
use super::disk::{MutationFs, NativeHasher, ResourceHasher, random_suffix};
use super::fakes::ScriptedFs;
use super::interrupt::Interrupt;
use super::paths::{ResourceKind, path_string, resolve_through_existing_ancestor};
use super::undo::execute_undo;
use crate::probing::detection::path_env::PathEnv;

fn corpus() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/ts-library/corpus.json");
    let text = std::fs::read_to_string(&path).expect("the committed TypeScript corpus is readable");
    let corpus: Value = serde_json::from_str(&text).expect("the committed corpus is JSON");
    corpus["backups"].clone()
}

/// `<root>`/`<sep>` substituted for this machine, in a plain string.
fn localize(text: &str, root: &str) -> String {
    text.replace("<root>", root)
        .replace("<sep>", std::path::MAIN_SEPARATOR_STR)
}

/// The same substitution inside JSON text, escaped as JSON escapes it.
fn localize_json(text: &str, root: &str) -> String {
    let escape = |value: &str| {
        let quoted = serde_json::to_string(value).unwrap();
        quoted[1..quoted.len() - 1].to_string()
    };
    text.replace("<root>", &escape(root))
        .replace("<sep>", &escape(std::path::MAIN_SEPARATOR_STR))
}

fn localize_value(value: &Value, root: &str) -> Value {
    match value {
        Value::String(text) => Value::String(localize(text, root)),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| localize_value(item, root))
                .collect(),
        ),
        Value::Object(members) => Value::Object(
            members
                .iter()
                .map(|(key, item)| (key.clone(), localize_value(item, root)))
                .collect(),
        ),
        other => other.clone(),
    }
}

fn snapshot(root: &Path, under: &Path) -> Vec<(String, Vec<u8>)> {
    let mut files = Vec::new();
    let mut pending = vec![under.to_path_buf()];
    while let Some(dir) = pending.pop() {
        for entry in std::fs::read_dir(&dir).unwrap().filter_map(Result::ok) {
            let path = entry.path();
            let file_type = entry.file_type().unwrap();
            if file_type.is_dir() {
                pending.push(path);
            } else if file_type.is_file() {
                let relative: Vec<String> = path
                    .strip_prefix(root)
                    .unwrap()
                    .components()
                    .map(|part| part.as_os_str().to_string_lossy().into_owned())
                    .collect();
                files.push((relative.join("/"), std::fs::read(&path).unwrap()));
            }
        }
    }
    files.sort();
    files
}

struct Replay {
    _scratch: crate::test_support::ScratchDir,
    root: String,
    store: BackupStore,
    env: PathEnv,
}

/// Rebuilds the post-write snapshot under a scratch root spelled the way
/// this machine's realpath spells it, so logical and resolved paths agree.
fn replay(corpus: &Value) -> Replay {
    let scratch = crate::test_support::scratch_dir("library-ts-backups");
    let root = resolve_through_existing_ancestor(&path_string(&scratch)).unwrap();
    for file in corpus["afterWrites"].as_array().unwrap() {
        let target = file["path"]
            .as_str()
            .unwrap()
            .split('/')
            .fold(Path::new(&root).to_path_buf(), |path, part| path.join(part));
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        match file["template"].as_str() {
            Some(template) => std::fs::write(&target, localize_json(template, &root)).unwrap(),
            None => std::fs::write(
                &target,
                STANDARD.decode(file["base64"].as_str().unwrap()).unwrap(),
            )
            .unwrap(),
        }
    }
    let fs = ScriptedFs::new();
    let backups = Path::new(&root).join("backups");
    for (id, mtime) in corpus["setMtimesMs"].as_object().unwrap() {
        fs.pin_mtime(&backups.join(id), mtime.as_f64().unwrap());
    }
    let store = BackupStore {
        fs: fs as Arc<dyn MutationFs>,
        root: path_string(&backups),
        platform: crate::health::node_platform().to_string(),
        retention_count: corpus["listing"]["retentionCount"].as_f64().unwrap(),
        retention_bytes: super::backup_store::DEFAULT_RETENTION_BYTES,
        now_ms: Arc::new(|| 0.0),
        random_suffix: Arc::new(random_suffix),
    };
    let env = PathEnv {
        platform: crate::health::node_platform().to_string(),
        home_dir: path_string(&Path::new(&root).join("home")),
        env: Default::default(),
    };
    Replay {
        _scratch: scratch,
        root,
        store,
        env,
    }
}

#[test]
fn every_typescript_manifest_parses_as_the_same_set() {
    let corpus = corpus();
    let replay = replay(&corpus);
    for undo in corpus["undos"].as_array().unwrap() {
        let backup_id = undo["backupId"].as_str().unwrap();
        let manifest: Option<BackupManifest> = replay.store.read_manifest(backup_id).unwrap();
        let manifest = manifest.unwrap_or_else(|| {
            panic!("expected TypeScript set {backup_id:?} to parse | received no manifest")
        });
        assert_eq!(manifest.backup_id, backup_id);
        if manifest.version != 3 {
            continue;
        }
        let written = std::fs::read_to_string(
            Path::new(&replay.store.root)
                .join(backup_id)
                .join("manifest.json"),
        )
        .unwrap();
        assert_eq!(
            format!("{}\n", manifest.to_json().to_pretty()),
            written,
            "expected Rust to write TypeScript's exact bytes for {backup_id}"
        );
    }
}

#[test]
fn the_rust_listing_of_a_typescript_store_matches_typescript() {
    let corpus = corpus();
    let replay = replay(&corpus);
    let rows = replay.store.list().unwrap();
    let expected = corpus["listing"]["sets"].as_array().unwrap();
    assert_eq!(rows.len(), expected.len(), "received {rows:?}");
    for (row, expected) in rows.iter().zip(expected) {
        let mut actual = serde_json::to_value(row).unwrap();
        let manifest_bytes = std::fs::metadata(
            Path::new(&replay.store.root)
                .join(&row.backup_id)
                .join("manifest.json"),
        )
        .unwrap()
        .len();
        let size = actual
            .as_object_mut()
            .unwrap()
            .remove("sizeBytes")
            .unwrap()
            .as_u64()
            .unwrap();
        actual["sizeBytesWithoutManifest"] = (size - manifest_bytes).into();
        assert_eq!(
            &actual, expected,
            "expected the TypeScript listing row | received the Rust row"
        );
    }
}

#[test]
fn rust_undo_of_typescript_sets_matches_typescript_report_and_tree() {
    let corpus = corpus();
    let replay = replay(&corpus);
    let never = || None::<Interrupt>;
    for undo in corpus["undos"].as_array().unwrap() {
        let backup_id = undo["backupId"].as_str().unwrap();
        let report = execute_undo(backup_id, &replay.store, &NativeHasher, &replay.env, &never)
            .unwrap_or_else(|error| panic!("expected {backup_id:?} to undo | received {error:?}"));
        assert_eq!(
            serde_json::to_value(&report).unwrap(),
            localize_value(&undo["report"], &replay.root),
            "expected TypeScript's undo report for {backup_id}"
        );
    }
    let root = Path::new(&replay.root);
    let actual = snapshot(root, &root.join("home"));
    let expected: Vec<(String, Vec<u8>)> = corpus["afterUndo"]
        .as_array()
        .unwrap()
        .iter()
        .map(|file| {
            (
                file["path"].as_str().unwrap().to_string(),
                STANDARD.decode(file["base64"].as_str().unwrap()).unwrap(),
            )
        })
        .collect();
    assert_eq!(
        actual
            .iter()
            .map(|(path, _)| path.as_str())
            .collect::<Vec<_>>(),
        expected
            .iter()
            .map(|(path, _)| path.as_str())
            .collect::<Vec<_>>(),
        "expected the tree TypeScript left after undo"
    );
    assert_eq!(actual, expected, "every restored byte matches");

    // The restored originals are the documents TypeScript hashed before the
    // writes: a normal document hashes identically on both runtimes.
    for entry in corpus["hashes"].as_array().unwrap() {
        let path = entry["path"]
            .as_str()
            .unwrap()
            .split('/')
            .fold(root.join("home"), |path, part| path.join(part));
        let kind = ResourceKind::parse(entry["kind"].as_str().unwrap()).unwrap();
        assert_eq!(
            NativeHasher.hash_at(&path_string(&path), kind).unwrap(),
            entry["contentHash"].as_str().unwrap(),
            "expected TypeScript's hashResourceAt for {path:?}"
        );
    }
}
