//! Replays `tests/fixtures/ts-library/corpus.json` — what the real
//! TypeScript library readers answered, recorded by
//! `apps/runtime/scripts/generate-library-fixtures.ts` — through this port.
//!
//! Nothing here restates an expected value: every one comes from the
//! TypeScript run. The corpus is frozen: its generator was deleted with the
//! TypeScript runtime, and CI's fixture freshness job pins its git tree.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::cache::LibraryCache;
use super::collation::locale_compare;
use super::frontmatter::{FrontmatterValue, parse_frontmatter};
use super::fs::{NativeLibraryFs, join_relative};
use super::hash::{DirectoryManifest, ManifestViolation, hash_file_bytes, relative_path_violation};
use super::read::{library_location_root, read_library_content};
use super::reader::{ScanContext, read_location_instances};
use super::settings_sources::read_settings_sources;
use super::tree::{TreeError, read_library_tree};
use crate::probing::detection::path_env::PathEnv;
use crate::probing::locations::{LOCATION_DEFINITIONS, location_by_id};
use crate::test_support::scratch_dir;

fn corpus() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/ts-library/corpus.json");
    let text = std::fs::read_to_string(&path).expect("the committed TypeScript corpus is readable");
    serde_json::from_str(&text).expect("the committed TypeScript corpus is JSON")
}

fn platform() -> &'static str {
    crate::health::node_platform()
}

fn skipped_here(case: &Value) -> bool {
    cfg!(windows) && case["unixOnly"].as_bool() == Some(true)
}

fn build_tree(root: &Path, entries: &Value) {
    for entry in entries.as_array().expect("a tree is an array") {
        let target = root.join(entry["path"].as_str().expect("every entry has a path"));
        std::fs::create_dir_all(target.parent().expect("entries live under the root")).unwrap();
        if entry.get("dir").is_some() {
            std::fs::create_dir_all(&target).unwrap();
        } else if let Some(link) = entry["symlink"].as_str() {
            #[cfg(unix)]
            std::os::unix::fs::symlink(link, &target).unwrap();
            #[cfg(not(unix))]
            unreachable!("symlink case {link} must be marked unixOnly");
        } else if let Some(text) = entry["text"].as_str() {
            std::fs::write(&target, text).unwrap();
        } else if let Some(encoded) = entry["base64"].as_str() {
            std::fs::write(&target, STANDARD.decode(encoded).unwrap()).unwrap();
        } else {
            let fill = &entry["fill"];
            let byte = u8::try_from(fill["byte"].as_u64().unwrap()).unwrap();
            let count = usize::try_from(fill["count"].as_u64().unwrap()).unwrap();
            std::fs::write(&target, vec![byte; count]).unwrap();
        }
    }
}

/// Replaces the scratch root with `<root>` and, on Windows, backslashes with
/// the `/` the Linux-generated corpus spells.
fn relativize(value: Value, root: &Path) -> Value {
    match value {
        Value::String(text) => {
            let replaced = text.replace(&root.to_string_lossy().into_owned(), "<root>");
            Value::String(if cfg!(windows) {
                replaced.replace('\\', "/")
            } else {
                replaced
            })
        }
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(|item| relativize(item, root))
                .collect(),
        ),
        Value::Object(map) => Value::Object(
            map.into_iter()
                .filter(|(key, _)| key != "modifiedAtMs")
                .map(|(key, item)| (key, relativize(item, root)))
                .collect(),
        ),
        other => other,
    }
}

fn sorted_by_path(mut items: Vec<Value>) -> Vec<Value> {
    items.sort_by_key(|item| {
        item["instance"]["path"]
            .as_str()
            .unwrap_or_default()
            .to_string()
    });
    items
}

fn describe_value(value: Option<&FrontmatterValue>) -> Value {
    match value {
        Some(FrontmatterValue::Array(items)) => json!({ "type": "array", "items": items }),
        Some(FrontmatterValue::Number(_)) => {
            json!({ "type": "number", "string": value.unwrap().scalar_string() })
        }
        Some(FrontmatterValue::Bool(_)) => {
            json!({ "type": "boolean", "string": value.unwrap().scalar_string() })
        }
        Some(FrontmatterValue::Text(text)) => json!({ "type": "string", "string": text }),
        None => Value::Null,
    }
}

#[test]
fn collation_matches_locale_compare() {
    let corpus = corpus();
    let mut input: Vec<String> =
        serde_json::from_value(corpus["collation"]["input"].clone()).unwrap();
    let expected: Vec<String> =
        serde_json::from_value(corpus["collation"]["sorted"].clone()).unwrap();
    input.sort_by(|left, right| locale_compare(left, right));
    assert_eq!(
        input, expected,
        "expected bun's localeCompare order | received the Rust collator's"
    );
}

#[test]
fn frontmatter_scalars_match_number_and_string_semantics() {
    let corpus = corpus();
    for case in corpus["frontmatterScalars"].as_array().unwrap() {
        let raw = case["raw"].as_str().unwrap();
        let parsed = parse_frontmatter(&format!("---\nname: {raw}\n---\n"));
        let received = describe_value(parsed.get("name"));
        assert_eq!(
            received, case["value"],
            "name: {raw} | expected {} | received {received}",
            case["value"]
        );
    }
    for case in corpus["frontmatterDocuments"].as_array().unwrap() {
        let document = case["document"].as_str().unwrap();
        let parsed = parse_frontmatter(document);
        let received: serde_json::Map<String, Value> = parsed
            .iter()
            .map(|(key, value)| (key.clone(), describe_value(Some(value))))
            .collect();
        assert_eq!(
            Value::Object(received.clone()),
            case["frontmatter"],
            "document {document:?} | expected {} | received {received:?}",
            case["frontmatter"]
        );
    }
}

#[test]
fn file_and_directory_hashes_match_hash_ts() {
    let corpus = corpus();
    for case in corpus["fileHashes"].as_array().unwrap() {
        let bytes = STANDARD.decode(case["base64"].as_str().unwrap()).unwrap();
        assert_eq!(
            hash_file_bytes(&bytes),
            case["contentHash"].as_str().unwrap()
        );
        assert_eq!(bytes.len() as u64, case["sizeBytes"].as_u64().unwrap());
    }
    for case in corpus["directoryHashes"].as_array().unwrap() {
        let mut files: Vec<(String, Vec<u8>)> = case["files"]
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
        files.sort_by(|(left, _), (right, _)| super::js::cmp_utf16(left, right));
        let violation = files
            .iter()
            .find_map(|(path, _)| relative_path_violation(path, false));
        let received = match violation {
            Some(ManifestViolation::PathEscape) => {
                json!({ "valid": false, "invalidReason": "path-escape" })
            }
            Some(ManifestViolation::UnsafeName) => {
                json!({ "valid": false, "invalidReason": "unsafe-name" })
            }
            None => {
                let mut manifest = DirectoryManifest::default();
                for (path, bytes) in &files {
                    manifest.push(path, hash_file_bytes(bytes), bytes.len() as u64);
                }
                let (content_hash, size_bytes) = manifest.finish();
                json!({ "contentHash": content_hash, "sizeBytes": size_bytes, "valid": true })
            }
        };
        assert_eq!(
            received, case["result"],
            "directory tree {} | expected {} | received {received}",
            case["name"], case["result"]
        );
    }
}

#[test]
fn location_scans_match_read_location_instances() {
    let corpus = corpus();
    for case in corpus["scans"].as_array().unwrap() {
        if skipped_here(case) {
            continue;
        }
        let name = case["name"].as_str().unwrap();
        let root = scratch_dir(&format!("library-ts-scan-{name}"));
        build_tree(&root, &case["tree"]);
        let location = location_by_id(case["locationId"].as_str().unwrap()).unwrap();
        let location_path: PathBuf = join_relative(&root, case["locationPath"].as_str().unwrap());
        let warnings = Mutex::new(Vec::<String>::new());
        let warn = |message: &str| warnings.lock().unwrap().push(message.to_string());
        let cache = LibraryCache::default();
        let cancel = CancellationToken::new();
        let context = ScanContext {
            cache: &cache,
            force: true,
            fs: &NativeLibraryFs,
            platform: platform(),
            cancel: &cancel,
            warn: &warn,
        };
        let scanned = read_location_instances(location, &location_path.to_string_lossy(), &context)
            .unwrap_or_else(|error| panic!("scan case {name} failed: {error:?}"));
        let received = relativize(serde_json::to_value(&scanned).unwrap(), &root);
        let expected_entries =
            sorted_by_path(case["expected"]["instances"].as_array().unwrap().clone());
        let received_entries = sorted_by_path(received["entries"].as_array().unwrap().clone());
        assert_eq!(
            received_entries, expected_entries,
            "scan case {name}: expected {expected_entries:#?} | received {received_entries:#?}"
        );
        assert_eq!(
            received["unreadableEntries"], case["expected"]["unreadableEntries"],
            "scan case {name}: unreadable entries differ"
        );
        if name == "location-is-a-file" {
            let warnings = warnings.lock().unwrap();
            assert_eq!(
                warnings.len(),
                1,
                "expected one skipped-location diagnostic | received {warnings:?}"
            );
            assert!(
                warnings[0].contains("claude-commands"),
                "diagnostic names the location: {warnings:?}"
            );
        }
    }
}

#[test]
fn bounded_reads_match_read_library_content() {
    let corpus = corpus();
    for case in corpus["reads"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let root = scratch_dir(&format!("library-ts-read-{name}"));
        let file = root.join("file.md");
        std::fs::write(
            &file,
            STANDARD.decode(case["base64"].as_str().unwrap()).unwrap(),
        )
        .unwrap();
        let result = read_library_content(
            &file.to_string_lossy(),
            &root.to_string_lossy(),
            case["maxBytes"].as_f64(),
            case["truncateOversize"].as_bool() == Some(true),
        )
        .unwrap();
        let received = serde_json::to_value(result).unwrap();
        assert_eq!(
            received, case["expected"],
            "read case {name}: expected {} | received {received}",
            case["expected"]
        );
    }
}

#[test]
fn tree_reads_match_read_library_tree() {
    let corpus = corpus();
    for case in corpus["trees"].as_array().unwrap() {
        if skipped_here(case) {
            continue;
        }
        let name = case["name"].as_str().unwrap();
        let root = scratch_dir(&format!("library-ts-tree-{name}"));
        build_tree(&root, &case["tree"]);
        let path = join_relative(&root, case["path"].as_str().unwrap());
        let containment = join_relative(&root, case["containment"].as_str().unwrap());
        let outcome = read_library_tree(
            &NativeLibraryFs,
            &path.to_string_lossy(),
            &containment.to_string_lossy(),
            platform(),
            &CancellationToken::new(),
        );
        let received = match outcome {
            Ok(result) => json!({ "files": serde_json::to_value(result.files).unwrap() }),
            Err(TreeError::Denied(reason)) if reason.contains("resolves outside") => {
                json!({ "error": "PathEscapeError" })
            }
            Err(TreeError::Denied(reason)) if reason.contains("transfer limits") => {
                json!({ "error": "InstanceTooLargeError" })
            }
            Err(other) => panic!("tree case {name}: unexpected outcome {other:?}"),
        };
        assert_eq!(
            received, case["expected"],
            "tree case {name}: expected {} | received {received}",
            case["expected"]
        );
    }
}

#[test]
fn settings_sources_match_read_settings_sources() {
    let corpus = corpus();
    let root = scratch_dir("library-ts-settings");
    build_tree(&root, &corpus["settingsSources"]["home"]);
    let env = PathEnv {
        platform: platform().to_string(),
        home_dir: root.to_string_lossy().into_owned(),
        env: Default::default(),
    };
    let received = relativize(
        serde_json::to_value(read_settings_sources(&env)).unwrap(),
        &root,
    );
    assert_eq!(
        received, corpus["settingsSources"]["expected"],
        "expected {:#} | received {received:#}",
        corpus["settingsSources"]["expected"]
    );
}

#[test]
fn location_paths_and_roots_match_the_registry() {
    let corpus = corpus();
    for case in corpus["locations"].as_array().unwrap() {
        let env = PathEnv {
            platform: case["platform"].as_str().unwrap().to_string(),
            home_dir: case["homeDir"].as_str().unwrap().to_string(),
            env: serde_json::from_value(case["env"].clone()).unwrap(),
        };
        // The generator records `root` only where its host `dirname`
        // matches the env's platform family (see the generator).
        let received: Vec<Value> = LOCATION_DEFINITIONS
            .iter()
            .zip(case["expected"].as_array().unwrap())
            .map(|(location, expected)| {
                let mut row = json!({ "id": location.id, "path": (location.resolve_path)(&env) });
                if expected.get("root").is_some() {
                    row["root"] = json!(library_location_root(location.id, &env));
                }
                row
            })
            .collect();
        assert_eq!(
            Value::Array(received.clone()),
            case["expected"],
            "path env {}: expected {:#} | received {:#}",
            case["name"],
            case["expected"],
            Value::Array(received)
        );
    }
}
