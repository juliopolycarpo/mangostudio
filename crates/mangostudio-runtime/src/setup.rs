//! Answering the consent question without a person at a terminal.
//!
//! Mirrors the non-interactive half of `apps/runtime/src/setup.ts`:
//! precedence (a flag, then `MANGOSTUDIO_RUNTIME_SETUP`), `--allow k=v`
//! overrides on top of the chosen preset, and the `setup.state` record this
//! writes to `runtime.json`. Interactive prompting
//! (`promptForProfile`/`promptForUpdates`/`promptForAudit`) is out of
//! scope — this module is exactly the part of `setup.ts` that never awaits
//! a person. [`crate::cli`]'s `setup` subcommand is its caller.
//!
//! # The setup-pending signature
//!
//! `RUNTIME_SETUP_PENDING_SIGNATURE` (a hub greps stderr for it) is not
//! written by `setup.ts` at all — it belongs to `cli.ts`, on the call path
//! that refuses to serve a `pending` slot. Here that is
//! [`crate::consent::invocation::setup_pending_message`]; this module does
//! not print it a second time.
//!
//! # Exit codes
//!
//! `setup.ts` itself answers only two: `0` on success, `1` on any failure
//! path (an unusable profile source, an unknown `--allow` key, a
//! malformed `--allow` value, or a write that failed).
//! `RUNTIME_UPDATE_EXIT_CODE` (75) is a different call path entirely
//! (`runtime.update.*`'s own binary-replacement flow) and never appears
//! here.

use std::path::Path;

use mangostudio_runtime_contract::manifest::{ManifestProfile, capability_keys};

use crate::consent::presets::{ResolvedCapabilityAllow, consent_preset};
use crate::ports::wall_clock::{WallClock, format_iso8601_millis};
use crate::runtime_home::{RuntimeSlot, SlotFileError, WriteError, write_runtime_slot_config};

/// Who answered the consent question, mirroring `RuntimeSetupAuthoritySchema`.
/// `Cli` and `Env` are the two this module can produce; `Launch` and
/// `Install` are written elsewhere (an unattended start, an installer
/// arming the gate) and only round-trip through this type's [`SetupAuthority::as_str`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SetupAuthority {
    /// Someone ran `mangostudio-runtime setup`.
    Cli,
    /// `MANGOSTUDIO_RUNTIME_SETUP`, which is how container images answer.
    Env,
    /// The act of starting this runtime by hand on this machine.
    Launch,
    /// An installer armed the gate without answering it.
    Install,
}

impl SetupAuthority {
    /// The wire spelling `RuntimeSetupAuthoritySchema` declares.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            SetupAuthority::Cli => "cli",
            SetupAuthority::Env => "env",
            SetupAuthority::Launch => "launch",
            SetupAuthority::Install => "install",
        }
    }
}

/// Parses `raw` the way `setup.ts`'s local `parseBoolean` does:
/// case-insensitive, trimmed, `true`/`yes`/`on` or `false`/`no`/`off`.
/// `None` for anything else.
///
/// # Example
///
/// ```
/// use mangostudio_runtime::setup::parse_boolean;
///
/// assert_eq!(parse_boolean(" YES "), Some(true));
/// assert_eq!(parse_boolean("off"), Some(false));
/// assert_eq!(parse_boolean("sure"), None);
/// ```
#[must_use]
pub fn parse_boolean(raw: &str) -> Option<bool> {
    match raw.trim().to_lowercase().as_str() {
        "true" | "yes" | "on" => Some(true),
        "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

/// Parses `--allow fsWrite=false,shell=true` into an ordered override list.
/// Mirrors `parseAllowOverrides`: comma-separated `key=value` pairs,
/// whitespace around each entry ignored, a blank entry (from a trailing or
/// doubled comma) silently skipped.
///
/// # Errors
/// The exact message `setup.ts` produces, for: a malformed entry (no `=`),
/// an unknown capability key, or a value [`parse_boolean`] cannot read.
///
/// # Example
///
/// ```
/// use mangostudio_runtime::setup::parse_allow_overrides;
///
/// let overrides = parse_allow_overrides("fsWrite=false, shell=true").unwrap();
/// assert_eq!(overrides, vec![("fsWrite".to_string(), false), ("shell".to_string(), true)]);
///
/// let error = parse_allow_overrides("shell=maybe").unwrap_err();
/// assert!(error.contains("expects true or false"));
/// ```
pub fn parse_allow_overrides(value: &str) -> Result<Vec<(String, bool)>, String> {
    let mut overrides = Vec::new();
    for raw_entry in value.split(',') {
        let trimmed = raw_entry.trim();
        if trimmed.is_empty() {
            continue;
        }
        let mut parts = trimmed.splitn(2, '=');
        let key = parts.next().filter(|key| !key.is_empty());
        let raw_value = parts.next();
        let (Some(key), Some(raw_value)) = (key, raw_value) else {
            return Err(format!(
                "--allow expects key=value pairs, got \"{trimmed}\"."
            ));
        };
        if !capability_keys().contains(&key) {
            return Err(format!(
                "--allow does not know the capability \"{key}\". Known: {}.",
                capability_keys().join(", ")
            ));
        }
        let Some(parsed) = parse_boolean(raw_value) else {
            return Err(format!(
                "--allow {key} expects true or false, got \"{raw_value}\"."
            ));
        };
        overrides.push((key.to_string(), parsed));
    }
    Ok(overrides)
}

/// Applies `overrides` (as [`parse_allow_overrides`] returns them) onto
/// `base`, later entries winning over earlier ones — mirrors the final
/// `{ ...base, ...args.allow }` merge in `setup.ts`'s non-interactive path
/// (the interactive-only `promptForUpdates` step in between is never run
/// here, so there is nothing between the preset and the flag overrides).
fn apply_allow_overrides(
    base: ResolvedCapabilityAllow,
    overrides: &[(String, bool)],
) -> ResolvedCapabilityAllow {
    let mut allow = base;
    for (key, value) in overrides {
        // `parse_allow_overrides` already rejects any key outside
        // `capability_keys()`, so an unrecognised key is unreachable in
        // practice — kept as a silent no-op rather than a panic, matching
        // that function's own "the only gate" role.
        allow.set(key, *value);
    }
    allow
}

/// A non-interactive setup call's inputs, already resolved from whichever
/// source (a flag, an environment variable) named a profile — see
/// [`resolve_profile_source`] for that precedence step.
pub struct NonInteractiveSetupRequest<'a> {
    /// The slot this call configures.
    pub slot: RuntimeSlot,
    /// The chosen preset, and who chose it.
    pub profile: (ManifestProfile, SetupAuthority),
    /// `--allow k=v` overrides, applied on top of the preset.
    pub allow_overrides: &'a [(String, bool)],
}

/// Chooses a profile from a CLI flag and an environment variable, flags
/// winning: `flag` fills the answer if present, `env` fills it only when
/// `flag` is absent. Mirrors `named = args.profile ?? environmentProfile`
/// and `by = args.profile === undefined && environmentProfile !== null ?
/// 'env' : 'cli'` — a value from `flag` is always attributed to `Cli`, even
/// when `env` also carried one, and a value from `env` is attributed to
/// `Env` only when `flag` carried nothing at all.
///
/// # Example
///
/// ```
/// use mangostudio_runtime::setup::{resolve_profile_source, SetupAuthority};
/// use mangostudio_runtime_contract::manifest::ManifestProfile;
///
/// assert_eq!(
///     resolve_profile_source(Some(ManifestProfile::Readonly), Some(ManifestProfile::Full)),
///     Some((ManifestProfile::Readonly, SetupAuthority::Cli))
/// );
/// assert_eq!(
///     resolve_profile_source(None, Some(ManifestProfile::Full)),
///     Some((ManifestProfile::Full, SetupAuthority::Env))
/// );
/// assert_eq!(resolve_profile_source(None, None), None);
/// ```
#[must_use]
pub fn resolve_profile_source(
    flag: Option<ManifestProfile>,
    env: Option<ManifestProfile>,
) -> Option<(ManifestProfile, SetupAuthority)> {
    match (flag, env) {
        (Some(profile), _) => Some((profile, SetupAuthority::Cli)),
        (None, Some(profile)) => Some((profile, SetupAuthority::Env)),
        (None, None) => None,
    }
}

/// Parses `raw` — `MANGOSTUDIO_RUNTIME_SETUP`'s value, as
/// [`crate::config::RuntimeConfig::setup_profile`] reads it verbatim and
/// unvalidated — into a real profile. Mirrors `isRuntimeSetupProfile`:
/// only `full`, `readonly`, and `none` are values someone can *set*;
/// `custom` is never one of them, it is what any other capability
/// combination is called after the fact.
///
/// # Example
///
/// ```
/// use mangostudio_runtime::setup::parse_setup_profile;
/// use mangostudio_runtime_contract::manifest::ManifestProfile;
///
/// assert_eq!(parse_setup_profile("readonly"), Some(ManifestProfile::Readonly));
/// assert_eq!(parse_setup_profile("custom"), None);
/// assert_eq!(parse_setup_profile("not-a-profile"), None);
/// ```
#[must_use]
pub fn parse_setup_profile(raw: &str) -> Option<ManifestProfile> {
    match raw {
        "full" => Some(ManifestProfile::Full),
        "readonly" => Some(ManifestProfile::Readonly),
        "none" => Some(ManifestProfile::None),
        _ => None,
    }
}

/// [`resolve_profile_source`], but starting from `MANGOSTUDIO_RUNTIME_SETUP`'s
/// raw string rather than an already-parsed profile — the bridge
/// [`crate::config::RuntimeConfig`] (which parses every environment variable
/// exactly once, unvalidated) and this module (which judges whether the
/// value it received means anything) are deliberately kept on either side
/// of, matching `setup.ts`'s own two-step read.
///
/// An environment value that does not parse is only fatal when `flag` is
/// absent — mirrors `setup.ts`'s own reasoning: "the command that repairs a
/// machine whose `MANGOSTUDIO_RUNTIME_SETUP` went stale is precisely an
/// explicit `setup --profile … --yes`", so a flag must be able to override a
/// broken environment rather than being refused because of it.
///
/// # Errors
/// The exact message `setup.ts` raises for an unparseable
/// `MANGOSTUDIO_RUNTIME_SETUP`, naming the bad value, when `flag` is absent.
///
/// # Example
///
/// ```
/// use mangostudio_runtime::setup::resolve_profile_source_from_raw_env;
/// use mangostudio_runtime_contract::manifest::ManifestProfile;
///
/// let error = resolve_profile_source_from_raw_env(None, Some("sandbox")).unwrap_err();
/// assert_eq!(
///     error,
///     "MANGOSTUDIO_RUNTIME_SETUP is \"sandbox\", which is not a profile. Use full, readonly, or none."
/// );
///
/// // A flag outranks a broken environment value rather than being refused because of it.
/// let resolved =
///     resolve_profile_source_from_raw_env(Some(ManifestProfile::Full), Some("sandbox")).unwrap();
/// assert!(resolved.is_some());
/// ```
pub fn resolve_profile_source_from_raw_env(
    flag: Option<ManifestProfile>,
    raw_env: Option<&str>,
) -> Result<Option<(ManifestProfile, SetupAuthority)>, String> {
    let env_profile = raw_env.and_then(parse_setup_profile);
    if flag.is_none()
        && let Some(raw) = raw_env
        && env_profile.is_none()
    {
        return Err(format!(
            "MANGOSTUDIO_RUNTIME_SETUP is \"{raw}\", which is not a profile. Use full, \
             readonly, or none."
        ));
    }
    Ok(resolve_profile_source(flag, env_profile))
}

/// What a non-interactive setup call actually wrote.
#[derive(Debug)]
pub struct SetupOutcome {
    /// The profile the merged `allow` set now names.
    pub profile: ManifestProfile,
    /// The merged capability set written.
    pub allow: ResolvedCapabilityAllow,
    /// Who answered.
    pub by: SetupAuthority,
    /// An unusable `runtime.json` that this setup replaced.
    pub replaced_unusable: Option<SlotFileError>,
}

impl SetupOutcome {
    /// `setup.ts`'s own convention: success is always exit code `0`.
    #[must_use]
    pub fn exit_code(self) -> u8 {
        0
    }
}

/// Why a non-interactive setup call did not write anything.
#[derive(Debug)]
pub enum SetupError {
    /// Neither a flag nor an environment variable named a profile, and
    /// there is no interactive fallback in this build.
    NoProfileSource,
    /// The write to `runtime.json` itself failed.
    Write(WriteError),
}

impl std::fmt::Display for SetupError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SetupError::NoProfileSource => write!(
                formatter,
                "no profile was named by a flag or by MANGOSTUDIO_RUNTIME_SETUP, and this build \
                 cannot prompt for one."
            ),
            SetupError::Write(error) => write!(formatter, "{error}"),
        }
    }
}

impl std::error::Error for SetupError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            SetupError::NoProfileSource => None,
            SetupError::Write(error) => Some(error),
        }
    }
}

impl SetupError {
    /// `setup.ts`'s own convention: every failure path is exit code `1`.
    #[must_use]
    pub fn exit_code(&self) -> u8 {
        1
    }
}

/// Runs one non-interactive setup call: merges `request`'s preset with its
/// `--allow` overrides and writes the result (plus a `setup.state` record
/// stamped `configured`, `wall_clock.now()`, and `request`'s authority) to
/// `slot`'s `runtime.json` under `mango_home`.
///
/// # Errors
/// See [`SetupError`].
///
/// # Example
///
/// ```
/// use mangostudio_runtime::consent::source::ConsentSource;
/// use mangostudio_runtime::ports::wall_clock::SystemWallClock;
/// use mangostudio_runtime::runtime_home::RuntimeSlot;
/// use mangostudio_runtime::setup::{run_non_interactive_setup, NonInteractiveSetupRequest, SetupAuthority};
/// use mangostudio_runtime_contract::manifest::ManifestProfile;
/// use std::sync::Arc;
///
/// let home = std::env::temp_dir().join("mango-setup-doctest");
/// let outcome = run_non_interactive_setup(
///     &NonInteractiveSetupRequest {
///         slot: RuntimeSlot::Host,
///         profile: (ManifestProfile::Readonly, SetupAuthority::Cli),
///         allow_overrides: &[],
///     },
///     &home,
///     &SystemWallClock,
/// )
/// .unwrap();
/// assert_eq!(outcome.profile, ManifestProfile::Readonly);
/// assert_eq!(outcome.exit_code(), 0);
///
/// // The write is visible to a real ConsentSource immediately.
/// let source = ConsentSource::new(RuntimeSlot::Host, home);
/// assert!(!source.refresh().shell);
/// ```
pub fn run_non_interactive_setup(
    request: &NonInteractiveSetupRequest<'_>,
    mango_home: &Path,
    wall_clock: &dyn WallClock,
) -> Result<SetupOutcome, SetupError> {
    let (chosen_profile, by) = request.profile;
    let base = consent_preset(chosen_profile);
    let allow = apply_allow_overrides(base, request.allow_overrides);
    let profile = crate::consent::presets::profile_for_allow(allow);

    let allow_json = serde_json::to_value(allow).expect("a struct of ten bools always serialises");
    let setup_json = serde_json::json!({
        "state": "configured",
        "at": format_iso8601_millis(wall_clock.now()),
        "by": by.as_str(),
    });

    let write = write_runtime_slot_config(
        request.slot,
        mango_home,
        &[
            ("allow", Some(allow_json)),
            ("setup", Some(setup_json)),
            ("profile", Some(serde_json::Value::from(profile.as_str()))),
        ],
    )
    .map_err(SetupError::Write)?;

    Ok(SetupOutcome {
        profile,
        allow,
        by,
        replaced_unusable: write.replaced_unusable,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ports::wall_clock::FixedWallClock;
    use crate::runtime_home::read_runtime_slot_config;
    use crate::test_support::scratch_dir as scratch_home;

    #[test]
    fn parse_boolean_accepts_the_documented_synonyms_case_insensitively() {
        for truthy in [" true ", "YES", "on", "On"] {
            assert_eq!(parse_boolean(truthy), Some(true), "for {truthy:?}");
        }
        for falsy in ["false", "NO", "off"] {
            assert_eq!(parse_boolean(falsy), Some(false), "for {falsy:?}");
        }
        assert_eq!(parse_boolean("sure"), None);
    }

    #[test]
    fn parse_allow_overrides_parses_multiple_comma_separated_pairs() {
        let overrides = parse_allow_overrides("fsWrite=false, shell=true").unwrap();
        assert_eq!(
            overrides,
            vec![("fsWrite".to_string(), false), ("shell".to_string(), true)]
        );
    }

    #[test]
    fn parse_allow_overrides_skips_a_blank_entry_from_a_trailing_comma() {
        let overrides = parse_allow_overrides("shell=true,").unwrap();
        assert_eq!(overrides, vec![("shell".to_string(), true)]);
    }

    #[test]
    fn parse_allow_overrides_rejects_a_malformed_entry() {
        let error = parse_allow_overrides("shell").unwrap_err();
        assert_eq!(error, "--allow expects key=value pairs, got \"shell\".");
    }

    #[test]
    fn parse_allow_overrides_rejects_an_unknown_capability() {
        let error = parse_allow_overrides("flying=true").unwrap_err();
        assert!(error.contains("does not know the capability \"flying\""));
    }

    #[test]
    fn parse_allow_overrides_rejects_an_unparseable_value() {
        let error = parse_allow_overrides("shell=maybe").unwrap_err();
        assert_eq!(error, "--allow shell expects true or false, got \"maybe\".");
    }

    #[test]
    fn resolve_profile_source_prefers_the_flag_over_the_environment() {
        assert_eq!(
            resolve_profile_source(Some(ManifestProfile::None), Some(ManifestProfile::Full)),
            Some((ManifestProfile::None, SetupAuthority::Cli))
        );
    }

    #[test]
    fn resolve_profile_source_falls_back_to_the_environment_and_attributes_it() {
        assert_eq!(
            resolve_profile_source(None, Some(ManifestProfile::Readonly)),
            Some((ManifestProfile::Readonly, SetupAuthority::Env))
        );
    }

    #[test]
    fn resolve_profile_source_is_none_when_neither_answers() {
        assert_eq!(resolve_profile_source(None, None), None);
    }

    #[test]
    fn parse_setup_profile_accepts_only_the_three_real_profiles() {
        assert_eq!(parse_setup_profile("full"), Some(ManifestProfile::Full));
        assert_eq!(
            parse_setup_profile("readonly"),
            Some(ManifestProfile::Readonly)
        );
        assert_eq!(parse_setup_profile("none"), Some(ManifestProfile::None));
        assert_eq!(parse_setup_profile("custom"), None);
        assert_eq!(parse_setup_profile("Full"), None);
    }

    #[test]
    fn an_unparseable_environment_value_is_fatal_only_without_a_flag() {
        let error = resolve_profile_source_from_raw_env(None, Some("sandbox")).unwrap_err();
        assert_eq!(
            error,
            "MANGOSTUDIO_RUNTIME_SETUP is \"sandbox\", which is not a profile. Use full, \
             readonly, or none."
        );
    }

    #[test]
    fn a_flag_outranks_a_broken_environment_value_instead_of_being_refused_by_it() {
        let resolved =
            resolve_profile_source_from_raw_env(Some(ManifestProfile::Full), Some("sandbox"))
                .unwrap();
        assert_eq!(resolved, Some((ManifestProfile::Full, SetupAuthority::Cli)));
    }

    #[test]
    fn a_valid_environment_value_resolves_and_is_attributed_to_env() {
        let resolved = resolve_profile_source_from_raw_env(None, Some("readonly")).unwrap();
        assert_eq!(
            resolved,
            Some((ManifestProfile::Readonly, SetupAuthority::Env))
        );
    }

    #[test]
    fn no_flag_and_no_environment_value_resolves_to_nothing_and_is_not_an_error() {
        assert_eq!(resolve_profile_source_from_raw_env(None, None), Ok(None));
    }

    #[test]
    fn a_non_interactive_setup_call_writes_the_chosen_preset() {
        let home = scratch_home("basic");
        let outcome = run_non_interactive_setup(
            &NonInteractiveSetupRequest {
                slot: RuntimeSlot::Host,
                profile: (ManifestProfile::Readonly, SetupAuthority::Cli),
                allow_overrides: &[],
            },
            &home,
            &FixedWallClock::new(std::time::UNIX_EPOCH),
        )
        .unwrap();
        assert_eq!(outcome.profile, ManifestProfile::Readonly);
        assert!(outcome.allow.fs_read);
        assert!(!outcome.allow.shell);
        assert_eq!(outcome.exit_code(), 0);

        let stored = read_runtime_slot_config(RuntimeSlot::Host, &home)
            .stored
            .unwrap();
        assert_eq!(stored["setup"]["state"], "configured");
        assert_eq!(stored["setup"]["by"], "cli");
        assert_eq!(stored["profile"], "readonly");
    }

    #[test]
    fn allow_overrides_apply_on_top_of_the_preset_and_can_produce_custom() {
        let home = scratch_home("override");
        let overrides = parse_allow_overrides("shell=true").unwrap();
        let outcome = run_non_interactive_setup(
            &NonInteractiveSetupRequest {
                slot: RuntimeSlot::Host,
                profile: (ManifestProfile::Readonly, SetupAuthority::Env),
                allow_overrides: &overrides,
            },
            &home,
            &FixedWallClock::new(std::time::UNIX_EPOCH),
        )
        .unwrap();
        assert!(outcome.allow.shell, "the override must win over the preset");
        assert_eq!(
            outcome.profile,
            ManifestProfile::Custom,
            "readonly plus shell matches no named preset"
        );
        assert_eq!(outcome.by, SetupAuthority::Env);
    }

    #[test]
    fn the_setup_at_field_is_the_wall_clocks_iso8601_instant() {
        let home = scratch_home("timestamp");
        let clock = FixedWallClock::new(
            std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000),
        );
        run_non_interactive_setup(
            &NonInteractiveSetupRequest {
                slot: RuntimeSlot::Host,
                profile: (ManifestProfile::Full, SetupAuthority::Cli),
                allow_overrides: &[],
            },
            &home,
            &clock,
        )
        .unwrap();
        let stored = read_runtime_slot_config(RuntimeSlot::Host, &home)
            .stored
            .unwrap();
        assert_eq!(stored["setup"]["at"], "2023-11-14T22:13:20.000Z");
    }
}
