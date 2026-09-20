//! Consent for the entry points a person, or a hub reaching over SSH,
//! starts directly — as opposed to [`crate::setup::run_non_interactive_setup`],
//! which answers the question explicitly ahead of time.
//!
//! Mirrors the two functions `runtime-home.ts` and `cli.ts` build on top of
//! `readRuntimeSlotState`:
//!
//! - [`consent_by_invocation`] — `consentByInvocation`, for `serve` and
//!   `connect`. A slot with genuinely no answer yet is answered *here*,
//!   granted `full` and recorded, because somebody standing at this machine
//!   with a pairing token is the consent; a slot an installer armed to
//!   `pending` is refused like every other entry point until a person
//!   answers it with `setup`.
//! - [`stdio_consent`] — `stdioConsent`, for `stdio`. No auto-grant: the far
//!   end of a stdio pipe is a hub that reached this machine over SSH, not a
//!   person standing at it, so a `pending` slot (armed by default or by an
//!   installer) refuses exactly like `setup`'s own gate.
//!
//! Both refuse the same way an unreadable `runtime.json` refuses: an unknown
//! answer must never resolve to yes, because the file it replaced may have
//! narrowed this machine to `readonly`, and treating the read failure as "no
//! answer yet" would silently widen that.

use std::path::Path;

use mangostudio_runtime_contract::manifest::ManifestProfile;
use mangostudio_runtime_contract::schemas::RuntimeHomeDocument;
use mangostudio_runtime_contract::strings::RUNTIME_SETUP_PENDING_SIGNATURE;
use serde_json::{Value, json};

use crate::consent::presets::{ResolvedCapabilityAllow, consent_preset};
use crate::consent::source::resolve_allow;
use crate::ports::wall_clock::{WallClock, format_iso8601_millis};
use crate::runtime_home::lock::{LockPolicy, with_slot_lock};
use crate::runtime_home::{
    DefaultSetupState, RuntimeSlot, default_setup_state_for_slot, merge_write,
    read_runtime_slot_config, slot_config_lock_path, slot_config_path,
};
use crate::setup::SetupAuthority;

/// The full sentence a hub's `ssh-failure.ts` classifier greps for
/// (case-insensitively): [`RUNTIME_SETUP_PENDING_SIGNATURE`] itself — kept
/// byte-identical, never touched by the remediation text after it — plus
/// the remediation a person reads. Every refusal path in this module — and
/// in [`crate::transport`] — prints this exact sentence, built from the
/// shared signature rather than a hand-typed copy of it, so the two can
/// never drift apart.
///
/// The remediation names `--profile`, unlike `cli.ts`'s own
/// `RUNTIME_SETUP_PENDING_MESSAGE`: that CLI prompts interactively when
/// `setup` is run with no flags, so a bare `mangostudio-runtime setup`
/// actually works there. This crate's own [`crate::setup`] takes no
/// interactive input at all (see that module's doc comment), so the same
/// bare command here only ever answers "setup needs
/// --profile full|readonly|none" — a dead end, not a remedy. `--slot` is
/// left out on purpose: `run_setup` already resolves it from
/// the binary's own install location when omitted, which is right far more
/// often than a fixed guess printed here would be.
///
/// # Example
///
/// ```
/// use mangostudio_runtime::consent::invocation::setup_pending_message;
///
/// let message = setup_pending_message();
/// assert!(message.starts_with("runtime setup is pending on this machine"));
/// assert!(message.contains("mangostudio-runtime setup --profile"));
/// ```
#[must_use]
pub fn setup_pending_message() -> String {
    format!(
        "{RUNTIME_SETUP_PENDING_SIGNATURE}. Run \"mangostudio-runtime setup --profile \
         <full|readonly|none>\" there before connecting it."
    )
}

/// What one [`consent_by_invocation`] call decided.
#[derive(Debug, Clone)]
pub struct InvocationConsent {
    /// Whether this invocation may serve.
    pub granted: bool,
    /// Whether answering this invocation wrote a new `runtime.json`.
    pub recorded: bool,
    /// Set on a refusal: an unreadable/malformed config, naming the path.
    /// `None` on a plain "not configured yet" refusal, which prints
    /// [`setup_pending_message`] alone.
    pub reason: Option<String>,
    /// What was granted. [`consent_preset`]'s `none` on a refusal.
    pub allow: ResolvedCapabilityAllow,
}

/// Consent for `serve` and `connect`: see the module docs for the
/// auto-grant this performs that [`stdio_consent`] does not.
///
/// Reads, decides, and (on the auto-grant path) writes `runtime.json` under
/// one held lock, so a concurrent `setup` narrowing this slot in the gap
/// between a read and a later write can never be overwritten with `full` by
/// a decision this call took before that narrowing landed.
///
/// # Example
///
/// ```
/// use mangostudio_runtime::consent::invocation::consent_by_invocation;
/// use mangostudio_runtime::ports::wall_clock::SystemWallClock;
/// use mangostudio_runtime::runtime_home::RuntimeSlot;
///
/// // A fresh path every run: this call writes, so a fixed path would only
/// // be "never-before-seen" on the very first `cargo test` invocation.
/// let home = std::env::temp_dir().join(format!("mango-consent-invocation-doctest-{}", std::process::id()));
/// let consent = consent_by_invocation(RuntimeSlot::Remote, &home, "0.0.0", &SystemWallClock);
/// // A never-before-seen `remote` slot is the "invocation is consent" case.
/// assert!(consent.granted);
/// assert!(consent.recorded);
/// assert!(consent.allow.shell);
/// ```
#[must_use]
pub fn consent_by_invocation(
    slot: RuntimeSlot,
    mango_home: &Path,
    runtime_version: &str,
    wall_clock: &dyn WallClock,
) -> InvocationConsent {
    let lock_path = slot_config_lock_path(slot, mango_home);
    match with_slot_lock(&lock_path, &LockPolicy::default(), || {
        decide_and_record(slot, mango_home, runtime_version, wall_clock)
    }) {
        Ok(consent) => consent,
        Err(error) => refused(Some(error.to_string())),
    }
}

/// The read-decide-(maybe)write transaction [`consent_by_invocation`] runs
/// under its lock.
fn decide_and_record(
    slot: RuntimeSlot,
    mango_home: &Path,
    runtime_version: &str,
    wall_clock: &dyn WallClock,
) -> InvocationConsent {
    let state = read_runtime_slot_config(slot, mango_home);
    if let Some(error) = &state.error {
        return refused(Some(error.to_string()));
    }
    let stored = state.stored.as_ref();

    if let Some(raw_state) = stored_setup_state(stored) {
        let granted = raw_state == "configured";
        let allow = if granted {
            resolve_allow(slot, stored)
        } else {
            consent_preset(ManifestProfile::None)
        };
        return InvocationConsent {
            granted,
            recorded: false,
            reason: None,
            allow,
        };
    }

    match default_setup_state_for_slot(slot) {
        DefaultSetupState::Configured => InvocationConsent {
            granted: true,
            recorded: false,
            reason: None,
            allow: resolve_allow(slot, stored),
        },
        DefaultSetupState::Pending => {
            record_launch_grant(slot, mango_home, runtime_version, wall_clock)
        }
    }
}

/// The "invocation is consent" branch: writes a `full` grant, attributed to
/// [`SetupAuthority::Launch`], and reports it as granted and recorded.
///
/// Also records `version` and `source` at the document's top level,
/// matching `consentByInvocation`'s own `mergeRuntimeSlotConfig` call in
/// `runtime-home.ts` — previously dropped here (`runtime_version` arrived
/// unused, and nothing computed `source` at all), leaving this the one
/// grant path in the crate that recorded no provenance for what it wrote.
///
/// A write failure here still lets this launch serve with `full` for its
/// own lifetime rather than refusing an invocation over a disk error on the
/// record-keeping alone — matching `runtime-home.ts`, which does not
/// surface `mergeRuntimeSlotConfig`'s own failure to the caller either.
fn record_launch_grant(
    slot: RuntimeSlot,
    mango_home: &Path,
    runtime_version: &str,
    wall_clock: &dyn WallClock,
) -> InvocationConsent {
    let allow = consent_preset(ManifestProfile::Full);
    let path = slot_config_path(slot, mango_home);
    let fixed: [(&'static str, Value); 2] = [
        ("schemaVersion", Value::from(1)),
        ("slot", Value::from(slot.as_str())),
    ];
    let update = [
        ("profile", Some(Value::String("full".to_string()))),
        ("allow", Some(allow_to_json(allow))),
        (
            "setup",
            Some(json!({
                "state": "configured",
                "at": format_iso8601_millis(wall_clock.now()),
                "by": SetupAuthority::Launch.as_str(),
            })),
        ),
        ("version", Some(Value::String(runtime_version.to_string()))),
        (
            "source",
            Some(Value::String(
                crate::runtime_home::resolve_runtime_source_for_current_exe(mango_home).to_string(),
            )),
        ),
    ];
    let _ = merge_write(
        &path,
        RuntimeHomeDocument::SlotConfig,
        &fixed,
        &update,
        None,
    );
    InvocationConsent {
        granted: true,
        recorded: true,
        reason: None,
        allow,
    }
}

/// What was on disk gave no answer, or gave a lock error before anything
/// could even be read.
fn refused(reason: Option<String>) -> InvocationConsent {
    InvocationConsent {
        granted: false,
        recorded: false,
        reason,
        allow: consent_preset(ManifestProfile::None),
    }
}

/// The raw `setup.state` string a stored document names, or `None` when it
/// carries no `setup` field at all (never touched, or a config only
/// `connect`/`serve` wrote a `hubUrl`/`serveListen` into).
fn stored_setup_state(stored: Option<&Value>) -> Option<&str> {
    stored?.get("setup")?.get("state")?.as_str()
}

/// Consent for `stdio`: refuses a `pending` slot exactly like `setup`'s own
/// gate, with no auto-grant — see the module docs for why stdio never
/// performs [`consent_by_invocation`]'s "invocation is consent" step.
///
/// # Example
///
/// ```
/// use mangostudio_runtime::consent::invocation::stdio_consent;
/// use mangostudio_runtime::runtime_home::RuntimeSlot;
///
/// let home = std::env::temp_dir().join("mango-stdio-consent-doctest");
/// // A never-before-seen `remote` slot refuses; `host` starts pre-consented.
/// assert!(stdio_consent(RuntimeSlot::Remote, &home).refusal.is_some());
/// assert!(stdio_consent(RuntimeSlot::Host, &home).refusal.is_none());
/// ```
#[must_use]
pub fn stdio_consent(slot: RuntimeSlot, mango_home: &Path) -> StdioConsent {
    let state = read_runtime_slot_config(slot, mango_home);
    if let Some(error) = &state.error {
        return StdioConsent {
            refusal: Some(format!("{error} {}", setup_pending_message())),
            allow: consent_preset(ManifestProfile::None),
        };
    }
    let stored = state.stored.as_ref();
    if !resolved_setup_is_configured(slot, stored) {
        return StdioConsent {
            refusal: Some(setup_pending_message()),
            allow: consent_preset(ManifestProfile::None),
        };
    }
    StdioConsent {
        refusal: None,
        allow: resolve_allow(slot, stored),
    }
}

/// What [`stdio_consent`] decided.
#[derive(Debug, Clone)]
pub struct StdioConsent {
    /// The exact line to print to stderr and exit 1 on, or `None` to serve.
    pub refusal: Option<String>,
    /// What was granted; [`consent_preset`]'s `none` on a refusal.
    pub allow: ResolvedCapabilityAllow,
}

/// Whether `stored`'s resolved `setup.state` is `"configured"`: whatever it
/// recorded, or the slot's own default when nothing has recorded one yet.
fn resolved_setup_is_configured(slot: RuntimeSlot, stored: Option<&Value>) -> bool {
    stored_setup_state(stored).map_or_else(
        || default_setup_state_for_slot(slot) == DefaultSetupState::Configured,
        |raw| raw == "configured",
    )
}

/// [`ResolvedCapabilityAllow`] as the `allow` object `runtime.json` stores.
fn allow_to_json(allow: ResolvedCapabilityAllow) -> Value {
    json!({
        "fsRead": allow.fs_read,
        "fsWrite": allow.fs_write,
        "shell": allow.shell,
        "git": allow.git,
        "probing": allow.probing,
        "mcp": allow.mcp,
        "library": allow.library,
        "checkpoints": allow.checkpoints,
        "update": allow.update,
        "externalAgents": allow.external_agents,
    })
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Barrier};

    use serde_json::json;

    use super::{consent_by_invocation, stdio_consent};
    use crate::ports::wall_clock::{FixedWallClock, SystemWallClock};
    use crate::runtime_home::{RuntimeSlot, read_runtime_slot_config, write_runtime_slot_config};

    /// A monotonic counter plus the wall clock, not just `process::id()` and
    /// `line!()`: two calls from the *same* line (a loop body, a helper
    /// called twice in one test) collide on the old scheme, and so does a
    /// reused pid across separate `cargo test` invocations sharing a
    /// persistent `/tmp` — both degrade a test to silently reusing another
    /// run's leftover directory rather than failing loudly. That is not
    /// hypothetical here: [`a_concurrent_narrowing_write_never_loses_to_the_invocations_grant`]
    /// calls this from inside a loop.
    fn unique_suffix() -> u128 {
        static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let count = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        nanos.wrapping_add(u128::from(count))
    }

    fn scratch_home(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "mango-consent-invocation-test-{name}-{}-{}",
            std::process::id(),
            unique_suffix()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_never_before_seen_remote_slot_is_granted_full_and_recorded() {
        let home = scratch_home("remote-fresh");
        let consent = consent_by_invocation(RuntimeSlot::Remote, &home, "0.0.0", &SystemWallClock);
        assert!(consent.granted);
        assert!(consent.recorded);
        assert!(consent.allow.shell, "the invocation grants full");

        let stored = read_runtime_slot_config(RuntimeSlot::Remote, &home)
            .stored
            .expect("the grant was written to disk");
        assert_eq!(stored["setup"]["state"], "configured");
        assert_eq!(stored["setup"]["by"], "launch");
        assert_eq!(stored["profile"], "full");
    }

    /// The regression this guards: `record_launch_grant` used to take
    /// `runtime_version` as an unused parameter and computed no `source` at
    /// all, leaving this the one grant path in the crate with no
    /// provenance for what it wrote — the same gap `runtime-home.ts`'s own
    /// `mergeRuntimeSlotConfig` call closes with `version`/`source` fields.
    #[test]
    fn the_launch_grant_records_its_own_version_and_source() {
        let home = scratch_home("remote-fresh-provenance");
        let consent = consent_by_invocation(RuntimeSlot::Remote, &home, "9.9.9", &SystemWallClock);
        assert!(consent.recorded);

        let stored = read_runtime_slot_config(RuntimeSlot::Remote, &home)
            .stored
            .expect("the grant was written to disk");
        assert_eq!(stored["version"], "9.9.9");
        // The `cargo test` binary's own executable path is never under this
        // scratch home, so this resolves deterministically to "bundled"
        // without needing to fake `std::env::current_exe()`.
        assert_eq!(stored["source"], "bundled");
    }

    #[test]
    fn a_never_before_seen_host_slot_is_granted_without_writing_anything() {
        let home = scratch_home("host-fresh");
        let consent = consent_by_invocation(RuntimeSlot::Host, &home, "0.0.0", &SystemWallClock);
        assert!(consent.granted);
        assert!(
            !consent.recorded,
            "host starts pre-consented; nothing to record"
        );
        assert!(
            read_runtime_slot_config(RuntimeSlot::Host, &home)
                .stored
                .is_none(),
            "an already-configured default must not write a file at all"
        );
    }

    #[test]
    fn a_slot_an_installer_armed_to_pending_is_refused_not_auto_granted() {
        let home = scratch_home("armed-pending");
        write_runtime_slot_config(
            RuntimeSlot::Remote,
            &home,
            &[(
                "setup",
                Some(json!({ "state": "pending", "at": "2024-01-01T00:00:00.000Z", "by": "install" })),
            )],
        )
        .unwrap();

        let consent = consent_by_invocation(RuntimeSlot::Remote, &home, "0.0.0", &SystemWallClock);
        assert!(
            !consent.granted,
            "an armed gate must refuse, never auto-grant"
        );
        assert!(!consent.recorded);
        assert!(!consent.allow.shell);
    }

    #[test]
    fn an_already_configured_slot_reports_its_own_stored_allow() {
        let home = scratch_home("already-configured");
        write_runtime_slot_config(
            RuntimeSlot::Remote,
            &home,
            &[
                (
                    "setup",
                    Some(json!({ "state": "configured", "at": "2024-01-01T00:00:00.000Z", "by": "cli" })),
                ),
                ("allow", Some(json!({ "shell": true, "fsRead": false }))),
            ],
        )
        .unwrap();

        let consent = consent_by_invocation(RuntimeSlot::Remote, &home, "0.0.0", &SystemWallClock);
        assert!(consent.granted);
        assert!(!consent.recorded, "an existing answer is never rewritten");
        assert!(consent.allow.shell);
        assert!(!consent.allow.fs_read);
    }

    #[test]
    fn an_unreadable_config_refuses_and_names_the_reason() {
        let home = scratch_home("malformed");
        let dir = crate::runtime_home::slot_dir(RuntimeSlot::Remote, &home);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("runtime.json"), b"{ not json").unwrap();

        let consent = consent_by_invocation(RuntimeSlot::Remote, &home, "0.0.0", &SystemWallClock);
        assert!(!consent.granted);
        assert!(!consent.recorded);
        assert!(consent.reason.is_some());
    }

    #[test]
    fn the_recorded_at_is_the_wall_clocks_instant() {
        let home = scratch_home("timestamp");
        let clock = FixedWallClock::new(
            std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000),
        );
        let _ = consent_by_invocation(RuntimeSlot::Remote, &home, "0.0.0", &clock);
        let stored = read_runtime_slot_config(RuntimeSlot::Remote, &home)
            .stored
            .unwrap();
        assert_eq!(stored["setup"]["at"], "2023-11-14T22:13:20.000Z");
    }

    /// The property `consent_by_invocation`'s single lock scope exists for:
    /// a `setup` call narrowing this slot to `readonly` *during* the window
    /// a concurrent invocation is deciding "nothing answered yet, grant
    /// full" must never be overwritten by that decision's own write landing
    /// afterwards. Two real OS threads, released by a `Barrier` at the same
    /// instant, are what makes this a genuine race rather than a
    /// sequential call in disguise.
    ///
    /// Repeated 20 times, each with its own fresh scratch home: measured
    /// against the real defect (the read-decide-write split into two lock
    /// acquisitions, reopening exactly the race the single lock scope
    /// closes), one round alone catches it only 22/100 times — repeating
    /// gets that to about 99.3%. A single round stayed in as
    /// documentation of the minimal reproduction; the loop is what the
    /// assertion actually leans on.
    #[test]
    fn a_concurrent_narrowing_write_never_loses_to_the_invocations_grant() {
        for _ in 0..20 {
            let home = Arc::new(scratch_home("race"));
            let barrier = Arc::new(Barrier::new(2));

            let invocation_home = Arc::clone(&home);
            let invocation_barrier = Arc::clone(&barrier);
            let invocation = std::thread::spawn(move || {
                invocation_barrier.wait();
                consent_by_invocation(
                    RuntimeSlot::Remote,
                    &invocation_home,
                    "0.0.0",
                    &SystemWallClock,
                )
            });

            let narrow_home = Arc::clone(&home);
            let narrow_barrier = Arc::clone(&barrier);
            let narrow = std::thread::spawn(move || {
                narrow_barrier.wait();
                write_runtime_slot_config(
                    RuntimeSlot::Remote,
                    &narrow_home,
                    &[
                        (
                            "setup",
                            Some(
                                json!({ "state": "configured", "at": "2024-01-01T00:00:00.000Z", "by": "cli" }),
                            ),
                        ),
                        ("allow", Some(json!({ "shell": false }))),
                    ],
                )
            });

            let consent = invocation.join().unwrap();
            narrow.join().unwrap().unwrap();

            // Whichever of the two transactions ran first, the file on disk
            // must reflect exactly one of them in full — never a
            // shell:true field from the launch grant merged with a state
            // the narrowing call never actually wrote (or vice versa).
            // `with_slot_lock`'s mutual exclusion is what this asserts.
            let stored = read_runtime_slot_config(RuntimeSlot::Remote, &home)
                .stored
                .unwrap();
            if consent.recorded {
                // The invocation's grant ran, and completed, before the
                // narrowing write took the lock: the narrowing write is
                // what must be on disk afterwards, since it ran second
                // under the same lock.
                assert_eq!(stored["allow"]["shell"], false);
            } else {
                // The narrowing write ran first: the invocation observed an
                // already-configured slot and reported its stored allow
                // faithfully, never re-granting `full` over it.
                assert!(!consent.allow.shell);
                assert_eq!(stored["allow"]["shell"], false);
            }
        }
    }

    #[test]
    fn stdio_refuses_a_pending_slot_with_no_auto_grant() {
        let home = scratch_home("stdio-pending");
        let consent = stdio_consent(RuntimeSlot::Remote, &home);
        assert!(consent.refusal.is_some());
        assert!(!consent.allow.shell);
        assert!(
            read_runtime_slot_config(RuntimeSlot::Remote, &home)
                .stored
                .is_none(),
            "stdio must never write an auto-grant the way connect/serve do"
        );
    }

    #[test]
    fn stdio_serves_a_pre_consented_host_slot_with_no_refusal() {
        let home = scratch_home("stdio-host");
        let consent = stdio_consent(RuntimeSlot::Host, &home);
        assert!(consent.refusal.is_none());
        assert!(consent.allow.shell);
    }

    #[test]
    fn stdio_refusal_carries_the_setup_pending_signature() {
        let home = scratch_home("stdio-signature");
        let consent = stdio_consent(RuntimeSlot::Remote, &home);
        let refusal = consent.refusal.expect("remote starts pending");
        assert!(
            refusal
                .to_lowercase()
                .contains("runtime setup is pending on this machine"),
            "the hub's ssh-failure classifier greps for this exact sentence: {refusal:?}"
        );
    }
}
