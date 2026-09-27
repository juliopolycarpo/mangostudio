//! The fully-resolved, default-filled shape `runtime.json` denotes — what
//! [`crate::runtime_home::SlotFileState`]'s own module docs call "the
//! consent-policy half this crate does not build" until now.
//!
//! Mirrors `resolveRuntimeSlotConfig` in
//! `apps/shared/src/runtime-home/consent.ts`, minus three fields this
//! crate's first caller ([`crate::health`]'s `runtime.health`) has no use
//! for: `installedBy`, `hubUrl`, and `serveListen` are diagnostic-only on
//! the TypeScript side (never read by a capability decision, never asked
//! for by the `runtime.health` result schema), so [`ResolvedRuntimeSlotConfig`]
//! does not carry them. A later caller that needs one adds it then, rather
//! than this module guessing at a shape nothing reads yet.
//!
//! [`resolve_runtime_slot_config`] builds a typed struct rather than a raw
//! `serde_json::Value` — unlike [`crate::consent::invocation`], which reads
//! and writes JSON in place because it is merging into an existing
//! document. This module produces a value nothing merges into; a `struct`
//! makes every field's presence and type visible at compile time to both
//! this module's tests and [`crate::health`]'s call site, and its `Serialize`
//! impl still hands [`crate::health`] a `serde_json::Value` for free via
//! `serde_json::json!`.

use serde::Serialize;
use serde_json::Value;

use crate::consent::presets::{ResolvedCapabilityAllow, profile_for_allow};
use crate::consent::source::resolve_allow;
use crate::runtime_home::{DefaultSetupState, RuntimeSlot, default_setup_state_for_slot};
use mangostudio_runtime_contract::manifest::ManifestProfile;

/// `runtime.json`'s `setup` record, fully resolved: mirrors
/// `RuntimeSetupRecord`'s three fields (`state` always present; `at`/`by`
/// only when a real answer recorded them).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedSetupRecord {
    /// `"pending"` or `"configured"`.
    pub state: &'static str,
    /// ISO-8601 instant the state was last written, when a real answer
    /// recorded one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
    /// Who answered (`"cli"`, `"env"`, `"launch"`, `"install"`), when a real
    /// answer recorded one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub by: Option<String>,
}

/// `runtime.json`'s `audit` record, fully resolved.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedAuditConfig {
    /// Whether this slot appends protocol calls to `audit.log`.
    pub enabled: bool,
}

/// `runtime.json` with every default filled in — see the module docs for
/// which three fields of TypeScript's `ResolvedRuntimeSlotConfig` this type
/// deliberately omits.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedRuntimeSlotConfig {
    /// `runtime.json`'s own schema version; `1` when nothing stored one.
    pub schema_version: u32,
    /// The slot this config describes, as its wire spelling.
    pub slot: &'static str,
    /// Where the installed bytes came from: stored, or `fallback_source`
    /// when nothing was.
    pub source: String,
    /// The version the installed bytes report, when one was recorded.
    pub version: Option<String>,
    /// The resolved path of the binary this slot's config describes, when
    /// one was recorded.
    pub binary_path: Option<String>,
    /// `sha256:<64 hex>` of the installer's source, when one was recorded.
    pub digest: Option<String>,
    /// The source commit the installed bytes were built from, when one was
    /// recorded.
    pub source_sha: Option<String>,
    /// Re-derived from `allow`, never trusted from a stored label — see
    /// [`profile_for_allow`]'s own docs for why a hand-edited file cannot
    /// claim `readonly` while granting a shell.
    pub profile: ManifestProfile,
    /// Every capability, resolved.
    pub allow: ResolvedCapabilityAllow,
    /// Whether, and by whom, this slot's consent has been answered.
    pub setup: ResolvedSetupRecord,
    /// Whether this slot records protocol calls to `audit.log`.
    pub audit: ResolvedAuditConfig,
}

/// Fills every default `runtime.json` leaves unanswered, mirroring
/// `resolveRuntimeSlotConfig` exactly for the fields this crate carries —
/// see the module docs for the three it does not.
///
/// `fallback_source` is used verbatim when `stored` carries no `source` of
/// its own (and when there is no `stored` document at all); a caller
/// resolving `runtime.health` decides what that fallback is (see
/// [`crate::health`]'s own `bundled`/`provisioned` divergence from the
/// TypeScript runtime), so this function does not compute it itself.
///
/// # Example
///
/// ```
/// use mangostudio_runtime::consent::config::resolve_runtime_slot_config;
/// use mangostudio_runtime::runtime_home::RuntimeSlot;
///
/// let resolved = resolve_runtime_slot_config(RuntimeSlot::Host, None, "bundled");
/// assert!(resolved.allow.shell, "host defaults to full consent");
/// assert_eq!(resolved.setup.state, "configured");
/// ```
#[must_use]
pub fn resolve_runtime_slot_config(
    slot: RuntimeSlot,
    stored: Option<&Value>,
    fallback_source: &str,
) -> ResolvedRuntimeSlotConfig {
    let allow = resolve_allow(slot, stored);
    // The stored `profile` label is read nowhere in this function: it is
    // re-derived from `allow` below, the one invariant this whole module
    // exists to enforce (see the module docs on `resolveRuntimeSlotConfig`'s
    // TypeScript twin, and the type's own doc comment on `profile`).
    let profile = profile_for_allow(allow);

    let stored_str =
        |key: &str| -> Option<String> { stored?.get(key)?.as_str().map(str::to_string) };

    ResolvedRuntimeSlotConfig {
        schema_version: stored
            .and_then(|value| value.get("schemaVersion"))
            .and_then(Value::as_u64)
            .and_then(|version| u32::try_from(version).ok())
            .unwrap_or(1),
        slot: slot.as_str(),
        source: stored_str("source").unwrap_or_else(|| fallback_source.to_string()),
        version: stored_str("version"),
        binary_path: stored_str("binaryPath"),
        digest: stored_str("digest"),
        source_sha: stored_str("sourceSha"),
        profile,
        allow,
        setup: resolve_setup(slot, stored),
        audit: ResolvedAuditConfig {
            enabled: stored
                .and_then(|value| value.get("audit"))
                .and_then(|audit| audit.get("enabled"))
                .and_then(Value::as_bool)
                .unwrap_or(slot != RuntimeSlot::Host),
        },
    }
}

/// The `setup` half of [`resolve_runtime_slot_config`]: a stored record
/// (even a partial one — `at`/`by` are each read independently) is kept as
/// stored; nothing stored at all takes the slot's own default, mirroring
/// `defaultConsentForSlot`'s `setup` half.
fn resolve_setup(slot: RuntimeSlot, stored: Option<&Value>) -> ResolvedSetupRecord {
    let Some(setup) = stored.and_then(|value| value.get("setup")) else {
        return default_setup_record(slot);
    };
    let Some(state) = setup.get("state").and_then(Value::as_str) else {
        return default_setup_record(slot);
    };
    ResolvedSetupRecord {
        // The schema admits only these two spellings; a document that
        // named a third would already have failed
        // `validate_runtime_home` before this function ever saw it, so
        // anything else here falls back to `pending` rather than
        // fabricating a third wire value.
        state: if state == "configured" {
            "configured"
        } else {
            "pending"
        },
        at: setup.get("at").and_then(Value::as_str).map(str::to_string),
        by: setup.get("by").and_then(Value::as_str).map(str::to_string),
    }
}

/// What an unanswered slot's `setup` resolves to, mirroring
/// [`default_setup_state_for_slot`].
fn default_setup_record(slot: RuntimeSlot) -> ResolvedSetupRecord {
    let state = match default_setup_state_for_slot(slot) {
        DefaultSetupState::Configured => "configured",
        DefaultSetupState::Pending => "pending",
    };
    ResolvedSetupRecord {
        state,
        at: None,
        by: None,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::resolve_runtime_slot_config;
    use crate::runtime_home::RuntimeSlot;
    use mangostudio_runtime_contract::manifest::ManifestProfile;

    #[test]
    fn no_stored_file_takes_every_slot_default() {
        let resolved = resolve_runtime_slot_config(RuntimeSlot::Host, None, "bundled");
        assert_eq!(resolved.schema_version, 1);
        assert_eq!(resolved.slot, "host");
        assert_eq!(resolved.source, "bundled");
        assert!(resolved.allow.shell, "host defaults to full");
        assert_eq!(resolved.profile, ManifestProfile::Full);
        assert_eq!(resolved.setup.state, "configured");
        assert!(!resolved.audit.enabled, "host does not audit by default");

        let remote = resolve_runtime_slot_config(RuntimeSlot::Remote, None, "provisioned");
        assert!(!remote.allow.shell, "remote defaults to none");
        assert_eq!(remote.setup.state, "pending");
        assert!(remote.audit.enabled, "remote audits by default");
    }

    /// A partial stored `allow`: keys present are kept, keys missing take
    /// the slot default, and `externalAgents` takes `false` regardless of
    /// what the slot would otherwise default to.
    #[test]
    fn a_partial_stored_allow_falls_back_per_key_except_external_agents() {
        let stored = json!({
            "schemaVersion": 1,
            "slot": "host",
            "allow": { "shell": false },
        });
        let resolved = resolve_runtime_slot_config(RuntimeSlot::Host, Some(&stored), "bundled");
        assert!(!resolved.allow.shell, "the stored key wins");
        assert!(
            resolved.allow.fs_read,
            "a missing key takes the host default"
        );
        assert!(
            !resolved.allow.external_agents,
            "an absent externalAgents must never be read as consent"
        );
    }

    /// The invariant the module exists to enforce: a stored `profile` label
    /// that does not match the stored `allow` is never trusted — the
    /// *derived* profile wins.
    #[test]
    fn a_mismatched_stored_profile_label_is_overridden_by_the_derived_one() {
        let stored = json!({
            "schemaVersion": 1,
            "slot": "host",
            "profile": "readonly",
            "allow": { "shell": true },
        });
        let resolved = resolve_runtime_slot_config(RuntimeSlot::Host, Some(&stored), "bundled");
        assert_eq!(
            resolved.profile,
            ManifestProfile::Custom,
            "a set granting shell can never resolve to readonly, whatever the stored label says"
        );
    }

    #[test]
    fn a_stored_setup_record_is_kept_verbatim() {
        let stored = json!({
            "schemaVersion": 1,
            "slot": "remote",
            "setup": { "state": "configured", "at": "2026-01-01T00:00:00.000Z", "by": "cli" },
        });
        let resolved =
            resolve_runtime_slot_config(RuntimeSlot::Remote, Some(&stored), "provisioned");
        assert_eq!(resolved.setup.state, "configured");
        assert_eq!(
            resolved.setup.at.as_deref(),
            Some("2026-01-01T00:00:00.000Z")
        );
        assert_eq!(resolved.setup.by.as_deref(), Some("cli"));
    }

    #[test]
    fn a_stored_source_overrides_the_fallback() {
        let stored = json!({ "schemaVersion": 1, "slot": "host", "source": "provisioned" });
        let resolved = resolve_runtime_slot_config(RuntimeSlot::Host, Some(&stored), "bundled");
        assert_eq!(resolved.source, "provisioned");
    }
}
