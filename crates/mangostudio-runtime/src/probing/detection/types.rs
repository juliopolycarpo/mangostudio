//! The wire shapes every detector in this module builds, mirroring the
//! relevant slice of `apps/shared/src/environments/schemas.ts`'s TypeBox
//! schemas. That file is this repository's single source of truth for these
//! shapes; the definitions here are its Rust reflection, not a second
//! design.
//!
//! Every enum renames to the exact lower-kebab-case string literal the
//! TypeScript schema declares (`serde`'s `kebab-case` renaming matches
//! TypeScript's own literal spelling for every variant here), and every
//! struct renames its fields to `camelCase` — the wire shape this crate's
//! own contract already uses elsewhere (see `crate::consent::config`).
//!
//! [`RuntimeFinding::params`] is a [`std::collections::BTreeMap`], not the
//! insertion-ordered object TypeScript builds: `serde_json` has no ordered
//! map without an extra dependency this crate does not carry, so a finding
//! with more than one param key serialises in a different (sorted) order
//! than the TypeScript peer. No consumer of a finding's `params` order-
//! depends on it today; flagged here for whoever adds the fixture-parity
//! test that would notice.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// A parsed `major.minor.patch` version, always fully specified. Distinct
/// from [`MinimumRuntimeVersion`], whose `patch` may be omitted to floor a
/// whole minor line.
///
/// TypeScript carries two structurally identical copies of this shape
/// (`binary-scan.ts`'s exported `SemVer` and `lts-policy.ts`'s private
/// one) because they belong to modules that do not import from each other.
/// Rust has no equivalent reason to duplicate it, so this is the one
/// `SemVer` every module in this crate's port uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct SemVer {
    /// The major version component.
    pub major: u32,
    /// The minor version component.
    pub minor: u32,
    /// The patch version component.
    pub patch: u32,
}

/// Which runtime, version manager or agent CLI a status is about.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RuntimeId {
    /// Bun.
    Bun,
    /// Node.js.
    Node,
    /// nvm, the Node version manager.
    Nvm,
    /// fnm — the second helper-managed Node manager; the only one whose
    /// install ships on win32.
    Fnm,
    /// winget — probed as a prerequisite for the Windows recipes, never
    /// installed by MangoStudio.
    Winget,
    /// git — probed for the setup checklist and offered as a recipe on
    /// win32 only.
    Git,
    /// MangoStudio itself, as an agent-CLI target.
    Mangostudio,
    /// Claude Code.
    Claude,
    /// Codex.
    Codex,
    /// Cursor's `agent` CLI.
    Cursor,
}

/// Who put an installation where it is, as far as the scanner can tell.
///
/// `winget` is never assigned by [`crate::probing::detection::binary_scan`]
/// alone — winget's MSI and the nodejs.org MSI both land in
/// `Program Files\nodejs`, indistinguishable by path — so only a live
/// winget probe can attribute it; see
/// [`crate::probing::detection::winget_ownership`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PathSource {
    /// Everything the scanner could not attribute to anything more specific.
    System,
    /// Attributed to nvm.
    Nvm,
    /// Attributed to fnm.
    Fnm,
    /// Attributed to Volta.
    Volta,
    /// Confirmed by a live winget probe.
    Winget,
    /// Attributed to a Bun-managed install.
    Bun,
    /// Reserved for a MangoStudio-managed install.
    MangostudioManaged,
}

/// Where a candidate binary was discovered, before version-manager
/// attribution promotes a `path` origin to `version-manager`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RuntimeOrigin {
    /// Discovered by walking `PATH`.
    Path,
    /// Discovered under one of the runtime definition's well-known
    /// directories.
    WellKnown,
    /// A `path` candidate whose resolved path was attributed to a version
    /// manager.
    VersionManager,
    /// The caller's own configured path.
    Configured,
}

/// A version manager [`crate::probing::detection::binary_scan`] can attribute
/// an installation to by path pattern.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum VersionManagerId {
    /// nvm.
    Nvm,
    /// fnm.
    Fnm,
    /// Volta.
    Volta,
}

/// Where a Node line sits against its own release schedule, as
/// [`crate::probing::detection::lts_policy::classify_node_lts_status`]
/// decides it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LtsStatus {
    /// The newest patch of the current active LTS line.
    CurrentLts,
    /// A patch of the current active LTS line, behind the schedule's
    /// `latest` for it.
    LtsOutdatedPatch,
    /// An LTS line that has since been superseded by a newer LTS major.
    LtsSuperseded,
    /// Past its line's `end` date.
    EndOfLife,
    /// Started, not yet promoted to LTS.
    CurrentRelease,
    /// Could not be classified — never collapsed into a false negative or
    /// positive; see the module docs on
    /// [`crate::probing::detection::lts_policy`] for every case that lands
    /// here.
    Unknown,
}

/// The worst severity carried by any of a status's findings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RuntimeHealth {
    /// No finding escalates the badge.
    Ok,
    /// At least one finding is `warn` severity (the default when a finding
    /// carries none).
    Warn,
    /// No installation was found at all, and no candidate failed either.
    Missing,
    /// No installation was found, and at least one candidate failed to run.
    Error,
}

/// What a [`RuntimeFinding`] or [`crate::probing::detection::version_manager_support`]
/// finding is about.
///
/// This wave ports [`crate::probing::detection::duplicate_analysis`] and
/// [`crate::probing::detection::version_manager_support`] only, so only the
/// codes those two modules can actually raise are represented as reachable
/// from this crate's port today. The remaining variants belong to the wire
/// schema's agent-CLI and install-recipe findings (`cli-not-installed`,
/// `config-home-missing`, `not-authenticated`, `location-unwritable`,
/// `prerequisite-missing`) — kept here so this enum stays a faithful mirror
/// of `RuntimeFindingCodeSchema` for whichever later change raises them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RuntimeFindingCode {
    /// No canonical installation exists at all.
    NotFound,
    /// An installation exists, but none of its candidates are the one a
    /// plain shell lookup would run.
    InstalledButNotOnPath,
    /// An earlier `PATH` entry resolves to a different version than the one
    /// that actually runs.
    ShadowedByEarlierPath,
    /// More than one distinct version was found among the canonical
    /// installations.
    MultipleVersions,
    /// An installation's version falls below the caller's floor.
    VersionBelowMinimum,
    /// The effective installation's version falls below one consumer's own
    /// floor.
    VersionBelowMinimumFor,
    /// A candidate existed on disk but did not run, or ran without
    /// producing readable output.
    NotExecutable,
    /// A managed Node version's LTS classification has fallen behind.
    OutdatedLts,
    /// A version manager's configured default never landed on `PATH`.
    ManagedButNotOnPath,
    /// A candidate's probe never finished before the scan's deadline.
    ProbeTimeout,
    /// Reserved for the agent-CLI status service: the CLI itself is not
    /// installed.
    CliNotInstalled,
    /// Reserved for the agent-CLI status service: its config home does not
    /// exist.
    ConfigHomeMissing,
    /// Reserved for the agent-CLI status service: no credential signal was
    /// found.
    NotAuthenticated,
    /// A candidate ran but its output did not parse as a version.
    VersionProbeFailed,
    /// Reserved for the library-location service: a location exists but is
    /// not writable.
    LocationUnwritable,
    /// Reserved for the install-recipe service: a recipe this machine would
    /// offer needs a tool that is not there.
    PrerequisiteMissing,
}

/// `warn` escalates the owning status's [`RuntimeHealth`]; `info` is detail
/// a card can still list but that never moves the badge. Absent (`None`)
/// means `warn` — every finding predating this field escalated
/// unconditionally, so a caller that never sets it keeps that behavior.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RuntimeFindingSeverity {
    /// Escalates the owning status's health.
    Warn,
    /// Detail only; never escalates the owning status's health.
    Info,
}

/// A presence-only credential signal, as
/// [`crate::probing::detection::auth_signal`] reports it. Never a stand-in
/// for the credential's own value — see that module's docs for the privacy
/// invariant this type exists to preserve.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentAuthSignal {
    /// The credential file exists.
    FilePresent,
    /// The credential file does not exist, and its absence is a definite
    /// signed-out verdict.
    FileAbsent,
    /// The config key that signals sign-in is present.
    ConfigKeyPresent,
    /// The config that would carry the key is not there. Distinct from a
    /// config that lacks it.
    ConfigKeyAbsent,
    /// Reserved: signed in through an ephemeral session rather than a file
    /// or config key.
    Session,
    /// Could not be determined — a permission or I/O failure, never
    /// collapsed into a definite "not authenticated".
    Unknown,
}

/// A version floor a runtime has to clear. `patch` absent floors a whole
/// minor line.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MinimumRuntimeVersion {
    /// The minimum major version.
    pub major: u32,
    /// The minimum minor version, within [`MinimumRuntimeVersion::major`].
    pub minor: u32,
    /// The minimum patch version, when the floor pins one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub patch: Option<u32>,
}

/// A version floor that belongs to one consumer of a runtime, not the
/// runtime itself. `enabled` decides whether falling short of it is the
/// user's problem right now — a disabled consumer cannot fail on a version
/// it never runs against yet.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsumerVersionRequirement {
    /// The minimum major version.
    pub major: u32,
    /// The minimum minor version, within [`ConsumerVersionRequirement::major`].
    pub minor: u32,
    /// The minimum patch version, when the floor pins one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub patch: Option<u32>,
    /// The name of the consumer this floor belongs to.
    pub consumer: String,
    /// Whether this consumer is active right now.
    pub enabled: bool,
}

/// A `major`/`minor`/`patch` floor, shared by [`MinimumRuntimeVersion`] and
/// [`ConsumerVersionRequirement`] so
/// `crate::probing::detection::duplicate_analysis`'s private `is_below_floor`
/// helper can compare a parsed [`SemVer`] against either without
/// duplicating the comparison.
pub trait VersionFloor {
    /// The floor's major version.
    fn major(&self) -> u32;
    /// The floor's minor version.
    fn minor(&self) -> u32;
    /// The floor's patch version, defaulting to `0` when unset — mirroring
    /// `apps/shared/src/environments/detection/duplicate-analysis.ts`'s
    /// `right.patch ?? 0`.
    fn patch(&self) -> u32 {
        0
    }
}

impl VersionFloor for MinimumRuntimeVersion {
    fn major(&self) -> u32 {
        self.major
    }
    fn minor(&self) -> u32 {
        self.minor
    }
    fn patch(&self) -> u32 {
        self.patch.unwrap_or(0)
    }
}

impl VersionFloor for ConsumerVersionRequirement {
    fn major(&self) -> u32 {
        self.major
    }
    fn minor(&self) -> u32 {
        self.minor
    }
    fn patch(&self) -> u32 {
        self.patch.unwrap_or(0)
    }
}

/// One binary [`crate::probing::detection::binary_scan::scan_runtime`]
/// found (or the caller's configured path, probed regardless).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInstallation {
    /// The realpath-resolved location this installation actually runs from.
    pub path: String,
    /// The candidate path the scan discovered, before symlink resolution.
    pub raw_path: String,
    /// `None` when the binary ran but its output did not parse as a
    /// version.
    pub version: Option<String>,
    /// Where this candidate was discovered.
    pub origin: RuntimeOrigin,
    /// This candidate's index into the `PATH` list, when it came from
    /// `PATH`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path_index: Option<u32>,
    /// Whether this is the installation a plain shell lookup would run.
    pub effective: bool,
    /// The earlier `PATH` entry this installation's resolved path is an
    /// alias of, when one exists.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alias_of: Option<String>,
    /// The version manager this installation was attributed to, by path
    /// pattern.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub managed_by: Option<VersionManagerId>,
    /// Who put this installation where it is. Absent on a status from a
    /// peer that predates the field; read as [`PathSource::System`].
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path_source: Option<PathSource>,
}

/// One fact worth surfacing about a [`RuntimeStatus`] or
/// [`VersionManagerStatus`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeFinding {
    /// What this finding is about.
    pub code: RuntimeFindingCode,
    /// Parameters a rendered message interpolates. See the module docs for
    /// why this is a sorted map rather than an insertion-ordered one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<BTreeMap<String, String>>,
    /// This finding's severity. `None` reads as [`RuntimeFindingSeverity::Warn`].
    #[serde(skip_serializing_if = "Option::is_none")]
    pub severity: Option<RuntimeFindingSeverity>,
}

/// The published status of one runtime, as
/// [`crate::probing::detection::duplicate_analysis::analyze_runtime_scan`]
/// builds it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    /// Which runtime this status is about.
    pub id: RuntimeId,
    /// The worst severity carried by any of [`RuntimeStatus::findings`].
    pub health: RuntimeHealth,
    /// Every installation the scan found.
    pub installations: Vec<RuntimeInstallation>,
    /// The installation a plain shell lookup would run, when one exists.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effective: Option<RuntimeInstallation>,
    /// Facts worth surfacing about this runtime.
    pub findings: Vec<RuntimeFinding>,
    /// Whether MangoStudio can offer an install recipe for this runtime.
    pub installable: bool,
    /// When this status was probed, in milliseconds since the Unix epoch.
    pub probed_at_ms: u64,
}

/// One version a version manager has installed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedVersion {
    /// The bare `major.minor.patch` version string.
    pub version: String,
    /// Where this version's `node` binary resolves to.
    pub path: String,
    /// Whether this is the manager's configured default.
    pub is_default: bool,
    /// Whether this is the version the effective Node scan actually runs.
    pub is_current: bool,
    /// This version's LTS classification.
    pub lts_status: LtsStatus,
    /// This version's release-line codename, when its schedule entry has
    /// one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lts_codename: Option<String>,
}

/// The published status of one version manager.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionManagerStatus {
    /// Which version manager this status is about.
    pub id: VersionManagerId,
    /// Whether this manager is installed at all.
    pub installed: bool,
    /// The manager's root directory, when installed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
    /// The manager's own version, when it could be read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manager_version: Option<String>,
    /// Every version this manager has installed, newest first.
    pub versions: Vec<ManagedVersion>,
    /// The manager's configured default alias, before resolution.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_alias: Option<String>,
    /// The version [`VersionManagerStatus::default_alias`] resolves to.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_version: Option<String>,
    /// The version actually running, resolved against the effective Node
    /// path a runtime scan reported.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_version: Option<String>,
    /// Facts worth surfacing about this version manager.
    pub findings: Vec<RuntimeFinding>,
}
