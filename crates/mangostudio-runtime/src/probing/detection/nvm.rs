//! `detect_nvm`, mirroring
//! `apps/shared/src/environments/detection/nvm.ts`: root discovery, reading
//! `nvm.sh` for the manager's own version, the `lts/*` alias cache
//! (including its pointer chain), and the installed-version scan.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::LazyLock;
use std::time::SystemTime;

use regex::Regex;

use super::BoxFuture;
use super::lts_policy::{NodeReleaseSchedule, normalize_node_version};
use super::path_env::{PathEnv, join_path};
use super::types::{ManagedVersion, VersionManagerId, VersionManagerStatus};
use super::version_manager_support::{
    InstalledVersion, ManagedVersionFileSystem, ManagedVersionListOptions, compare_version_strings,
    create_managed_version_findings, find_current_version, list_optional_directory,
    prefer_newer_version, read_managed_versions, to_managed_versions,
};

/// nvm's own filesystem seam: [`ManagedVersionFileSystem`] plus reading a
/// file as text (`nvm.sh`, an `alias/*` file) — fnm never needs this half,
/// since its aliases are symlinks rather than text files.
pub trait NvmFileSystem: ManagedVersionFileSystem {
    /// Reads `path` as UTF-8 text, or `Err(())` when it cannot be read.
    fn read_file<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Result<String, ()>>;
}

/// Inputs [`detect_nvm`] needs beyond its filesystem.
pub struct NvmDetectionOptions<'a> {
    /// The instant to classify each installed version's LTS status
    /// against.
    pub now: SystemTime,
    /// The release schedule to classify against.
    pub schedule: &'a NodeReleaseSchedule,
    /// The effective Node path a runtime scan already reported, used to
    /// find which installed version is actually running.
    pub current_node_path: Option<String>,
    /// The newest known patch per major, from a live probe.
    pub latest_by_major: BTreeMap<u32, String>,
    /// Whether [`NvmDetectionOptions::latest_by_major`] came from a live
    /// probe recent enough to excuse a stale bundled schedule.
    pub live_data_available: Option<bool>,
}

struct NvmAliasCache {
    aliases: BTreeMap<String, String>,
    /// `lts/*` holds `lts/<codename>` rather than a version, so pointers
    /// resolve separately.
    pointers: BTreeMap<String, String>,
    latest_by_major: BTreeMap<u32, String>,
}

/// The characters an nvm alias name or value may use. Two callers rely on
/// this in the TypeScript original: the alias cache skips anything else,
/// and the runtime's spawn-env refuses to join a rejected value onto
/// `$NVM_DIR/alias` — so the rule that decides which aliases exist and the
/// rule that decides which are safe to read are one. This port only needs
/// the alias-cache half.
static SAFE_NVM_ALIAS_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[a-zA-Z0-9_.*/-]+$").expect("a fixed, hand-checked pattern"));

static NVM_VERSION_BLOCK_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"["']--version["']\s*\|\s*["']-v["'][\s\S]{0,160}?nvm_echo\s+["']([^"']+)["']"#)
        .expect("a fixed, hand-checked pattern")
});

static ALIAS_MAJOR_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^v?(\d+)$").expect("a fixed, hand-checked pattern"));

async fn read_optional_file(fs: &dyn NvmFileSystem, path: &str) -> Option<String> {
    fs.read_file(path).await.ok()
}

fn parse_nvm_version(nvm_script: &str) -> Option<String> {
    let captures = NVM_VERSION_BLOCK_PATTERN.captures(nvm_script)?;
    normalize_node_version(captures.get(1)?.as_str())
}

/// nvm has no `win32` build; the root is always `NVM_DIR`, or `~/.nvm`,
/// whichever actually holds `nvm.sh`.
async fn resolve_nvm_root(fs: &dyn NvmFileSystem, path_env: &PathEnv) -> Option<String> {
    if path_env.is_windows() {
        return None;
    }

    let configured_root = path_env
        .env_var("NVM_DIR")
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let default_root = join_path(&path_env.platform, &[&path_env.home_dir, ".nvm"]);
    let mut candidates = Vec::new();
    if let Some(configured_root) = configured_root {
        candidates.push(configured_root.to_string());
    }
    if !candidates.contains(&default_root) {
        candidates.push(default_root);
    }

    for root in candidates {
        let nvm_sh = join_path(&path_env.platform, &[&root, "nvm.sh"]);
        if fs.path_exists(&nvm_sh).await {
            return Some(root);
        }
    }
    None
}

async fn read_nvm_alias_cache(root: &str, fs: &dyn NvmFileSystem, platform: &str) -> NvmAliasCache {
    let alias_root = join_path(platform, &[root, "alias", "lts"]);
    let mut aliases = BTreeMap::new();
    let mut pointers = BTreeMap::new();
    let mut latest_by_major = BTreeMap::new();

    for alias_name in list_optional_directory(fs, &alias_root).await {
        if !SAFE_NVM_ALIAS_PATTERN.is_match(&alias_name) {
            continue;
        }
        let Some(value) =
            read_optional_file(fs, &join_path(platform, &[&alias_root, &alias_name])).await
        else {
            continue;
        };
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        match normalize_node_version(value) {
            Some(version) => {
                aliases.insert(alias_name.to_lowercase(), version.clone());
                prefer_newer_version(&mut latest_by_major, &version);
            }
            None => {
                if SAFE_NVM_ALIAS_PATTERN.is_match(value) {
                    pointers.insert(alias_name.to_lowercase(), value.to_lowercase());
                }
            }
        }
    }

    NvmAliasCache {
        aliases,
        pointers,
        latest_by_major,
    }
}

async fn read_installed_versions(
    root: &str,
    fs: Arc<dyn ManagedVersionFileSystem>,
    platform: &str,
) -> Vec<InstalledVersion> {
    let versions_root = join_path(platform, &[root, "versions", "node"]);
    let platform = platform.to_string();
    let node_binary_path_for: Arc<dyn Fn(&str) -> String + Send + Sync> = {
        let versions_root = versions_root.clone();
        Arc::new(move |entry: &str| join_path(&platform, &[&versions_root, entry, "bin", "node"]))
    };
    read_managed_versions(fs, &versions_root, node_binary_path_for).await
}

fn highest_version(versions: &[InstalledVersion]) -> Option<String> {
    versions.first().map(|version| version.version.clone())
}

fn resolve_default_alias(
    alias: Option<&str>,
    alias_cache: &NvmAliasCache,
    installed_versions: &[InstalledVersion],
) -> Option<String> {
    let trimmed = alias.map(str::trim).filter(|value| !value.is_empty())?;

    if let Some(direct) = normalize_node_version(trimmed) {
        return Some(direct);
    }

    let normalized_alias = trimmed.to_lowercase();
    if normalized_alias == "node" || normalized_alias == "stable" {
        return highest_version(installed_versions);
    }
    if normalized_alias == "lts/*" {
        // Real nvm writes `lts/<codename>` into `alias/lts/*`, so follow
        // that pointer before falling back to the newest version the alias
        // cache knows about.
        let pointed = alias_cache
            .pointers
            .get("*")
            .and_then(|pointer| pointer.strip_prefix("lts/"))
            .and_then(|codename| alias_cache.aliases.get(codename));
        return alias_cache
            .aliases
            .get("*")
            .or(pointed)
            .cloned()
            .or_else(|| {
                alias_cache
                    .latest_by_major
                    .values()
                    .max_by(|left, right| compare_version_strings(left, right))
                    .cloned()
            });
    }
    if let Some(codename) = normalized_alias.strip_prefix("lts/") {
        return alias_cache.aliases.get(codename).cloned();
    }

    let major = ALIAS_MAJOR_PATTERN
        .captures(&normalized_alias)?
        .get(1)?
        .as_str()
        .to_string();
    installed_versions
        .iter()
        .find(|version| version.version.starts_with(&format!("{major}.")))
        .map(|version| version.version.clone())
}

fn merge_latest_versions(
    alias_cache: &NvmAliasCache,
    live_latest_by_major: &BTreeMap<u32, String>,
) -> BTreeMap<u32, String> {
    let mut latest_by_major = alias_cache.latest_by_major.clone();
    for version in live_latest_by_major.values() {
        prefer_newer_version(&mut latest_by_major, version);
    }
    latest_by_major
}

/// Detects nvm, mirroring `nvm.ts`'s `detectNvm` exactly: root discovery,
/// the manager's own version from `nvm.sh`, the `lts/*` alias chain, and
/// the installed-version scan.
pub async fn detect_nvm(
    fs: Arc<dyn NvmFileSystem>,
    path_env: &PathEnv,
    options: NvmDetectionOptions<'_>,
) -> VersionManagerStatus {
    let Some(root) = resolve_nvm_root(fs.as_ref(), path_env).await else {
        return VersionManagerStatus {
            id: VersionManagerId::Nvm,
            installed: false,
            root: None,
            manager_version: None,
            versions: Vec::new(),
            default_alias: None,
            default_version: None,
            current_version: None,
            findings: vec![super::types::RuntimeFinding {
                code: super::types::RuntimeFindingCode::NotFound,
                params: Some(BTreeMap::from([("manager".to_string(), "nvm".to_string())])),
                severity: None,
            }],
        };
    };

    let nvm_sh_path = join_path(&path_env.platform, &[&root, "nvm.sh"]);
    let default_alias_path = join_path(&path_env.platform, &[&root, "alias", "default"]);
    let (nvm_script, default_alias_file, alias_cache, installed_versions) = tokio::join!(
        read_optional_file(fs.as_ref(), &nvm_sh_path),
        read_optional_file(fs.as_ref(), &default_alias_path),
        read_nvm_alias_cache(&root, fs.as_ref(), &path_env.platform),
        read_installed_versions(
            &root,
            Arc::clone(&fs) as Arc<dyn ManagedVersionFileSystem>,
            &path_env.platform
        ),
    );

    let default_alias = default_alias_file
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let default_version =
        resolve_default_alias(default_alias.as_deref(), &alias_cache, &installed_versions);
    let manager_version = nvm_script.as_deref().and_then(parse_nvm_version);
    let latest_by_major = merge_latest_versions(&alias_cache, &options.latest_by_major);
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

    let findings = create_managed_version_findings(
        VersionManagerId::Nvm,
        default_alias.as_deref(),
        default_version.as_deref(),
        current_version.as_deref(),
        &versions,
    );

    VersionManagerStatus {
        id: VersionManagerId::Nvm,
        installed: true,
        root: Some(root),
        manager_version,
        versions,
        default_alias,
        default_version,
        current_version,
        findings,
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap as StdHashMap;

    use super::*;

    /// A named fake nvm root laid out as `{files, directories}` maps —
    /// configurable per test rather than an inline closure, matching this
    /// repository's fake-object convention.
    #[derive(Default)]
    struct FakeNvmFs {
        files: StdHashMap<String, String>,
        directories: StdHashMap<String, Vec<String>>,
        existing: std::collections::HashSet<String>,
        realpath_map: StdHashMap<String, String>,
        realpath_failures: std::collections::HashSet<String>,
    }

    impl ManagedVersionFileSystem for FakeNvmFs {
        fn path_exists<'a>(&'a self, path: &'a str) -> BoxFuture<'a, bool> {
            let exists = self.existing.contains(path);
            Box::pin(async move { exists })
        }

        fn read_directory<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Result<Vec<String>, ()>> {
            let entries = self.directories.get(path).cloned();
            Box::pin(async move { entries.ok_or(()) })
        }

        fn realpath<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Result<String, ()>> {
            if self.realpath_failures.contains(path) {
                return Box::pin(async { Err(()) });
            }
            let resolved = self
                .realpath_map
                .get(path)
                .cloned()
                .unwrap_or_else(|| path.to_string());
            Box::pin(async move { Ok(resolved) })
        }
    }

    impl NvmFileSystem for FakeNvmFs {
        fn read_file<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Result<String, ()>> {
            let content = self.files.get(path).cloned();
            Box::pin(async move { content.ok_or(()) })
        }
    }

    fn linux_env(home: &str) -> PathEnv {
        PathEnv {
            platform: "linux".to_string(),
            home_dir: home.to_string(),
            env: StdHashMap::new().into_iter().collect(),
        }
    }

    fn schedule() -> NodeReleaseSchedule {
        use super::super::lts_policy::NodeReleaseLine;
        NodeReleaseSchedule {
            generated_at: "2026-07-26",
            lines: &[NodeReleaseLine {
                major: 22,
                start: "2024-04-24",
                lts: Some("2024-10-29"),
                maintenance: Some("2025-10-21"),
                end: "2027-04-30",
                codename: Some("jod"),
                latest: Some("22.23.1"),
            }],
        }
    }

    fn options<'a>(schedule: &'a NodeReleaseSchedule) -> NvmDetectionOptions<'a> {
        NvmDetectionOptions {
            now: std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_785_000_000),
            schedule,
            current_node_path: None,
            latest_by_major: BTreeMap::new(),
            live_data_available: None,
        }
    }

    #[tokio::test]
    async fn reports_not_found_when_nvm_sh_never_exists() {
        let fs = Arc::new(FakeNvmFs::default());
        let schedule = schedule();
        let status = detect_nvm(fs, &linux_env("/home/t"), options(&schedule)).await;

        assert!(!status.installed);
        assert_eq!(status.findings.len(), 1);
        assert_eq!(
            status.findings[0].code,
            super::super::types::RuntimeFindingCode::NotFound
        );
    }

    #[tokio::test]
    async fn installed_with_no_default_alias_reports_versions_but_no_default() {
        let fs = Arc::new(FakeNvmFs {
            existing: std::collections::HashSet::from([
                "/home/t/.nvm/nvm.sh".to_string(),
                "/home/t/.nvm/versions/node/22.13.0/bin/node".to_string(),
            ]),
            directories: StdHashMap::from([(
                "/home/t/.nvm/versions/node".to_string(),
                vec!["22.13.0".to_string()],
            )]),
            files: StdHashMap::new(),
            ..Default::default()
        });
        let schedule = schedule();
        let status = detect_nvm(fs, &linux_env("/home/t"), options(&schedule)).await;

        assert!(status.installed);
        assert_eq!(status.root.as_deref(), Some("/home/t/.nvm"));
        assert_eq!(status.versions.len(), 1);
        assert!(status.default_version.is_none());
    }

    #[tokio::test]
    async fn a_default_alias_resolving_through_the_lts_star_pointer_chain() {
        let fs = Arc::new(FakeNvmFs {
            existing: std::collections::HashSet::from([
                "/home/t/.nvm/nvm.sh".to_string(),
                "/home/t/.nvm/versions/node/22.13.0/bin/node".to_string(),
            ]),
            directories: StdHashMap::from([
                (
                    "/home/t/.nvm/versions/node".to_string(),
                    vec!["22.13.0".to_string()],
                ),
                (
                    "/home/t/.nvm/alias/lts".to_string(),
                    vec!["*".to_string(), "jod".to_string()],
                ),
            ]),
            files: StdHashMap::from([
                (
                    "/home/t/.nvm/alias/default".to_string(),
                    "lts/*".to_string(),
                ),
                (
                    "/home/t/.nvm/alias/lts/*".to_string(),
                    "lts/jod".to_string(),
                ),
                (
                    "/home/t/.nvm/alias/lts/jod".to_string(),
                    "22.13.0".to_string(),
                ),
            ]),
            ..Default::default()
        });
        let schedule = schedule();
        let status = detect_nvm(fs, &linux_env("/home/t"), options(&schedule)).await;

        assert_eq!(status.default_alias.as_deref(), Some("lts/*"));
        assert_eq!(status.default_version.as_deref(), Some("22.13.0"));
    }

    #[tokio::test]
    async fn reads_the_managers_own_version_from_nvm_sh() {
        let script = r#"nvm_echo() { :; }
case $1 in
  "--version" | "-v")
    nvm_echo "0.40.1"
    ;;
esac
"#;
        let fs = Arc::new(FakeNvmFs {
            existing: std::collections::HashSet::from(["/home/t/.nvm/nvm.sh".to_string()]),
            files: StdHashMap::from([("/home/t/.nvm/nvm.sh".to_string(), script.to_string())]),
            ..Default::default()
        });
        let schedule = schedule();
        let status = detect_nvm(fs, &linux_env("/home/t"), options(&schedule)).await;

        assert_eq!(status.manager_version.as_deref(), Some("0.40.1"));
    }

    #[test]
    fn resolve_default_alias_follows_a_bare_major_to_its_installed_version() {
        let alias_cache = NvmAliasCache {
            aliases: BTreeMap::new(),
            pointers: BTreeMap::new(),
            latest_by_major: BTreeMap::new(),
        };
        let installed = vec![InstalledVersion {
            version: "22.13.0".to_string(),
            path: "/a".to_string(),
        }];
        assert_eq!(
            resolve_default_alias(Some("v22"), &alias_cache, &installed),
            Some("22.13.0".to_string())
        );
    }

    #[test]
    fn resolve_default_alias_reads_a_direct_version_verbatim() {
        let alias_cache = NvmAliasCache {
            aliases: BTreeMap::new(),
            pointers: BTreeMap::new(),
            latest_by_major: BTreeMap::new(),
        };
        assert_eq!(
            resolve_default_alias(Some("v22.13.0"), &alias_cache, &[]),
            Some("22.13.0".to_string())
        );
    }

    #[test]
    fn parse_nvm_version_extracts_the_echoed_version_string() {
        let script = r#""--version" | "-v") nvm_echo "0.40.1" ;;"#;
        assert_eq!(parse_nvm_version(script), Some("0.40.1".to_string()));
        assert_eq!(parse_nvm_version("nothing here"), None);
    }
}
