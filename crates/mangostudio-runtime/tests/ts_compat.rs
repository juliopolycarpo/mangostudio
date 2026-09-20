//! Proves this crate reads a runtime home the TypeScript implementation
//! actually wrote — the direction a Rust-only round-trip test cannot prove.
//!
//! `apps/runtime/scripts/generate-home-fixtures.ts` is the TypeScript half:
//! it calls the real `writeRuntimeSlotConfig`/`writePairingToken`/
//! `writeServeToken` from `apps/runtime/src/runtime-home.ts` and commits the
//! result under `tests/fixtures/ts-home/`. Nothing here regenerates that
//! fixture — regenerate it with `bun run --filter @mangostudio/runtime
//! fixtures:home` when the shapes in
//! `apps/runtime/tests/unit/runtime-home.test.ts` change.

use std::path::{Path, PathBuf};

use mangostudio_runtime::runtime_home::{
    RuntimeSlot, read_runtime_slot_config, read_runtime_slot_credentials, write_runtime_slot_config,
};
use serde_json::json;

fn fixture_home() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/ts-home")
}

/// Recursively copies the committed fixture into a scratch directory, so a
/// test that writes through it never mutates what is checked in.
fn copy_fixture_into_scratch(name: &str) -> PathBuf {
    let scratch = std::env::temp_dir().join(format!(
        "mango-ts-compat-{name}-{}-{}",
        std::process::id(),
        line!()
    ));
    copy_dir_recursive(&fixture_home(), &scratch).expect("copying the committed fixture");
    scratch
}

fn copy_dir_recursive(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let destination = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&entry.path(), &destination)?;
        } else {
            std::fs::copy(entry.path(), &destination)?;
        }
    }
    Ok(())
}

#[test]
fn reads_the_ts_written_host_slot_with_no_error() {
    let home = fixture_home();
    let state = read_runtime_slot_config(RuntimeSlot::Host, &home);
    assert!(
        state.error.is_none(),
        "a real TypeScript-written file must never be unusable"
    );
    let stored = state
        .stored
        .expect("host/runtime.json exists in the fixture");

    assert_eq!(stored["source"], json!("bundled"));
    assert_eq!(stored["version"], json!("0.9.0"));
    assert_eq!(
        stored["digest"],
        json!(format!("sha256:{}", "a".repeat(64)))
    );
    assert_eq!(stored["allow"]["shell"], json!(true));
    assert_eq!(stored["setup"]["state"], json!("configured"));
    assert_eq!(stored["setup"]["by"], json!("launch"));
    assert_eq!(stored["installedBy"]["host"], json!("ts-fixture-host"));
    assert_eq!(stored["audit"]["enabled"], json!(false));
}

#[test]
fn reads_the_ts_written_host_credentials() {
    let home = fixture_home();
    let stored = read_runtime_slot_credentials(RuntimeSlot::Host, &home)
        .stored
        .expect("host/credentials.json exists in the fixture");
    assert_eq!(stored["serveToken"], json!("mrt_fixture_host_serve_token"));
    assert!(
        stored.get("pairingToken").is_none(),
        "host was only ever given a serve token"
    );
}

#[test]
fn a_field_a_newer_ts_release_wrote_does_not_make_the_wsl_slot_unusable() {
    // `somethingANewerRuntimeWrote` is not a field
    // `mangostudio-runtime-contract`'s schema declares — proving forward
    // compatibility means proving this crate's *schema*, not a hand-rolled
    // parser, tolerates it, which is exactly what `validate_runtime_home`
    // deciding this file is still valid demonstrates.
    let home = fixture_home();
    let state = read_runtime_slot_config(RuntimeSlot::Wsl, &home);
    assert!(state.error.is_none());
    let stored = state
        .stored
        .expect("wsl/runtime.json exists in the fixture");
    assert_eq!(
        stored["somethingANewerRuntimeWrote"],
        json!("from a release this contract predates")
    );
    assert_eq!(stored["allow"]["shell"], json!(false));
    assert_eq!(stored["allow"]["fsRead"], json!(true));
}

#[test]
fn reads_the_ts_written_wsl_credentials() {
    let home = fixture_home();
    let stored = read_runtime_slot_credentials(RuntimeSlot::Wsl, &home)
        .stored
        .expect("wsl/credentials.json exists in the fixture");
    assert_eq!(
        stored["pairingToken"],
        json!("mrt_fixture_wsl_pairing_token")
    );
}

#[test]
fn reads_the_ts_written_remote_slot_and_its_rotated_credentials() {
    let home = fixture_home();
    let config = read_runtime_slot_config(RuntimeSlot::Remote, &home)
        .stored
        .expect("remote/runtime.json exists in the fixture");
    assert_eq!(
        config["hubUrl"],
        json!("wss://hub.fixture.test/api/runtime")
    );

    let credentials = read_runtime_slot_credentials(RuntimeSlot::Remote, &home)
        .stored
        .expect("remote/credentials.json exists in the fixture");
    // The fixture script rotates the pairing token after writing the serve
    // token, mirroring `writePairingToken`'s read-merge-write: the rotation
    // must not have dropped the token it did not touch.
    assert_eq!(
        credentials["pairingToken"],
        json!("mrt_fixture_remote_pairing_token_rotated")
    );
    assert_eq!(
        credentials["serveToken"],
        json!("mrt_fixture_remote_serve_token")
    );
}

#[test]
fn the_lock_body_shape_matches_what_this_crates_own_lock_protocol_writes() {
    // Not a per-slot file, and not read through the runtime-home API at
    // all — `withSlotLock` in `runtime-home.ts` writes
    // `{ pid, host }` directly, which is exactly the shape
    // `crate::runtime_home::lock`'s own `LockOwner` (de)serialises. This
    // test proves the field names agree without depending on that private
    // type, by parsing the fixture as a bare JSON object.
    let raw = std::fs::read_to_string(fixture_home().join("lock-body.json")).unwrap();
    let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(value["pid"], json!(4242));
    assert_eq!(value["host"], json!("ts-fixture-host"));
}

#[test]
fn a_rust_merge_write_onto_a_ts_written_file_keeps_the_ts_writers_fields() {
    // The compatibility claim that matters most in practice: an installer
    // (Rust or TypeScript, it must not matter which) updates one field of a
    // `runtime.json` a *different* language's runtime produced, and every
    // field it did not touch survives. Operates on a scratch copy — the
    // committed fixture must never be mutated by a test run.
    let home = copy_fixture_into_scratch("merge-write");

    write_runtime_slot_config(
        RuntimeSlot::Host,
        &home,
        &[("version", Some(json!("0.9.0-rust-touched")))],
    )
    .expect("merging into a TypeScript-written runtime.json");

    let stored = read_runtime_slot_config(RuntimeSlot::Host, &home)
        .stored
        .unwrap();
    assert_eq!(
        stored["version"],
        json!("0.9.0-rust-touched"),
        "the field this write touched"
    );
    assert_eq!(
        stored["source"],
        json!("bundled"),
        "a field only TypeScript wrote must survive"
    );
    assert_eq!(
        stored["allow"]["shell"],
        json!(true),
        "the full consent set must survive untouched"
    );
    assert_eq!(
        stored["installedBy"]["host"],
        json!("ts-fixture-host"),
        "a nested object only TypeScript wrote must survive"
    );

    std::fs::remove_dir_all(&home).ok();
}
