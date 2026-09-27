//! Proves this crate's consent resolution reads a `runtime.json` the
//! TypeScript implementation actually wrote — the same compatibility claim
//! `tests/ts_compat.rs` proves for the raw runtime-home layer, one level up:
//! not just "the bytes parse", but "the `allow` set this crate resolves
//! from them is the one a TypeScript-written file actually grants".
//!
//! Uses the same committed `tests/fixtures/ts-home/` fixture `ts_compat.rs`
//! reads — no separate consent fixture exists, because
//! `RUNTIME_CONSENT_PRESETS.full`/`.readonly` are already exactly what the
//! `host`/`wsl` fixtures' `allow` objects spell out, and `remote`'s fixture
//! (no `allow` key at all) is exactly the "nothing has answered yet" case
//! this crate's own `default_consent_for_slot` exists to resolve.

use std::path::{Path, PathBuf};

use mangostudio_runtime::consent::presets::{
    consent_preset, default_consent_for_slot, profile_for_allow,
};
use mangostudio_runtime::consent::source::ConsentSource;
use mangostudio_runtime::runtime_home::RuntimeSlot;
use mangostudio_runtime_contract::manifest::ManifestProfile;

fn fixture_home() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/ts-home")
}

#[test]
fn the_ts_written_host_slot_resolves_to_exactly_the_full_preset() {
    let source = ConsentSource::new(RuntimeSlot::Host, fixture_home());
    let allow = source.refresh();
    assert_eq!(allow, consent_preset(ManifestProfile::Full));
    assert_eq!(profile_for_allow(allow), ManifestProfile::Full);
}

#[test]
fn the_ts_written_wsl_slot_resolves_to_exactly_the_readonly_preset() {
    let source = ConsentSource::new(RuntimeSlot::Wsl, fixture_home());
    let allow = source.refresh();
    assert_eq!(allow, consent_preset(ManifestProfile::Readonly));
    assert_eq!(profile_for_allow(allow), ManifestProfile::Readonly);
}

/// The `remote` fixture carries no `allow` key at all — the case this
/// crate's own `default_consent_for_slot` exists for: nothing has answered
/// yet, so `remote` (placed by somebody's hub, not somebody with an account
/// on this machine) resolves to `none`, not to `full`.
#[test]
fn the_ts_written_remote_slot_with_no_allow_key_resolves_to_the_slot_default() {
    let source = ConsentSource::new(RuntimeSlot::Remote, fixture_home());
    let allow = source.refresh();
    assert_eq!(allow, default_consent_for_slot(RuntimeSlot::Remote));
    assert_eq!(profile_for_allow(allow), ManifestProfile::None);
}

/// A field a newer TypeScript release wrote and this crate's schema does
/// not declare (`somethingANewerRuntimeWrote`, on the `wsl` fixture) must
/// not perturb consent resolution — the forward-compatibility guarantee
/// `ts_compat.rs` proves at the raw-bytes layer must hold at this layer
/// too.
#[test]
fn an_unrecognised_field_does_not_perturb_consent_resolution() {
    let source = ConsentSource::new(RuntimeSlot::Wsl, fixture_home());
    assert!(
        source.refresh().fs_read,
        "the wsl fixture's real allow.fsRead must still resolve true \
         despite the unrecognised sibling field"
    );
}
