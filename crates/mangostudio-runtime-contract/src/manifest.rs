//! What a runtime announces about itself in `hello.capabilities`.
//!
//! Mirrors `apps/shared/src/runtime-contract/manifest.ts`. The TypeScript
//! schema reads two absences two different ways, and a Rust manifest builder
//! has to pick a side rather than reproduce the ambiguity:
//!
//! - **`features`**: absent means **granted**. An older peer that predates a
//!   feature flag is assumed to have it, so it is not silently stripped of
//!   tools a hub already trusted.
//! - **The optional top-level members** (`gh`, `terminal`, `identityIsolation`,
//!   `externalAgents`, and friends): absent means **unavailable**. A peer that
//!   never ran the probe has not answered "yes".
//!
//! [`RuntimeCapabilityManifest`] makes every feature key mandatory and
//! defaults it to `false`: a manifest built here can never omit `features`
//! and accidentally advertise the entire catalog by silence, which is exactly
//! the failure mode the TypeScript schema's own doc comment warns about. The
//! optional top-level members stay `Option`, `None` by default, matching
//! their own "absent means unavailable" reading.

use serde::{Deserialize, Serialize};

/// A runtime's shell, one of the three `RuntimeCapabilityManifestSchema` names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeShellKind {
    /// Bourne-again shell.
    Bash,
    /// Z shell.
    Zsh,
    /// Windows PowerShell.
    Powershell,
}

/// How a runtime's host resolves paths.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PathStyle {
    /// Forward-slash paths.
    Posix,
    /// Windows drive-letter paths.
    Win32,
}

/// Whether a CLI is present on the machine, and which version.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitAvailability {
    /// Whether the binary was found on `PATH`.
    pub available: bool,
    /// The version string the binary reported, when it was found.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub version: Option<String>,
}

/// A vendor CLI this runtime can host an adapter for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExternalAgentTarget {
    /// OpenAI's Codex CLI.
    Codex,
    /// Cursor's CLI.
    Cursor,
    /// Anthropic's Claude Code CLI.
    Claude,
}

/// How a hub isolates one MangoStudio user's vendor credentials from another
/// on a shared machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum IdentityIsolationMethod {
    /// One host machine serves exactly one MangoStudio user.
    SingleUserHost,
    /// A distinct OS account per MangoStudio user.
    OsAccount,
    /// A distinct container per MangoStudio user.
    Container,
}

/// A runtime's positive attestation of per-user vendor credential isolation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalIdentityIsolation {
    /// How the isolation is achieved.
    pub method: IdentityIsolationMethod,
    /// Opaque, non-reversible digest used only to detect a changed credential home.
    pub credential_home_fingerprint: String,
}

/// The consent profile that produced [`RuntimeCapabilityManifest::features`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ManifestProfile {
    /// Every capability this build supports is granted.
    Full,
    /// Only read-oriented capabilities are granted.
    Readonly,
    /// Nothing is granted.
    None,
    /// An owner-picked mix of capabilities.
    Custom,
}

/// What the machine's owner granted, before intersection with what the
/// machine actually has. Mirrors `RuntimeCapabilityAllowSchema`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCapabilityAllow {
    /// Reading files.
    pub fs_read: bool,
    /// Writing, moving, or deleting files.
    pub fs_write: bool,
    /// Running arbitrary shell commands. See the TypeScript `SHELL_TRUST_NOTICE`.
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
    /// Launching vendor-owned agent processes. Absent on disk for old files;
    /// resolution treats absence as `false`, never as consent.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub external_agents: Option<bool>,
}

/// The `features` map: every key mandatory, `false` unless the capability is
/// both implemented and consented.
///
/// The TypeScript schema treats an absent optional key here as **granted**
/// — see the module docs. This type refuses that ambiguity structurally:
/// there is no way to construct one that omits a key, so a Rust-built
/// manifest can only ever grant a feature by explicitly setting it `true`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCapabilityFeatures {
    /// Executing declared tools.
    pub tools: bool,
    /// `git.exec`.
    pub git: bool,
    /// `probing.*`.
    pub probing: bool,
    /// `mcp.*`.
    pub mcp: bool,
    /// `library.*`.
    pub library: bool,
    /// `snapshot.*`.
    pub checkpoints: bool,
    /// `fs.read-file`, `fs.list-directory`, `fs.glob`, `fs.grep`.
    pub fs_read: bool,
    /// `fs.write-file` and the other mutating `fs.*` methods.
    pub fs_write: bool,
    /// `shell.run`.
    pub shell: bool,
    /// `runtime.update.*`.
    pub update: bool,
    /// `external-agent.*`.
    pub external_agents: bool,
    /// Whether spawn methods accept a `toolchain` selection.
    pub toolchain: bool,
}

/// What a runtime announces about itself in `hello.capabilities`.
///
/// See the module docs for the `features`-vs-optional-top-level-member
/// asymmetry this type resolves. Build one with [`RuntimeCapabilityManifest::new`],
/// which fills every feature `false` and every optional member `None`, then
/// set only what the runtime actually supports and was consented.
///
/// # Write-only, by design
///
/// This type derives `Serialize` only. Nothing in this repository deserialises a
/// `RuntimeCapabilityManifest` today — the runtime builds one and hands it to a hub, and no
/// hub-side reader parses one back into this type. That asymmetry is intentional, not an
/// oversight: a contract-legal manifest from an older runtime (built before a feature like
/// `fsRead` or `toolchain` existed) omits that key entirely, and the wire's own semantics (see
/// the module docs) read an absent `features` key as **granted**, never as `false`. This
/// struct makes every feature key mandatory precisely so a Rust-built manifest can never
/// reproduce that omission by accident — which is exactly why it must not also be the type a
/// peer's manifest is deserialised into. Adding `#[serde(default)]` to the newer feature
/// fields would compile, but it would read a missing key as `false`, inverting the wire's
/// "absent means granted" rule for exactly the peers this asymmetry exists to protect.
///
/// A future reader of a peer's manifest needs a *separate* type, with every feature field
/// `Option<bool>`, and an asymmetric resolver: `unwrap_or(true)` for `tools`, `git`,
/// `probing`, `mcp`, `library`, `checkpoints`, `fsRead`, `fsWrite`, `shell`, and `update` (the
/// features that predate this manifest shape), `unwrap_or(false)` for `externalAgents` and
/// `toolchain` (features that were never ambiguous — a peer that never announced them never
/// had them). Build that type deliberately, with a test pinning both readings, rather than
/// reaching for `#[serde(default)]` here.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCapabilityManifest {
    /// The host operating system, e.g. `"linux"`, `"darwin"`, `"win32"`.
    pub platform: String,
    /// The host CPU architecture, e.g. `"x86_64"`, `"aarch64"`.
    pub arch: String,
    /// How this runtime's host resolves paths.
    pub path_style: PathStyle,
    /// The runtime process owner's home directory, in the host's own path style.
    pub home_dir: String,
    /// Shells this runtime can open an interactive session with.
    pub shells: Vec<RuntimeShellKind>,
    /// Whether `git` is on `PATH`, and which version.
    pub git: GitAvailability,
    /// Whether the GitHub CLI is on `PATH`, for `gh.exec` / `gh.mutate`.
    /// Absent means unavailable, not merely unannounced.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub gh: Option<GitAvailability>,
    /// Every feature key, explicitly. See the type's own docs.
    pub features: RuntimeCapabilityFeatures,
    /// Vendor CLIs this runtime hosts an adapter for. Absent means none.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub external_agents: Option<Vec<ExternalAgentTarget>>,
    /// This runtime's positive attestation of per-user credential isolation.
    /// Absent is unproven, never a denial.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub identity_isolation: Option<ExternalIdentityIsolation>,
    /// Whether this runtime can open an interactive PTY. Absent means
    /// unavailable, not merely unannounced.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub terminal: Option<bool>,
    /// Whether this runtime re-checks the paths a hub names against the
    /// path filter a call carried. Absent means `false`.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub enforces_path_policy: Option<bool>,
    /// Whether this runtime can publish new slot bytes on Windows. Absent
    /// means `false`.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub publishes_windows_slot: Option<bool>,
    /// Which directory-hash domain this runtime computes. Absent means v2.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub directory_hash_domain: Option<u32>,
    /// The consent profile that produced `features`. Absent on older peers.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub profile: Option<ManifestProfile>,
    /// What the machine's owner granted, before intersection with what the
    /// machine actually has. Absent on older peers.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub allow: Option<RuntimeCapabilityAllow>,
}

impl RuntimeCapabilityManifest {
    /// Builds a manifest with the required identity fields filled in, every
    /// feature `false`, and every optional member `None` — the safe default
    /// this type exists to make the only reachable one. Set fields on the
    /// result to announce what this runtime actually supports.
    ///
    /// # Example
    ///
    /// ```
    /// use mangostudio_runtime_contract::manifest::{
    ///     GitAvailability, PathStyle, RuntimeCapabilityManifest, RuntimeShellKind,
    /// };
    ///
    /// let mut manifest = RuntimeCapabilityManifest::new(
    ///     "linux",
    ///     "x86_64",
    ///     PathStyle::Posix,
    ///     "/home/mango",
    ///     [RuntimeShellKind::Bash],
    ///     GitAvailability { available: true, version: Some("2.43.0".into()) },
    /// );
    /// assert!(!manifest.features.fs_read);
    /// manifest.features.fs_read = true;
    /// assert!(manifest.gh.is_none());
    /// ```
    #[must_use]
    pub fn new(
        platform: impl Into<String>,
        arch: impl Into<String>,
        path_style: PathStyle,
        home_dir: impl Into<String>,
        shells: impl IntoIterator<Item = RuntimeShellKind>,
        git: GitAvailability,
    ) -> Self {
        Self {
            platform: platform.into(),
            arch: arch.into(),
            path_style,
            home_dir: home_dir.into(),
            shells: shells.into_iter().collect(),
            git,
            gh: None,
            features: RuntimeCapabilityFeatures::default(),
            external_agents: None,
            identity_isolation: None,
            terminal: None,
            enforces_path_policy: None,
            publishes_windows_slot: None,
            directory_hash_domain: None,
            profile: None,
            allow: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, to_value};

    use super::{GitAvailability, PathStyle, RuntimeCapabilityManifest, RuntimeShellKind};
    use crate::schemas::validate_manifest;

    fn minimal() -> RuntimeCapabilityManifest {
        RuntimeCapabilityManifest::new(
            "linux",
            "x86_64",
            PathStyle::Posix,
            "/home/mango",
            [RuntimeShellKind::Bash],
            GitAvailability {
                available: true,
                version: Some("2.43.0".into()),
            },
        )
    }

    #[test]
    fn a_minimal_manifest_grants_nothing() {
        let manifest = minimal();
        let features = manifest.features;
        assert!(!features.tools);
        assert!(!features.fs_read);
        assert!(!features.fs_write);
        assert!(!features.external_agents);
    }

    #[test]
    fn a_minimal_manifest_leaves_every_optional_member_absent() {
        let manifest = minimal();
        assert!(manifest.gh.is_none());
        assert!(manifest.external_agents.is_none());
        assert!(manifest.identity_isolation.is_none());
        assert!(manifest.terminal.is_none());
        assert!(manifest.enforces_path_policy.is_none());
        assert!(manifest.publishes_windows_slot.is_none());
        assert!(manifest.directory_hash_domain.is_none());
        assert!(manifest.profile.is_none());
        assert!(manifest.allow.is_none());
    }

    #[test]
    fn a_minimal_manifest_validates_against_manifest_schema_json() {
        let value = to_value(minimal()).expect("serialises");
        assert!(validate_manifest(&value).is_ok(), "{value}");
    }

    /// Reads the feature key list from `manifest.schema.json` itself rather
    /// than typing it a second time — the regression this guards against is
    /// a feature key this type has that the embedded schema does not (or the
    /// reverse), which `manifest.schema.json`'s own `additionalProperties`
    /// leniency would otherwise let slip past `validate_manifest`.
    #[test]
    fn every_declared_feature_key_is_present_and_false_on_the_wire() {
        let schema: Value =
            serde_json::from_str(crate::schemas::MANIFEST_SCHEMA_JSON).expect("well-formed JSON");
        let declared_keys = schema["properties"]["features"]["properties"]
            .as_object()
            .expect("features has named properties")
            .keys()
            .cloned()
            .collect::<Vec<_>>();

        let value = to_value(minimal()).expect("serialises");
        let features = value["features"].as_object().expect("features is present");

        assert!(!declared_keys.is_empty());
        for key in declared_keys {
            assert_eq!(
                features.get(&key),
                Some(&Value::Bool(false)),
                "expected features.{key} to be present and false | received: {features:?}"
            );
        }
    }
}
