//! What [`crate::probing::detection::nvm::detect_nvm`] and
//! [`crate::probing::detection::fnm::detect_fnm`] genuinely share, mirroring
//! `apps/shared/src/environments/detection/version-manager-support.ts`:
//! comparing and sorting the version strings both managers write as
//! directory names, turning a raw installed-version scan into the
//! [`crate::probing::detection::types::ManagedVersion`] shape the schema
//! wants, and the two findings every version-manager status can raise. Each
//! detector's own file layout, alias resolution and root discovery stay in
//! that detector's own module — those differ enough between the two
//! managers that sharing them would cost more than it saves.

use std::collections::BTreeMap;
use std::sync::Arc;

use regex::Regex;
use std::sync::LazyLock;

use super::BoxFuture;
use super::lts_policy::{
    LtsPolicyOptions, NodeReleaseSchedule, classify_node_lts_status, find_node_release_line,
    parse_exact_node_version,
};
use super::types::{ManagedVersion, RuntimeFinding, RuntimeFindingCode, VersionManagerId};

/// The filesystem seams both detectors need: read a directory
/// (`versions/node`, `node-versions`), check whether a path exists, and
/// follow a symlink or junction to its target. nvm additionally reads file
/// contents (`nvm.sh`, an `alias/*` file) through
/// [`crate::probing::detection::nvm::NvmFileSystem`]; fnm's aliases are
/// symlinks it never needs to read as text, so its own filesystem type is
/// exactly this one.
pub trait ManagedVersionFileSystem: Send + Sync + 'static {
    /// Whether `path` exists on disk.
    fn path_exists<'a>(&'a self, path: &'a str) -> BoxFuture<'a, bool>;
    /// Lists `path`'s entries, or `Err(())` when it cannot be read (missing,
    /// not a directory, permission denied — the caller treats every one of
    /// these the same way: an empty listing).
    fn read_directory<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Result<Vec<String>, ()>>;
    /// Resolves `path` through any symlink or junction.
    fn realpath<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Result<String, ()>>;
}

/// Lists `path`, or an empty list when it cannot be read at all — a
/// version-manager root that has no `versions` directory yet is not an
/// error, just nothing installed.
pub async fn list_optional_directory(fs: &dyn ManagedVersionFileSystem, path: &str) -> Vec<String> {
    fs.read_directory(path).await.unwrap_or_default()
}

/// How both managers name a version directory: `24.18.0`, optionally
/// `v`-prefixed.
static VERSION_DIRECTORY_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^v?(\d+\.\d+\.\d+)$").expect("a fixed, hand-checked pattern"));

/// One version a manager has installed: the bare version string, and the
/// path its `node` binary resolves to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstalledVersion {
    /// The bare `major.minor.patch` version string.
    pub version: String,
    /// Where this version's `node` binary resolves to.
    pub path: String,
}

/// One version directory, or `None` when it names no installed Node.
async fn read_version(
    fs: &dyn ManagedVersionFileSystem,
    entry: &str,
    node_binary_path_for: &(dyn Fn(&str) -> String + Send + Sync),
) -> Option<InstalledVersion> {
    let captures = VERSION_DIRECTORY_PATTERN.captures(entry)?;
    let version = captures.get(1)?.as_str().to_string();
    let node_path = node_binary_path_for(entry);
    if !fs.path_exists(&node_path).await {
        return None;
    }

    match fs.realpath(&node_path).await {
        Ok(resolved) => Some(InstalledVersion {
            version,
            path: resolved,
        }),
        // The binary exists, so retain its stable layout path when realpath
        // fails.
        Err(()) => Some(InstalledVersion {
            version,
            path: node_path,
        }),
    }
}

/// The versions a manager has installed under `versions_root`, newest
/// first.
///
/// Only the binary's location differs between the two managers — nvm keeps
/// it at `<version>/bin/node`, fnm at `<version>/installation/bin/node` —
/// so that is the whole callback, and everything around it (which
/// directory names count as a version, that the binary must exist, that a
/// failed realpath keeps the layout path) is one rule rather than two.
///
/// Each version directory is independent, so this checks all of them
/// concurrently (`tokio::task::JoinSet`, mirroring the TypeScript
/// original's `Promise.all`) rather than one round trip at a time — a
/// machine with eight installed versions pays one wave, not eight.
///
/// # Example
///
/// ```
/// use std::sync::Arc;
/// use mangostudio_runtime::probing::detection::version_manager_support::{
///     ManagedVersionFileSystem, read_managed_versions,
/// };
///
/// # struct EmptyFs;
/// # impl ManagedVersionFileSystem for EmptyFs {
/// #     fn path_exists<'a>(&'a self, _path: &'a str) -> mangostudio_runtime::probing::detection::BoxFuture<'a, bool> {
/// #         Box::pin(async { false })
/// #     }
/// #     fn read_directory<'a>(&'a self, _path: &'a str) -> mangostudio_runtime::probing::detection::BoxFuture<'a, Result<Vec<String>, ()>> {
/// #         Box::pin(async { Err(()) })
/// #     }
/// #     fn realpath<'a>(&'a self, path: &'a str) -> mangostudio_runtime::probing::detection::BoxFuture<'a, Result<String, ()>> {
/// #         let path = path.to_string();
/// #         Box::pin(async { Ok(path) })
/// #     }
/// # }
/// # #[tokio::main(flavor = "current_thread")]
/// # async fn main() {
/// let versions = read_managed_versions(
///     Arc::new(EmptyFs),
///     "/home/a/.nvm/versions/node",
///     Arc::new(|dir: &str| format!("/home/a/.nvm/versions/node/{dir}/bin/node")),
/// )
/// .await;
/// assert!(versions.is_empty());
/// # }
/// ```
pub async fn read_managed_versions(
    fs: Arc<dyn ManagedVersionFileSystem>,
    versions_root: &str,
    node_binary_path_for: Arc<dyn Fn(&str) -> String + Send + Sync>,
) -> Vec<InstalledVersion> {
    let entries = list_optional_directory(fs.as_ref(), versions_root).await;

    let mut workers = tokio::task::JoinSet::new();
    for entry in entries {
        let fs = Arc::clone(&fs);
        let node_binary_path_for = Arc::clone(&node_binary_path_for);
        workers.spawn(async move {
            read_version(fs.as_ref(), &entry, node_binary_path_for.as_ref()).await
        });
    }

    let mut versions = Vec::new();
    while let Some(result) = workers.join_next().await {
        if let Ok(Some(version)) = result {
            versions.push(version);
        }
    }
    sort_versions_descending(versions)
}

/// Ascending exact-semver comparison for the version strings nvm and fnm
/// both write as directory names (`24.18.0`, optionally `v`-prefixed on
/// disk). Anything that does not parse falls back to lexical order (Rust's
/// `str::cmp`, the equivalent of TypeScript's `localeCompare` for the
/// plain ASCII directory names both managers write) rather than
/// panicking — a directory a version manager did not create should still
/// sort somewhere, not abort the scan.
#[must_use]
pub fn compare_version_strings(left: &str, right: &str) -> std::cmp::Ordering {
    match (
        parse_exact_node_version(left),
        parse_exact_node_version(right),
    ) {
        (Some(left), Some(right)) => left.cmp(&right),
        _ => left.cmp(right),
    }
}

/// Descending by version, newest first — the order both managers' version
/// lists render in.
#[must_use]
pub fn sort_versions_descending(mut versions: Vec<InstalledVersion>) -> Vec<InstalledVersion> {
    versions.sort_by(|left, right| compare_version_strings(&right.version, &left.version));
    versions
}

/// Keeps the newest version seen for each major, seeding the map
/// [`super::lts_policy::classify_node_lts_status`] compares a line's latest
/// patch against.
pub fn prefer_newer_version(latest_by_major: &mut BTreeMap<u32, String>, version_value: &str) {
    let Some(version) = parse_exact_node_version(version_value) else {
        return;
    };
    let replace = match latest_by_major.get(&version.major) {
        None => true,
        Some(existing) => compare_version_strings(version_value, existing).is_gt(),
    };
    if replace {
        latest_by_major.insert(version.major, version_value.to_string());
    }
}

/// Path equality for comparing a manager's installed-version paths against
/// the effective Node path a runtime scan reported: exact on POSIX,
/// case-insensitive on Windows. Distinct from
/// [`super::binary_scan::normalized_path`], which always lowercases — that
/// one classifies *any* runtime's path, this one only ever compares two
/// paths on the same host.
#[must_use]
pub fn normalized_managed_path(path: &str, platform: &str) -> String {
    let normalized = path.replace('\\', "/");
    let normalized = normalized.trim_end_matches('/');
    if platform == "win32" {
        normalized.to_lowercase()
    } else {
        normalized.to_string()
    }
}

/// Which installed version is the one actually running, found by comparing
/// each candidate's resolved path against the effective Node path the same
/// scan the toolchain tab shows already reported.
#[must_use]
pub fn find_current_version(
    installed: &[InstalledVersion],
    current_node_path: Option<&str>,
    platform: &str,
) -> Option<String> {
    let current_node_path = current_node_path?;
    let current_path = normalized_managed_path(current_node_path, platform);
    installed
        .iter()
        .find(|version| normalized_managed_path(&version.path, platform) == current_path)
        .map(|version| version.version.clone())
}

/// Inputs [`to_managed_versions`] needs beyond the raw installed-version
/// scan itself.
pub struct ManagedVersionListOptions<'a> {
    /// The release schedule to classify each version against.
    pub schedule: &'a NodeReleaseSchedule,
    /// The instant to classify against.
    pub now: std::time::SystemTime,
    /// The newest known patch per major, from a live probe.
    pub latest_by_major: BTreeMap<u32, String>,
    /// Whether [`ManagedVersionListOptions::latest_by_major`] came from a
    /// live probe recent enough to excuse a stale bundled schedule.
    pub live_data_available: Option<bool>,
    /// The manager's configured default, once resolved to a bare version.
    pub default_version: Option<String>,
    /// The version actually running.
    pub current_version: Option<String>,
}

/// Turns a manager's raw installed-version scan into the
/// [`ManagedVersion`] list both `detect_nvm` and `detect_fnm` publish: LTS
/// status per version, plus the default/current flags derived from what
/// the caller already resolved.
#[must_use]
pub fn to_managed_versions(
    installed: &[InstalledVersion],
    options: &ManagedVersionListOptions<'_>,
) -> Vec<ManagedVersion> {
    installed
        .iter()
        .map(|version| {
            let release_line = find_node_release_line(options.schedule, &version.version);
            let lts_options = LtsPolicyOptions {
                now: options.now,
                latest_by_major: options.latest_by_major.clone(),
                live_data_available: options.live_data_available,
            };
            ManagedVersion {
                version: version.version.clone(),
                path: version.path.clone(),
                is_default: Some(&version.version) == options.default_version.as_ref(),
                is_current: Some(&version.version) == options.current_version.as_ref(),
                lts_status: classify_node_lts_status(
                    &version.version,
                    options.schedule,
                    &lts_options,
                ),
                lts_codename: release_line
                    .and_then(|line| line.codename)
                    .map(str::to_string),
            }
        })
        .collect()
}

/// Findings both detectors raise from the same shape of answer: a
/// configured default that never landed on `PATH`, and any managed version
/// whose LTS classification has fallen behind.
#[must_use]
pub fn create_managed_version_findings(
    manager: VersionManagerId,
    default_alias: Option<&str>,
    default_version: Option<&str>,
    current_version: Option<&str>,
    versions: &[ManagedVersion],
) -> Vec<RuntimeFinding> {
    let mut findings = Vec::new();
    if let Some(default_alias) = default_alias
        && current_version.is_none()
    {
        let mut params = BTreeMap::new();
        params.insert("manager".to_string(), manager_param(manager));
        params.insert("defaultAlias".to_string(), default_alias.to_string());
        if let Some(default_version) = default_version {
            params.insert("defaultVersion".to_string(), default_version.to_string());
        }
        findings.push(RuntimeFinding {
            code: RuntimeFindingCode::ManagedButNotOnPath,
            params: Some(params),
            severity: None,
        });
    }

    for version in versions {
        use super::types::LtsStatus;
        if !matches!(
            version.lts_status,
            LtsStatus::LtsOutdatedPatch | LtsStatus::LtsSuperseded
        ) {
            continue;
        }
        let mut params = BTreeMap::new();
        params.insert("version".to_string(), version.version.clone());
        params.insert(
            "ltsStatus".to_string(),
            lts_status_param(version.lts_status),
        );
        findings.push(RuntimeFinding {
            code: RuntimeFindingCode::OutdatedLts,
            params: Some(params),
            severity: None,
        });
    }
    findings
}

fn manager_param(manager: VersionManagerId) -> String {
    match manager {
        VersionManagerId::Nvm => "nvm",
        VersionManagerId::Fnm => "fnm",
        VersionManagerId::Volta => "volta",
    }
    .to_string()
}

fn lts_status_param(status: super::types::LtsStatus) -> String {
    use super::types::LtsStatus;
    match status {
        LtsStatus::CurrentLts => "current-lts",
        LtsStatus::LtsOutdatedPatch => "lts-outdated-patch",
        LtsStatus::LtsSuperseded => "lts-superseded",
        LtsStatus::EndOfLife => "end-of-life",
        LtsStatus::CurrentRelease => "current-release",
        LtsStatus::Unknown => "unknown",
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn version(version: &str, path: &str) -> InstalledVersion {
        InstalledVersion {
            version: version.to_string(),
            path: path.to_string(),
        }
    }

    #[test]
    fn compare_version_strings_orders_ascending_by_exact_semver() {
        assert_eq!(
            compare_version_strings("20.11.0", "22.13.0"),
            std::cmp::Ordering::Less
        );
        assert_eq!(
            compare_version_strings("22.13.0", "22.13.0"),
            std::cmp::Ordering::Equal
        );
    }

    #[test]
    fn compare_version_strings_falls_back_to_lexical_order_for_unparseable_input() {
        // A directory name a version manager did not create must still
        // sort somewhere rather than aborting the scan.
        assert_eq!(
            compare_version_strings("scratch", "24.18.0"),
            "scratch".cmp("24.18.0")
        );
    }

    #[test]
    fn sort_versions_descending_puts_the_newest_version_first() {
        let versions = vec![
            version("20.11.0", "/a"),
            version("24.18.0", "/b"),
            version("22.13.0", "/c"),
        ];
        let sorted = sort_versions_descending(versions);
        let ordered: Vec<&str> = sorted.iter().map(|v| v.version.as_str()).collect();
        assert_eq!(ordered, vec!["24.18.0", "22.13.0", "20.11.0"]);
    }

    #[test]
    fn prefer_newer_version_keeps_the_higher_patch_per_major() {
        let mut latest = BTreeMap::new();
        prefer_newer_version(&mut latest, "24.10.0");
        prefer_newer_version(&mut latest, "24.18.0");
        prefer_newer_version(&mut latest, "24.5.0");
        assert_eq!(latest.get(&24), Some(&"24.18.0".to_string()));
    }

    #[test]
    fn prefer_newer_version_ignores_an_unparseable_value() {
        let mut latest = BTreeMap::new();
        prefer_newer_version(&mut latest, "not-a-version");
        assert!(latest.is_empty());
    }

    #[test]
    fn normalized_managed_path_is_case_insensitive_only_on_windows() {
        assert_eq!(
            normalized_managed_path("C:\\Users\\X\\node.exe", "win32"),
            "c:/users/x/node.exe"
        );
        assert_eq!(
            normalized_managed_path("/Home/X/node", "linux"),
            "/Home/X/node"
        );
    }

    #[test]
    fn find_current_version_matches_on_normalized_path() {
        let installed = vec![version(
            "22.13.0",
            "/home/a/.nvm/versions/node/22.13.0/bin/node",
        )];
        let current = find_current_version(
            &installed,
            Some("/home/a/.nvm/versions/node/22.13.0/bin/node"),
            "linux",
        );
        assert_eq!(current, Some("22.13.0".to_string()));
    }

    #[test]
    fn find_current_version_is_none_when_no_effective_path_was_given() {
        let installed = vec![version("22.13.0", "/a")];
        assert_eq!(find_current_version(&installed, None, "linux"), None);
    }

    fn tiny_schedule() -> NodeReleaseSchedule {
        use super::super::lts_policy::NodeReleaseLine;
        NodeReleaseSchedule {
            generated_at: "2026-07-26",
            lines: &[NodeReleaseLine {
                major: 24,
                start: "2025-05-06",
                lts: Some("2025-10-28"),
                maintenance: Some("2026-10-20"),
                end: "2028-04-30",
                codename: Some("krypton"),
                latest: Some("24.18.0"),
            }],
        }
    }

    #[test]
    fn to_managed_versions_marks_default_and_current_and_carries_the_codename() {
        let installed = vec![version("24.18.0", "/root/24.18.0/bin/node")];
        let schedule = tiny_schedule();
        let options = ManagedVersionListOptions {
            schedule: &schedule,
            now: std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_785_000_000),
            latest_by_major: BTreeMap::new(),
            live_data_available: None,
            default_version: Some("24.18.0".to_string()),
            current_version: Some("24.18.0".to_string()),
        };
        let managed = to_managed_versions(&installed, &options);
        assert_eq!(managed.len(), 1);
        assert!(managed[0].is_default);
        assert!(managed[0].is_current);
        assert_eq!(managed[0].lts_codename.as_deref(), Some("krypton"));
    }

    #[test]
    fn create_managed_version_findings_raises_managed_but_not_on_path_only_without_a_current_version()
     {
        let findings = create_managed_version_findings(
            VersionManagerId::Nvm,
            Some("lts/*"),
            Some("24.18.0"),
            None,
            &[],
        );
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].code, RuntimeFindingCode::ManagedButNotOnPath);

        let no_finding = create_managed_version_findings(
            VersionManagerId::Nvm,
            Some("lts/*"),
            Some("24.18.0"),
            Some("24.18.0"),
            &[],
        );
        assert!(no_finding.is_empty());
    }

    #[test]
    fn create_managed_version_findings_raises_outdated_lts_for_a_behind_or_superseded_version() {
        let versions = vec![
            ManagedVersion {
                version: "24.0.0".to_string(),
                path: "/a".to_string(),
                is_default: false,
                is_current: false,
                lts_status: super::super::types::LtsStatus::LtsOutdatedPatch,
                lts_codename: None,
            },
            ManagedVersion {
                version: "22.0.0".to_string(),
                path: "/b".to_string(),
                is_default: false,
                is_current: false,
                lts_status: super::super::types::LtsStatus::CurrentLts,
                lts_codename: None,
            },
        ];
        let findings =
            create_managed_version_findings(VersionManagerId::Fnm, None, None, None, &versions);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].code, RuntimeFindingCode::OutdatedLts);
        assert_eq!(
            findings[0].params.as_ref().unwrap().get("version"),
            Some(&"24.0.0".to_string())
        );
    }

    /// A named fake proving `read_managed_versions` checks every version
    /// directory concurrently rather than one at a time: every
    /// `path_exists` call records the instant it ran, and this test asserts
    /// none of them waited for an earlier one to finish first.
    struct RecordingFs {
        calls: std::sync::Mutex<Vec<String>>,
    }

    impl ManagedVersionFileSystem for RecordingFs {
        fn path_exists<'a>(&'a self, path: &'a str) -> BoxFuture<'a, bool> {
            self.calls.lock().unwrap().push(path.to_string());
            Box::pin(async { true })
        }

        fn read_directory<'a>(&'a self, _path: &'a str) -> BoxFuture<'a, Result<Vec<String>, ()>> {
            Box::pin(async {
                Ok(vec![
                    "20.11.0".to_string(),
                    "22.13.0".to_string(),
                    "not-a-version".to_string(),
                ])
            })
        }

        fn realpath<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Result<String, ()>> {
            let path = path.to_string();
            Box::pin(async { Ok(path) })
        }
    }

    #[tokio::test]
    async fn read_managed_versions_skips_non_version_directories_and_sorts_descending() {
        let fs = Arc::new(RecordingFs {
            calls: std::sync::Mutex::new(Vec::new()),
        });
        let node_binary_path_for: Arc<dyn Fn(&str) -> String + Send + Sync> =
            Arc::new(|dir: &str| format!("/root/{dir}/bin/node"));

        let versions = read_managed_versions(
            Arc::clone(&fs) as Arc<dyn ManagedVersionFileSystem>,
            "/root",
            node_binary_path_for,
        )
        .await;

        let ordered: Vec<&str> = versions.iter().map(|v| v.version.as_str()).collect();
        assert_eq!(ordered, vec!["22.13.0", "20.11.0"]);
        assert_eq!(fs.calls.lock().unwrap().len(), 2);
    }
}
