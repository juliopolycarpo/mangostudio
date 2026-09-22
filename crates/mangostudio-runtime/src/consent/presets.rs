//! Named presets over the ten consent capabilities, and reading a stored
//! `allow` set back into one.
//!
//! Mirrors `apps/shared/src/runtime-home/consent.ts`: profiles are presets
//! over `allow`, never a second source of truth. The stored set decides,
//! and [`profile_for_allow`] re-derives the label from it, so a hand-edited
//! file cannot claim `readonly` while granting a shell.

use mangostudio_runtime_contract::manifest::ManifestProfile;
use serde::Serialize;

use crate::runtime_home::{DefaultSetupState, RuntimeSlot, default_setup_state_for_slot};

/// Every consent capability, resolved: no key is ever "unanswered" the way a
/// partially-populated `runtime.json` can leave one, because every reader of
/// this type already applied a slot's defaults. Mirrors TypeScript's
/// `ResolvedRuntimeCapabilityAllow`.
///
/// `Serialize` (`fsRead`, `fsWrite`, … — `serde`'s own `camelCase` renaming
/// of `fs_read`, `fs_write`, … needs no per-field override) is what lets
/// [`crate::health`] hand this straight to `serde_json::json!` for
/// `runtime.health`'s `allow` field, rather than re-typing the same ten
/// keys as a `serde_json::Value` by hand a second time.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedCapabilityAllow {
    /// Reading files.
    pub fs_read: bool,
    /// Writing, moving, or deleting files.
    pub fs_write: bool,
    /// Running arbitrary shell commands.
    pub shell: bool,
    /// Running `git`.
    pub git: bool,
    /// Detecting toolchains, version managers, and agent CLIs.
    pub probing: bool,
    /// Connecting to MCP servers.
    pub mcp: bool,
    /// Reading and writing agent library files.
    pub library: bool,
    /// Capturing and reverting filesystem snapshots.
    pub checkpoints: bool,
    /// Replacing this runtime's own binary with one a hub offers.
    pub update: bool,
    /// Launching vendor-owned agent processes.
    pub external_agents: bool,
}

impl ResolvedCapabilityAllow {
    /// Whether `capability` (one of
    /// [`capability_keys`](mangostudio_runtime_contract::manifest::capability_keys)'s
    /// wire names) is granted. `false` for a name this build does not recognise — an
    /// unrecognised capability was never granted, the same answer an absent
    /// key gets.
    ///
    /// # Example
    ///
    /// ```
    /// use mangostudio_runtime::consent::presets::consent_preset;
    /// use mangostudio_runtime_contract::manifest::ManifestProfile;
    ///
    /// let readonly = consent_preset(ManifestProfile::Readonly);
    /// assert!(readonly.is_granted("fsRead"));
    /// assert!(!readonly.is_granted("shell"));
    /// assert!(!readonly.is_granted("no.such.capability"));
    /// ```
    #[must_use]
    pub fn is_granted(&self, capability: &str) -> bool {
        let mut copy = *self;
        copy.capability_mut(capability)
            .is_some_and(|granted| *granted)
    }

    /// Grants or withholds `capability`; returns `false`, changing nothing,
    /// for a name this build does not recognise.
    ///
    /// # Example
    ///
    /// ```
    /// use mangostudio_runtime::consent::presets::consent_preset;
    /// use mangostudio_runtime_contract::manifest::ManifestProfile;
    ///
    /// let mut allow = consent_preset(ManifestProfile::None);
    /// assert!(allow.set("shell", true));
    /// assert!(allow.shell);
    /// assert!(!allow.set("no.such.capability", true));
    /// ```
    pub fn set(&mut self, capability: &str, granted: bool) -> bool {
        self.capability_mut(capability)
            .map(|slot| *slot = granted)
            .is_some()
    }

    /// The field behind one of
    /// [`capability_keys`](mangostudio_runtime_contract::manifest::capability_keys)'s
    /// wire names: the one place that maps a key to its field.
    fn capability_mut(&mut self, capability: &str) -> Option<&mut bool> {
        match capability {
            "fsRead" => Some(&mut self.fs_read),
            "fsWrite" => Some(&mut self.fs_write),
            "shell" => Some(&mut self.shell),
            "git" => Some(&mut self.git),
            "probing" => Some(&mut self.probing),
            "mcp" => Some(&mut self.mcp),
            "library" => Some(&mut self.library),
            "checkpoints" => Some(&mut self.checkpoints),
            "update" => Some(&mut self.update),
            "externalAgents" => Some(&mut self.external_agents),
            _ => None,
        }
    }
}

/// `full`: every capability granted.
const FULL: ResolvedCapabilityAllow = ResolvedCapabilityAllow {
    fs_read: true,
    fs_write: true,
    shell: true,
    git: true,
    probing: true,
    mcp: true,
    library: true,
    checkpoints: true,
    update: true,
    external_agents: true,
};

/// `readonly`: nothing that changes this machine. `checkpoints` stays off
/// even though it reads like a read — a checkpoint writes a snapshot of the
/// file it captures, and a profile whose promise is "nothing on this
/// machine changes" cannot make an exception for the feature that exists to
/// change files back. Mirrors `RUNTIME_CONSENT_PRESETS.readonly`.
const READONLY: ResolvedCapabilityAllow = ResolvedCapabilityAllow {
    fs_read: true,
    fs_write: false,
    shell: false,
    git: true,
    probing: true,
    mcp: false,
    library: true,
    checkpoints: false,
    update: false,
    external_agents: false,
};

/// `none`: nothing granted.
const NONE: ResolvedCapabilityAllow = ResolvedCapabilityAllow {
    fs_read: false,
    fs_write: false,
    shell: false,
    git: false,
    probing: false,
    mcp: false,
    library: false,
    checkpoints: false,
    update: false,
    external_agents: false,
};

/// The capability set a named, non-`custom` profile expands to. Mirrors
/// `RUNTIME_CONSENT_PRESETS`; `custom` is deliberately absent there too — it
/// is what any other combination is called, not something a caller can ask
/// for.
///
/// # Example
///
/// ```
/// use mangostudio_runtime::consent::presets::consent_preset;
/// use mangostudio_runtime_contract::manifest::ManifestProfile;
///
/// assert!(consent_preset(ManifestProfile::Full).shell);
/// assert!(!consent_preset(ManifestProfile::None).shell);
/// ```
///
/// # Panics
/// If `profile` is [`ManifestProfile::Custom`] — there is no one set a
/// caller asking for `custom` could mean.
#[must_use]
pub fn consent_preset(profile: ManifestProfile) -> ResolvedCapabilityAllow {
    match profile {
        ManifestProfile::Full => FULL,
        ManifestProfile::Readonly => READONLY,
        ManifestProfile::None => NONE,
        ManifestProfile::Custom => {
            panic!("\"custom\" names any set that matches no preset, not a preset of its own")
        }
    }
}

/// Names the stored set, or [`ManifestProfile::Custom`] when it matches no
/// preset. Mirrors `profileForAllow` exactly, including its one asymmetry:
/// a resolved `allow` already carries a concrete `external_agents`, so the
/// "an omitted `externalAgents` reads as denied" note on the TypeScript
/// function does not apply here — this crate's [`ResolvedCapabilityAllow`]
/// has already made that resolution by the time anything calls this.
///
/// # Example
///
/// ```
/// use mangostudio_runtime::consent::presets::{consent_preset, profile_for_allow};
/// use mangostudio_runtime_contract::manifest::ManifestProfile;
///
/// assert_eq!(
///     profile_for_allow(consent_preset(ManifestProfile::Readonly)),
///     ManifestProfile::Readonly
/// );
/// let mut custom = consent_preset(ManifestProfile::None);
/// custom.shell = true;
/// assert_eq!(profile_for_allow(custom), ManifestProfile::Custom);
/// ```
#[must_use]
pub fn profile_for_allow(allow: ResolvedCapabilityAllow) -> ManifestProfile {
    [
        (ManifestProfile::Full, FULL),
        (ManifestProfile::Readonly, READONLY),
        (ManifestProfile::None, NONE),
    ]
    .into_iter()
    .find_map(|(profile, preset)| (preset == allow).then_some(profile))
    .unwrap_or(ManifestProfile::Custom)
}

/// What a slot means when nothing has answered for it yet: `host` and `wsl`
/// were placed by somebody with an account on this machine, so absence
/// there means full consent; `remote` was placed by somebody's hub, so
/// absence there means nobody has answered. Mirrors
/// `defaultConsentForSlot`'s `allow` half — the `setup` half is
/// [`default_setup_state_for_slot`], already owned by [`crate::runtime_home`].
///
/// # Example
///
/// ```
/// use mangostudio_runtime::consent::presets::default_consent_for_slot;
/// use mangostudio_runtime::runtime_home::RuntimeSlot;
///
/// assert!(default_consent_for_slot(RuntimeSlot::Host).shell);
/// assert!(!default_consent_for_slot(RuntimeSlot::Remote).shell);
/// ```
#[must_use]
pub fn default_consent_for_slot(slot: RuntimeSlot) -> ResolvedCapabilityAllow {
    match default_setup_state_for_slot(slot) {
        DefaultSetupState::Configured => FULL,
        DefaultSetupState::Pending => NONE,
    }
}

#[cfg(test)]
mod tests {
    use mangostudio_runtime_contract::manifest::{ManifestProfile, capability_keys};

    use super::{
        FULL, NONE, READONLY, consent_preset, default_consent_for_slot, profile_for_allow,
    };
    use crate::runtime_home::RuntimeSlot;

    #[test]
    fn full_grants_every_capability() {
        for key in capability_keys() {
            assert!(FULL.is_granted(key), "expected {key} granted under full");
        }
    }

    #[test]
    fn none_grants_nothing() {
        for key in capability_keys() {
            assert!(!NONE.is_granted(key), "expected {key} denied under none");
        }
    }

    #[test]
    fn readonly_grants_reads_but_not_writes_or_shell() {
        assert!(READONLY.is_granted("fsRead"));
        assert!(READONLY.is_granted("git"));
        assert!(READONLY.is_granted("probing"));
        assert!(READONLY.is_granted("library"));
        assert!(!READONLY.is_granted("fsWrite"));
        assert!(!READONLY.is_granted("shell"));
        assert!(!READONLY.is_granted("mcp"));
        assert!(!READONLY.is_granted("update"));
        assert!(!READONLY.is_granted("externalAgents"));
    }

    /// The specific rule the module docs call out: checkpoints stays off
    /// under `readonly` even though a snapshot capture reads like a read.
    #[test]
    fn readonly_denies_checkpoints() {
        assert!(!READONLY.is_granted("checkpoints"));
    }

    #[test]
    fn an_unrecognised_capability_name_reads_as_denied() {
        assert!(!FULL.is_granted("no.such.capability"));
    }

    #[test]
    #[should_panic(expected = "not a preset of its own")]
    fn asking_for_the_custom_preset_panics() {
        let _ = consent_preset(ManifestProfile::Custom);
    }

    #[test]
    fn profile_for_allow_round_trips_every_named_preset() {
        assert_eq!(profile_for_allow(FULL), ManifestProfile::Full);
        assert_eq!(profile_for_allow(READONLY), ManifestProfile::Readonly);
        assert_eq!(profile_for_allow(NONE), ManifestProfile::None);
    }

    #[test]
    fn a_set_matching_no_preset_is_custom() {
        let mut mixed = NONE;
        mixed.shell = true;
        assert_eq!(profile_for_allow(mixed), ManifestProfile::Custom);
    }

    #[test]
    fn host_and_wsl_default_to_full_and_remote_defaults_to_none() {
        assert_eq!(default_consent_for_slot(RuntimeSlot::Host), FULL);
        assert_eq!(default_consent_for_slot(RuntimeSlot::Wsl), FULL);
        assert_eq!(default_consent_for_slot(RuntimeSlot::Remote), NONE);
    }

    /// `serde`'s own `camelCase` renaming must actually produce the wire
    /// names `capability_keys()` promises (`fs_read` -> `fsRead`, and so
    /// on) — the property [`crate::health`]'s `runtime.health` result
    /// depends on to hand this type straight to `serde_json::json!`.
    #[test]
    fn serialises_with_the_wire_capability_names() {
        let value = serde_json::to_value(FULL).unwrap();
        for key in capability_keys() {
            assert_eq!(
                value.get(key),
                Some(&serde_json::Value::Bool(true)),
                "expected {key} present and true in the serialised form"
            );
        }
    }
}
