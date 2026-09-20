//! Regenerates `tests/fixtures/rust-home/`: a runtime home written by *this*
//! crate, committed so `apps/runtime/tests/unit/runtime-home-rust-compat.test.ts`
//! can prove the TypeScript implementation reads it back with no error —
//! the other direction of the compatibility claim `tests/ts_compat.rs`
//! proves for TypeScript-written homes.
//!
//! `#[ignore]`d: this writes fixture files, it does not check anything, and
//! a `cargo test` on every gate run should not regenerate committed output
//! on every CI machine's own pid and hostname. Run explicitly with:
//!
//! ```text
//! cargo test -p mangostudio-runtime --test generate_rust_fixture -- --ignored
//! ```

use std::path::{Path, PathBuf};

use mangostudio_runtime::runtime_home::{
    RuntimeSlot, write_runtime_slot_config, write_runtime_slot_credentials,
};
use serde_json::json;

fn fixture_home() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/rust-home")
}

#[test]
#[ignore = "regenerates a committed fixture; run explicitly, see this file's module doc"]
fn regenerate() {
    let home = fixture_home();
    std::fs::remove_dir_all(&home).ok();

    write_runtime_slot_config(
        RuntimeSlot::Host,
        &home,
        &[
            ("source", Some(json!("provisioned"))),
            ("version", Some(json!("0.2.0-rust-fixture"))),
            ("digest", Some(json!(format!("sha256:{}", "b".repeat(64))))),
            (
                "allow",
                Some(json!({
                    "fsRead": true,
                    "fsWrite": true,
                    "shell": true,
                    "git": true,
                    "probing": true,
                    "mcp": true,
                    "library": true,
                    "checkpoints": true,
                    "update": true,
                    "externalAgents": true
                })),
            ),
            (
                "setup",
                Some(json!({ "state": "configured", "at": "2026-01-03T00:00:00.000Z", "by": "install" })),
            ),
            ("audit", Some(json!({ "enabled": false }))),
        ],
    )
    .expect("writing the host slot");
    write_runtime_slot_credentials(
        RuntimeSlot::Host,
        &home,
        &[(
            "serveToken",
            Some(json!("mrt_rust_fixture_host_serve_token")),
        )],
    )
    .expect("writing host credentials");

    write_runtime_slot_config(
        RuntimeSlot::Wsl,
        &home,
        &[
            ("version", Some(json!("0.2.0-rust-fixture"))),
            (
                "allow",
                Some(json!({
                    "fsRead": true,
                    "fsWrite": false,
                    "shell": false,
                    "git": true,
                    "probing": true,
                    "mcp": false,
                    "library": true,
                    "checkpoints": false,
                    "update": false,
                    "externalAgents": false
                })),
            ),
            ("setup", Some(json!({ "state": "configured", "by": "cli" }))),
        ],
    )
    .expect("writing the wsl slot");
    write_runtime_slot_credentials(
        RuntimeSlot::Wsl,
        &home,
        &[(
            "pairingToken",
            Some(json!("mrt_rust_fixture_wsl_pairing_token")),
        )],
    )
    .expect("writing wsl credentials");

    write_runtime_slot_config(
        RuntimeSlot::Remote,
        &home,
        &[(
            "hubUrl",
            Some(json!("wss://hub.rust-fixture.test/api/runtime")),
        )],
    )
    .expect("writing the remote slot");
    write_runtime_slot_credentials(
        RuntimeSlot::Remote,
        &home,
        &[
            (
                "pairingToken",
                Some(json!("mrt_rust_fixture_remote_pairing_token")),
            ),
            (
                "serveToken",
                Some(json!("mrt_rust_fixture_remote_serve_token")),
            ),
        ],
    )
    .expect("writing remote credentials");

    println!("wrote {}", home.display());
}
