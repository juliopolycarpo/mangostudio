//! Regenerates `tests/fixtures/rust-home/`: a runtime home written by *this*
//! crate, committed so `apps/runtime/tests/unit/runtime-home-rust-compat.test.ts`
//! can prove the TypeScript implementation reads it back with no error —
//! the other direction of the compatibility claim `tests/ts_compat.rs`
//! proves for TypeScript-written homes.
//!
//! Also writes one `audit.log` line with [`FileAudit`], under the same
//! directory the freshness gate already diffs — there is no TypeScript-
//! authored counterpart yet: `audit-log.ts`'s `createRuntimeAuditSink` has
//! no clock override (its `ts` always comes from `new Date().toISOString()`
//! at generation time), so a fixture it wrote could never be reproducible
//! enough to commit. Adding that override, and the matching TypeScript-to-
//! Rust `tests/audit_ts_compat.rs`, is left for whichever change first
//! needs that direction proven.
//!
//! `#[ignore]`d: this writes fixture files, it does not check anything, and
//! a `cargo test` on every gate run should not regenerate committed output
//! on every CI machine's own pid and hostname. Run explicitly with:
//!
//! ```text
//! cargo test -p mangostudio-runtime --test generate_rust_fixture -- --ignored
//! ```

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, UNIX_EPOCH};

use mangostudio_runtime::audit::FileAudit;
use mangostudio_runtime::ports::audit::{Audit, AuditEntry, Outcome};
use mangostudio_runtime::ports::wall_clock::FixedWallClock;
use mangostudio_runtime::runtime_home::{
    RuntimeSlot, slot_audit_log_path, write_runtime_slot_config, write_runtime_slot_credentials,
};
use serde_json::json;

fn fixture_home() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/rust-home")
}

#[tokio::test]
#[ignore = "regenerates a committed fixture; run explicitly, see this file's module doc"]
async fn regenerate() {
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

    // A fixed instant, so this line's `ts` field is reproducible across
    // regenerations rather than tied to whatever moment this test last ran.
    let clock = Arc::new(FixedWallClock::new(
        UNIX_EPOCH + Duration::from_secs(1_735_689_600), // 2025-01-01T00:00:00Z
    ));
    let audit = FileAudit::new(slot_audit_log_path(RuntimeSlot::Host, &home), clock);
    audit
        .record(AuditEntry {
            method: "runtime.health".to_string(),
            outcome: Outcome::Ok,
            duration: Duration::from_millis(5),
            capability: None,
            code: None,
        })
        .await;

    println!("wrote {}", home.display());
}
