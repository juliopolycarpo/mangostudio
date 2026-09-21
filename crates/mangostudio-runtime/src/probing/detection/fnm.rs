//! `detect_fnm`, mirroring `apps/shared/src/environments/detection/fnm.ts`:
//! root discovery (a candidate ladder, most specific first), the `default`
//! alias (a symlink rather than a named alias, unlike nvm's), and the
//! installed-version scan.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::LazyLock;
use std::time::SystemTime;

use regex::Regex;

use super::binary_scan::windows_default_fnm_dir;
use super::lts_policy::NodeReleaseSchedule;
use super::path_env::{PathEnv, join_path};
use super::types::{ManagedVersion, VersionManagerId, VersionManagerStatus};
use super::version_manager_support::{
    InstalledVersion, ManagedVersionFileSystem, ManagedVersionListOptions,
    create_managed_version_findings, find_current_version, prefer_newer_version,
    read_managed_versions, to_managed_versions,
};

/// fnm never reads a file as text — its aliases are symlinks, not
/// `nvm.sh`-style scripts — so its own filesystem seam is exactly
/// [`ManagedVersionFileSystem`].
pub type FnmFileSystem = dyn ManagedVersionFileSystem;

/// Inputs [`detect_fnm`] needs beyond its filesystem.
pub struct FnmDetectionOptions<'a> {
    /// The instant to classify each installed version's LTS status
    /// against.
    pub now: SystemTime,
    /// The release schedule to classify against.
    pub schedule: &'a NodeReleaseSchedule,
    /// The effective Node path a runtime scan already reported.
    pub current_node_path: Option<String>,
    /// The newest known patch per major, from a live probe.
    pub latest_by_major: BTreeMap<u32, String>,
    /// Whether [`FnmDetectionOptions::latest_by_major`] came from a live
    /// probe recent enough to excuse a stale bundled schedule.
    pub live_data_available: Option<bool>,
    /// `fnm --version` output, already parsed to `major.minor.patch`.
    /// Reused from the runtime's own fnm scan — the same one
    /// `probing.runtimes` runs — rather than spawning `fnm --version` a
    /// second time here.
    pub manager_version: Option<String>,
}

/// The version segment fnm encodes in an alias's resolved target, e.g.
/// `.../node-versions/v24.18.0/installation` (POSIX) or
/// `...\node-versions\v24.18.0\installation` (Windows, matched after
/// backslash normalization). Not anchored to an `/installation` suffix: a
/// layout that resolves an alias straight to the version directory should
/// still read, rather than silently losing the default.
static ALIAS_TARGET_VERSION_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"node-versions/v?(\d+\.\d+\.\d+)(?:/|$)").expect("a fixed, hand-checked pattern")
});

fn node_binary_path(root: &str, version_dir: &str, platform: &str) -> String {
    if platform == "win32" {
        join_path(
            platform,
            &[
                root,
                "node-versions",
                version_dir,
                "installation",
                "node.exe",
            ],
        )
    } else {
        join_path(
            platform,
            &[
                root,
                "node-versions",
                version_dir,
                "installation",
                "bin",
                "node",
            ],
        )
    }
}

/// Every directory fnm may call its root, most specific first: `FNM_DIR`,
/// the platform default (`%APPDATA%\fnm`, `~/Library/Application
/// Support/fnm` on macOS, `~/.local/share/fnm` elsewhere), then the
/// pre-XDG `~/.fnm`. One list for the detector and the well-known Node
/// directories in [`crate::probing::detection::runtime_definitions`], so
/// no two of them can disagree about where fnm lives on a platform.
///
/// # Example
///
/// ```
/// use mangostudio_runtime::probing::detection::fnm::fnm_root_candidates;
/// use mangostudio_runtime::probing::detection::path_env::PathEnv;
/// use std::collections::HashMap;
///
/// let env = PathEnv { platform: "darwin".to_string(), home_dir: "/Users/a".to_string(), env: HashMap::new() };
/// assert_eq!(
///     fnm_root_candidates(&env),
///     vec!["/Users/a/Library/Application Support/fnm".to_string(), "/Users/a/.fnm".to_string()]
/// );
/// ```
#[must_use]
pub fn fnm_root_candidates(path_env: &PathEnv) -> Vec<String> {
    let configured_root = path_env
        .env_var("FNM_DIR")
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let platform_default = if path_env.is_windows() {
        windows_default_fnm_dir(path_env)
    } else if path_env.platform == "darwin" {
        Some(join_path(
            &path_env.platform,
            &[&path_env.home_dir, "Library", "Application Support", "fnm"],
        ))
    } else {
        Some(join_path(
            &path_env.platform,
            &[&path_env.home_dir, ".local", "share", "fnm"],
        ))
    };
    let legacy_root = if path_env.is_windows() {
        None
    } else {
        Some(join_path(&path_env.platform, &[&path_env.home_dir, ".fnm"]))
    };

    let mut candidates = Vec::new();
    for candidate in [configured_root, platform_default, legacy_root]
        .into_iter()
        .flatten()
    {
        if !candidates.contains(&candidate) {
            candidates.push(candidate);
        }
    }
    candidates
}

/// The directory fnm's `default` alias exposes a `node` binary in, under
/// `root`.
#[must_use]
pub fn fnm_default_alias_bin_dir(platform: &str, root: &str) -> String {
    if platform == "win32" {
        join_path(platform, &[root, "aliases", "default"])
    } else {
        join_path(platform, &[root, "aliases", "default", "bin"])
    }
}

/// `FNM_DIR` first, then the platform default, then `~/.fnm` — fnm's own
/// pre-XDG layout — as a legacy fallback. Each candidate has to actually
/// be on disk: an `FNM_DIR` pointing nowhere must not shadow a real
/// install sitting at the platform default.
async fn resolve_fnm_root(fs: &FnmFileSystem, path_env: &PathEnv) -> Option<String> {
    for root in fnm_root_candidates(path_env) {
        if fs.path_exists(&root).await {
            return Some(root);
        }
    }
    None
}

async fn read_installed_versions(
    root: &str,
    fs: Arc<dyn ManagedVersionFileSystem>,
    platform: &str,
) -> Vec<InstalledVersion> {
    let versions_root = join_path(platform, &[root, "node-versions"]);
    let root = root.to_string();
    let platform_owned = platform.to_string();
    let node_binary_path_for: Arc<dyn Fn(&str) -> String + Send + Sync> =
        Arc::new(move |entry: &str| node_binary_path(&root, entry, &platform_owned));
    read_managed_versions(fs, &versions_root, node_binary_path_for).await
}

/// fnm's `default` alias is a symlink (junction on Windows) straight to a
/// version's installation directory — there is no separate alias-name
/// layer the way nvm's `alias/default` file can hold `lts/*`, so the
/// resolved version doubles as the alias itself.
async fn resolve_default_version(root: &str, fs: &FnmFileSystem, platform: &str) -> Option<String> {
    let alias_path = join_path(platform, &[root, "aliases", "default"]);
    if !fs.path_exists(&alias_path).await {
        return None;
    }
    let resolved = fs.realpath(&alias_path).await.ok()?;
    let normalized = resolved.replace('\\', "/");
    ALIAS_TARGET_VERSION_PATTERN
        .captures(&normalized)
        .and_then(|captures| captures.get(1))
        .map(|version| version.as_str().to_string())
}

/// Detects fnm, mirroring `fnm.ts`'s `detectFnm` exactly: root discovery,
/// the `default` alias resolved through its symlink target, and the
/// installed-version scan.
pub async fn detect_fnm(
    fs: Arc<dyn ManagedVersionFileSystem>,
    path_env: &PathEnv,
    options: FnmDetectionOptions<'_>,
) -> VersionManagerStatus {
    let Some(root) = resolve_fnm_root(fs.as_ref(), path_env).await else {
        return VersionManagerStatus {
            id: VersionManagerId::Fnm,
            installed: false,
            root: None,
            manager_version: None,
            versions: Vec::new(),
            default_alias: None,
            default_version: None,
            current_version: None,
            findings: vec![super::types::RuntimeFinding {
                code: super::types::RuntimeFindingCode::NotFound,
                params: Some(BTreeMap::from([("manager".to_string(), "fnm".to_string())])),
                severity: None,
            }],
        };
    };

    let (default_version, installed_versions) = tokio::join!(
        resolve_default_version(&root, fs.as_ref(), &path_env.platform),
        read_installed_versions(&root, Arc::clone(&fs), &path_env.platform)
    );

    let mut latest_by_major = BTreeMap::new();
    for version in &installed_versions {
        prefer_newer_version(&mut latest_by_major, &version.version);
    }
    for version in options.latest_by_major.values() {
        prefer_newer_version(&mut latest_by_major, version);
    }

    let current_version = find_current_version(
        &installed_versions,
        options.current_node_path.as_deref(),
        &path_env.platform,
    );
    let managed_options = ManagedVersionListOptions {
        schedule: options.schedule,
        now: options.now,
        latest_by_major,
        live_data_available: options.live_data_available,
        default_version: default_version.clone(),
        current_version: current_version.clone(),
    };
    let versions: Vec<ManagedVersion> = to_managed_versions(&installed_versions, &managed_options);

    // The alias and the version it resolves to are always the same string
    // — see `resolve_default_version`.
    let findings = create_managed_version_findings(
        VersionManagerId::Fnm,
        default_version.as_deref(),
        default_version.as_deref(),
        current_version.as_deref(),
        &versions,
    );

    VersionManagerStatus {
        id: VersionManagerId::Fnm,
        installed: true,
        root: Some(root),
        manager_version: options.manager_version,
        versions,
        default_alias: default_version.clone(),
        default_version,
        current_version,
        findings,
    }
}

#[cfg(test)]
mod tests {
    use std::collections::{HashMap as StdHashMap, HashSet};

    use super::*;

    #[derive(Default)]
    struct FakeFnmFs {
        existing: HashSet<String>,
        directories: StdHashMap<String, Vec<String>>,
        realpath_map: StdHashMap<String, String>,
    }

    impl ManagedVersionFileSystem for FakeFnmFs {
        fn path_exists<'a>(&'a self, path: &'a str) -> super::super::BoxFuture<'a, bool> {
            let exists = self.existing.contains(path);
            Box::pin(async move { exists })
        }

        fn read_directory<'a>(
            &'a self,
            path: &'a str,
        ) -> super::super::BoxFuture<'a, Result<Vec<String>, ()>> {
            let entries = self.directories.get(path).cloned();
            Box::pin(async move { entries.ok_or(()) })
        }

        fn realpath<'a>(
            &'a self,
            path: &'a str,
        ) -> super::super::BoxFuture<'a, Result<String, ()>> {
            let resolved = self.realpath_map.get(path).cloned();
            Box::pin(async move { resolved.ok_or(()) })
        }
    }

    fn schedule() -> NodeReleaseSchedule {
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

    fn options<'a>(schedule: &'a NodeReleaseSchedule) -> FnmDetectionOptions<'a> {
        FnmDetectionOptions {
            now: std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_785_000_000),
            schedule,
            current_node_path: None,
            latest_by_major: BTreeMap::new(),
            live_data_available: None,
            manager_version: Some("1.38.1".to_string()),
        }
    }

    #[tokio::test]
    async fn reports_not_found_when_no_root_candidate_exists() {
        let fs = Arc::new(FakeFnmFs::default());
        let path_env = PathEnv {
            platform: "linux".to_string(),
            home_dir: "/home/t".to_string(),
            env: StdHashMap::new(),
        };
        let schedule = schedule();
        let status = detect_fnm(fs, &path_env, options(&schedule)).await;

        assert!(!status.installed);
        assert_eq!(
            status.findings[0].code,
            super::super::types::RuntimeFindingCode::NotFound
        );
    }

    #[tokio::test]
    async fn a_default_alias_resolving_through_its_symlink_target() {
        let root = "/home/t/.local/share/fnm";
        let fs = Arc::new(FakeFnmFs {
            existing: HashSet::from([root.to_string(), format!("{root}/aliases/default")]),
            directories: StdHashMap::from([(
                format!("{root}/node-versions"),
                vec!["v24.18.0".to_string()],
            )]),
            realpath_map: StdHashMap::from([(
                format!("{root}/aliases/default"),
                format!("{root}/node-versions/v24.18.0/installation"),
            )]),
        });
        let path_env = PathEnv {
            platform: "linux".to_string(),
            home_dir: "/home/t".to_string(),
            env: StdHashMap::new(),
        };
        let schedule = schedule();
        let status = detect_fnm(fs, &path_env, options(&schedule)).await;

        assert!(status.installed);
        assert_eq!(status.default_alias.as_deref(), Some("24.18.0"));
        assert_eq!(status.default_version.as_deref(), Some("24.18.0"));
    }

    #[tokio::test]
    async fn installed_with_no_default_reports_no_alias() {
        let root = "/home/t/.local/share/fnm";
        let fs = Arc::new(FakeFnmFs {
            existing: HashSet::from([root.to_string()]),
            ..Default::default()
        });
        let path_env = PathEnv {
            platform: "linux".to_string(),
            home_dir: "/home/t".to_string(),
            env: StdHashMap::new(),
        };
        let schedule = schedule();
        let status = detect_fnm(fs, &path_env, options(&schedule)).await;

        assert!(status.installed);
        assert!(status.default_alias.is_none());
        assert!(status.versions.is_empty());
    }

    #[test]
    fn fnm_root_candidates_walks_configured_then_platform_default_then_legacy() {
        let path_env = PathEnv {
            platform: "linux".to_string(),
            home_dir: "/home/t".to_string(),
            env: StdHashMap::from([("FNM_DIR".to_string(), "/opt/fnm".to_string())]),
        };
        assert_eq!(
            fnm_root_candidates(&path_env),
            vec![
                "/opt/fnm".to_string(),
                "/home/t/.local/share/fnm".to_string(),
                "/home/t/.fnm".to_string()
            ]
        );
    }

    #[test]
    fn fnm_root_candidates_has_no_legacy_root_on_windows() {
        let path_env = PathEnv {
            platform: "win32".to_string(),
            home_dir: "C:\\Users\\t".to_string(),
            env: StdHashMap::from([(
                "APPDATA".to_string(),
                "C:\\Users\\t\\AppData\\Roaming".to_string(),
            )]),
        };
        assert_eq!(
            fnm_root_candidates(&path_env),
            vec!["C:\\Users\\t\\AppData\\Roaming\\fnm".to_string()]
        );
    }
}
