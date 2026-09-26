//! Fresh toolchain resolution with identity-keyed version-directory caching.
//! Alias and directory identities, executable existence, and source environments stay live.

use std::collections::{BTreeMap, HashSet};
use std::io::Read;
use std::sync::OnceLock;

use serde::Deserialize;

mod read_cache;

use crate::probing::detection::{
    fnm::{fnm_default_alias_bin_dir, fnm_root_candidates},
    lts_policy::{normalize_node_version, parse_exact_node_version},
    nvm::is_safe_nvm_alias,
    path_env::{PathEnv, dirname_path, join_path},
    runtime_definitions::well_known_node_directories,
    version_manager_support::normalized_managed_path,
};

/// Node and Bun selections from the shared toolchain schema.
#[derive(Clone, Debug, Deserialize)]
pub struct Selection {
    /// `auto` or a probed Node executable path.
    pub node: String,
    /// `auto` or a probed Bun executable path.
    pub bun: String,
}

/// Filesystem seam for resolving manager aliases without executing shell profiles.
pub trait ToolchainFs {
    /// Reports whether a candidate exists, e.g. `fs.exists("/bin/node")`.
    fn exists(&self, path: &str) -> bool;
    /// Reads a small alias, e.g. `fs.read_alias("/home/user/.nvm/alias/default")`.
    fn read_alias(&self, path: &str) -> Option<String>;
    /// Lists version names, e.g. `fs.entries("/home/user/.nvm/versions/node")`.
    fn entries(&self, path: &str) -> Vec<String>;
}

/// Bounded native filesystem reads; call only on the shared blocking pool.
pub struct NativeToolchainFs;

impl ToolchainFs for NativeToolchainFs {
    fn exists(&self, path: &str) -> bool {
        std::path::Path::new(path).exists()
    }

    fn read_alias(&self, path: &str) -> Option<String> {
        static CACHE: OnceLock<read_cache::ReadCache<String>> = OnceLock::new();
        CACHE
            .get_or_init(Default::default)
            .read(path, &NativeAliasReader)
    }

    fn entries(&self, path: &str) -> Vec<String> {
        static CACHE: OnceLock<read_cache::ReadCache<Vec<String>>> = OnceLock::new();
        CACHE
            .get_or_init(Default::default)
            .read(path, &NativeDirectoryReader)
            .unwrap_or_default()
    }
}

struct NativeAliasReader;

impl read_cache::Reader for NativeAliasReader {
    type Value = String;

    fn identity(&self, path: &str) -> Option<String> {
        // NVM alias resolution is Unix-only. Its change time detects in-place edits even
        // when a writer restores mtime; platforms without that witness bypass this cache.
        #[cfg(unix)]
        {
            crate::file_identity::fingerprint(std::path::Path::new(path))
        }
        #[cfg(not(unix))]
        {
            let _ = path;
            None
        }
    }

    fn read(&self, path: &str) -> Option<String> {
        let mut value = String::new();
        std::fs::File::open(path)
            .ok()?
            .take(4097)
            .read_to_string(&mut value)
            .ok()?;
        (value.len() <= 4096).then_some(value)
    }
}

struct NativeDirectoryReader;

impl read_cache::Reader for NativeDirectoryReader {
    type Value = Vec<String>;
    fn identity(&self, path: &str) -> Option<String> {
        crate::file_identity::fingerprint(std::path::Path::new(path))
    }

    fn read(&self, path: &str) -> Option<Vec<String>> {
        let entries = std::fs::read_dir(path).ok()?;
        let mut names = Vec::new();
        for entry in entries.take(4096) {
            let entry = entry.ok()?;
            if let Ok(name) = entry.file_name().into_string() {
                names.push(name);
            }
        }
        Some(names)
    }
}

struct Resolved {
    dir: String,
    manager: Option<(&'static str, String)>,
}

/// Prepends the selected Node and Bun directories to an environment snapshot.
/// Revalidates manager aliases and directory identities so changed defaults take effect.
///
/// # Example
///
/// ```
/// use mangostudio_runtime::commands::toolchain::{build, NativeToolchainFs};
/// use mangostudio_runtime::probing::detection::path_env::PathEnv;
/// let env = build(&PathEnv::default(), None, &NativeToolchainFs);
/// assert!(env.is_empty());
/// ```
pub fn build(
    host: &PathEnv,
    selection: Option<&Selection>,
    fs: &dyn ToolchainFs,
) -> BTreeMap<String, String> {
    let mut env: BTreeMap<_, _> = host.env.clone().into_iter().collect();
    if host.is_windows()
        && let Some(key) = env
            .keys()
            .find(|key| key.eq_ignore_ascii_case("PATH"))
            .cloned()
    {
        // The probing snapshot adds canonical PATH beside Windows' original Path.
        // A raw Windows environment block must not carry conflicting aliases.
        env.retain(|candidate, _| !candidate.eq_ignore_ascii_case("PATH") || candidate == &key);
    }
    let Some(selection) = selection else {
        return env;
    };
    let resolved = [
        resolve(host, "node", &selection.node, fs),
        resolve(host, "bun", &selection.bun, fs),
    ];
    let dirs: Vec<_> = resolved
        .iter()
        .flatten()
        .map(|value| value.dir.as_str())
        .collect();
    for (key, value) in resolved
        .iter()
        .flatten()
        .filter_map(|value| value.manager.as_ref())
    {
        if host.non_blank_var(key).is_none() {
            env.insert((*key).into(), value.clone());
        }
    }
    if dirs.is_empty() {
        return env;
    }
    let key = env
        .keys()
        .find(|key| key.eq_ignore_ascii_case("PATH"))
        .cloned()
        .unwrap_or_else(|| if host.is_windows() { "Path" } else { "PATH" }.into());
    let separator = host.path_list_separator();
    let mut path = dirs.join(separator);
    if let Some(existing) = env.get(&key).filter(|value| !value.is_empty()) {
        path.push_str(separator);
        path.push_str(existing);
    }
    env.insert(key, path);
    env
}

fn resolve(host: &PathEnv, runtime: &str, choice: &str, fs: &dyn ToolchainFs) -> Option<Resolved> {
    if choice != "auto" {
        return Some(Resolved {
            dir: dirname_path(&host.platform, choice),
            manager: None,
        });
    }
    if runtime == "node" {
        return auto_node(host, fs);
    }
    let root = host
        .non_blank_var("BUN_INSTALL")
        .map(str::to_owned)
        .unwrap_or_else(|| join_path(&host.platform, &[&host.home_dir, ".bun"]));
    managed(
        host,
        fs,
        "BUN_INSTALL",
        &root,
        join_path(&host.platform, &[&root, "bin"]),
        "bun",
    )
}

fn managed(
    host: &PathEnv,
    fs: &dyn ToolchainFs,
    key: &'static str,
    root: &str,
    dir: String,
    binary: &str,
) -> Option<Resolved> {
    let binary = if host.is_windows() {
        format!("{binary}.exe")
    } else {
        binary.into()
    };
    if !fs.exists(&join_path(&host.platform, &[&dir, &binary])) {
        return None;
    }
    Some(Resolved {
        dir,
        manager: host
            .non_blank_var(key)
            .is_none()
            .then(|| (key, root.into())),
    })
}

fn auto_node(host: &PathEnv, fs: &dyn ToolchainFs) -> Option<Resolved> {
    if !host.is_windows()
        && let Some(nvm) = auto_nvm(host, fs)
    {
        return Some(nvm);
    }
    for root in fnm_root_candidates(host) {
        let dir = fnm_default_alias_bin_dir(&host.platform, &root);
        if let Some(found) = managed(host, fs, "FNM_DIR", &root, dir, "node") {
            return Some(found);
        }
    }
    let binary = if host.is_windows() {
        "node.exe"
    } else {
        "node"
    };
    let candidates: Vec<_> = well_known_node_directories(host)
        .into_iter()
        .filter(|dir| fs.exists(&join_path(&host.platform, &[dir, binary])))
        .collect();
    let inherited = host
        .env
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case("PATH"))
        .map(|(_, value)| value.as_str())
        .unwrap_or("");
    let inherited: HashSet<_> = inherited
        .split(host.path_list_separator())
        .map(|entry| normalized_managed_path(entry.trim(), &host.platform))
        .collect();
    if candidates
        .iter()
        .any(|dir| inherited.contains(&normalized_managed_path(dir.trim(), &host.platform)))
    {
        return None;
    }
    candidates
        .into_iter()
        .next()
        .map(|dir| Resolved { dir, manager: None })
}

fn auto_nvm(host: &PathEnv, fs: &dyn ToolchainFs) -> Option<Resolved> {
    let root = host
        .non_blank_var("NVM_DIR")
        .map(str::to_owned)
        .unwrap_or_else(|| join_path("linux", &[&host.home_dir, ".nvm"]));
    let version = nvm_default(fs, &root)?;
    let dir = join_path(
        "linux",
        &[&root, "versions", "node", &format!("v{version}"), "bin"],
    );
    managed(host, fs, "NVM_DIR", &root, dir, "node")
}

fn nvm_default(fs: &dyn ToolchainFs, root: &str) -> Option<String> {
    let mut current = fs.read_alias(&join_path("linux", &[root, "alias", "default"]))?;
    let mut seen = HashSet::new();
    for _ in 0..8 {
        let alias = current.trim();
        if let Some(version) = normalize_node_version(alias) {
            return Some(version);
        }
        if let Some(version) = newest(fs, root, alias) {
            return Some(version);
        }
        if !safe_alias(alias) || !seen.insert(alias.to_owned()) {
            return None;
        }
        current = fs.read_alias(&join_path("linux", &[root, "alias", alias]))?;
    }
    None
}

fn safe_alias(alias: &str) -> bool {
    is_safe_nvm_alias(alias) && !alias.split('/').any(|part| part == "..")
}

fn newest(fs: &dyn ToolchainFs, root: &str, selector: &str) -> Option<String> {
    let partial: Vec<u32> = if matches!(selector, "node" | "stable" | "unstable") {
        Vec::new()
    } else {
        let parts: Vec<_> = selector
            .strip_prefix('v')
            .unwrap_or(selector)
            .split('.')
            .collect();
        if parts.len() > 2
            || parts
                .iter()
                .any(|part| part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()))
        {
            return None;
        }
        parts
            .into_iter()
            .map(str::parse)
            .collect::<Result<_, _>>()
            .ok()?
    };
    fs.entries(&join_path("linux", &[root, "versions", "node"]))
        .iter()
        .filter_map(|entry| parse_exact_node_version(entry))
        .filter(|version| {
            partial
                .iter()
                .zip([version.major, version.minor])
                .all(|(wanted, actual)| *wanted == actual)
        })
        .max()
        .map(|version| version.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[derive(Default)]
    struct FakeFs {
        files: HashMap<String, String>,
        directories: HashMap<String, Vec<String>>,
    }

    impl ToolchainFs for FakeFs {
        fn exists(&self, path: &str) -> bool {
            self.files.contains_key(path)
        }
        fn read_alias(&self, path: &str) -> Option<String> {
            self.files.get(path).cloned()
        }
        fn entries(&self, path: &str) -> Vec<String> {
            self.directories.get(path).cloned().unwrap_or_default()
        }
    }

    /// Counts the real directory scans the native reader performs.
    #[derive(Default)]
    struct CountingDirectoryReader {
        scans: std::cell::Cell<usize>,
    }

    impl read_cache::Reader for CountingDirectoryReader {
        type Value = Vec<String>;
        fn identity(&self, path: &str) -> Option<String> {
            read_cache::Reader::identity(&NativeDirectoryReader, path)
        }
        fn read(&self, path: &str) -> Option<Vec<String>> {
            self.scans.set(self.scans.get() + 1);
            read_cache::Reader::read(&NativeDirectoryReader, path)
        }
    }

    /// Regression: on Windows a directory identity read failed, so every
    /// resolution re-scanned the managed-versions directory.
    #[test]
    fn an_unchanged_versions_directory_is_scanned_once() {
        let versions = crate::test_support::scratch_dir("toolchain-versions-cache");
        std::fs::create_dir(versions.join("v22.0.0")).unwrap();
        let path = versions.to_str().unwrap();
        let cache = read_cache::ReadCache::default();
        let reader = CountingDirectoryReader::default();
        for _ in 0..3 {
            assert_eq!(cache.read(path, &reader).unwrap(), ["v22.0.0"]);
        }
        assert_eq!(
            reader.scans.get(),
            1,
            "expected directory scans: 1 (then cache hits) | received: {}",
            reader.scans.get()
        );
    }

    fn host(platform: &str) -> PathEnv {
        PathEnv {
            platform: platform.into(),
            home_dir: "/home/test".into(),
            env: HashMap::from([("PATH".into(), "/base".into())]),
        }
    }

    fn auto() -> Selection {
        Selection {
            node: "auto".into(),
            bun: "auto".into(),
        }
    }

    #[test]
    fn absent_selection_preserves_source_and_pins_prepend_node_then_bun() {
        let host = host("linux");
        let fs = FakeFs::default();
        assert_eq!(build(&host, None, &fs)["PATH"], "/base");
        let selection = Selection {
            node: "/opt/node/bin/node".into(),
            bun: "/opt/bun/bin/bun".into(),
        };
        assert_eq!(
            build(&host, Some(&selection), &fs)["PATH"],
            "/opt/node/bin:/opt/bun/bin:/base"
        );
        let mut windows = host;
        windows.platform = "win32".into();
        windows.env = HashMap::from([("Path".into(), "C:\\base".into())]);
        let selection = Selection {
            node: "C:\\node\\node.exe".into(),
            bun: "D:\\bun\\bun.exe".into(),
        };
        assert_eq!(
            build(&windows, Some(&selection), &fs)["Path"],
            "C:\\node;D:\\bun;C:\\base"
        );
    }

    #[test]
    fn windows_snapshot_path_aliases_do_not_override_selected_toolchains() {
        let mut host = host("win32");
        host.env.insert("Path".into(), "C:\\old".into());
        let selection = Selection {
            node: "C:\\node\\node.exe".into(),
            bun: "C:\\bun\\bun.exe".into(),
        };
        let env = build(&host, Some(&selection), &FakeFs::default());
        assert_eq!(
            env.keys()
                .filter(|key| key.eq_ignore_ascii_case("PATH"))
                .count(),
            1
        );
        assert_eq!(env["PATH"], "C:\\node;C:\\bun;/base");
    }

    #[test]
    fn aliases_are_resolved_fresh_and_manager_variables_are_inferred() {
        let mut fs = FakeFs::default();
        fs.files
            .insert("/home/test/.nvm/alias/default".into(), "lts/*".into());
        fs.files
            .insert("/home/test/.nvm/alias/lts/*".into(), "v22.1.0".into());
        fs.files.insert(
            "/home/test/.nvm/versions/node/v22.1.0/bin/node".into(),
            String::new(),
        );
        fs.files
            .insert("/home/test/.bun/bin/bun".into(), String::new());
        let first = build(&host("linux"), Some(&auto()), &fs);
        assert_eq!(first["NVM_DIR"], "/home/test/.nvm");
        assert_eq!(first["BUN_INSTALL"], "/home/test/.bun");
        assert_eq!(
            first["PATH"],
            "/home/test/.nvm/versions/node/v22.1.0/bin:/home/test/.bun/bin:/base"
        );
        fs.files
            .insert("/home/test/.nvm/alias/lts/*".into(), "v24.0.0".into());
        fs.files.insert(
            "/home/test/.nvm/versions/node/v24.0.0/bin/node".into(),
            String::new(),
        );
        assert!(build(&host("linux"), Some(&auto()), &fs)["PATH"].contains("v24.0.0"));
    }

    #[test]
    fn partial_versions_choose_newest_and_alias_cycles_or_traversal_stop() {
        let mut fs = FakeFs::default();
        fs.directories.insert(
            "/nvm/versions/node".into(),
            ["v22.1.0", "v22.9.1", "v24.0.0", "junk"]
                .map(str::to_owned)
                .to_vec(),
        );
        assert_eq!(newest(&fs, "/nvm", "22"), Some("22.9.1".into()));
        assert_eq!(newest(&fs, "/nvm", "v22.1"), Some("22.1.0".into()));
        assert_eq!(newest(&fs, "/nvm", "stable"), Some("24.0.0".into()));
        for invalid in ["", "22.", "22.1.0.0", "lts/*"] {
            assert_eq!(newest(&fs, "/nvm", invalid), None);
        }
        for alias in ["../secret", "lts/../../secret", "bad value"] {
            assert!(!safe_alias(alias));
            fs.files.insert("/nvm/alias/default".into(), alias.into());
            assert_eq!(nvm_default(&fs, "/nvm"), None);
        }
        fs.files.insert("/nvm/alias/default".into(), "cycle".into());
        fs.files.insert("/nvm/alias/cycle".into(), "default".into());
        assert_eq!(nvm_default(&fs, "/nvm"), None);
    }

    #[test]
    fn fnm_fallback_preserves_configured_manager_and_windows_skips_nvm() {
        let mut host = host("win32");
        host.env.insert("FNM_DIR".into(), "C:\\fnm".into());
        let dir = fnm_default_alias_bin_dir("win32", "C:\\fnm");
        let mut fs = FakeFs::default();
        fs.files
            .insert(join_path("win32", &[&dir, "node.exe"]), String::new());
        let env = build(&host, Some(&auto()), &fs);
        assert_eq!(env["FNM_DIR"], "C:\\fnm");
        assert_eq!(env["PATH"], format!("{dir};/base"));
        assert!(!env.contains_key("NVM_DIR"));
    }

    #[test]
    fn auto_keeps_inherited_general_purpose_path_order() {
        let mut host = host("darwin");
        host.env.insert(
            "PATH".into(),
            "/opt/homebrew/bin:/usr/local/bin:/base".into(),
        );
        let mut fs = FakeFs::default();
        fs.files.insert("/usr/local/bin/node".into(), String::new());
        fs.files
            .insert("/opt/homebrew/bin/node".into(), String::new());
        assert_eq!(build(&host, Some(&auto()), &fs)["PATH"], host.env["PATH"]);
        host.env.insert("PATH".into(), "/base".into());
        assert!(build(&host, Some(&auto()), &fs)["PATH"].ends_with(":/base"));
    }

    #[test]
    fn auto_with_nothing_resolvable_sets_no_manager_variables() {
        let host = host("linux");
        let env = build(&host, Some(&auto()), &FakeFs::default());
        for key in ["NVM_DIR", "FNM_DIR", "BUN_INSTALL"] {
            assert!(
                !env.contains_key(key),
                "expected no {key} when nothing resolves | received {:?}",
                env.get(key)
            );
        }
        assert_eq!(
            env["PATH"], "/base",
            "expected the inherited PATH unchanged | received {:?}",
            env["PATH"]
        );
    }

    #[test]
    fn an_empty_inherited_path_gets_no_stray_separator() {
        let mut host = host("linux");
        host.env.insert("PATH".into(), String::new());
        let mut fs = FakeFs::default();
        fs.files
            .insert("/home/test/.bun/bin/bun".into(), String::new());
        let env = build(&host, Some(&auto()), &fs);
        assert_eq!(
            env["PATH"], "/home/test/.bun/bin",
            "expected only the resolved bun dir, no trailing ':' | received {:?}",
            env["PATH"]
        );
        host.env.remove("PATH");
        let env = build(&host, Some(&auto()), &fs);
        assert_eq!(
            env.get("PATH").map(String::as_str),
            Some("/home/test/.bun/bin"),
            "expected a missing PATH to become just the resolved dir | received {env:?}"
        );
    }

    #[test]
    fn configured_nvm_dir_and_bun_install_are_used_and_preserved() {
        let mut host = host("linux");
        host.env.insert("NVM_DIR".into(), "/custom/nvm".into());
        host.env.insert("BUN_INSTALL".into(), "/custom/bun".into());
        let mut fs = FakeFs::default();
        fs.files
            .insert("/custom/nvm/alias/default".into(), "v22.1.0".into());
        fs.files.insert(
            "/custom/nvm/versions/node/v22.1.0/bin/node".into(),
            String::new(),
        );
        fs.files.insert("/custom/bun/bin/bun".into(), String::new());
        let env = build(&host, Some(&auto()), &fs);
        assert_eq!(
            (env["NVM_DIR"].as_str(), env["BUN_INSTALL"].as_str()),
            ("/custom/nvm", "/custom/bun"),
            "expected the configured manager roots kept | received NVM_DIR={:?} BUN_INSTALL={:?}",
            env["NVM_DIR"],
            env["BUN_INSTALL"]
        );
        assert_eq!(
            env["PATH"], "/custom/nvm/versions/node/v22.1.0/bin:/custom/bun/bin:/base",
            "expected PATH built from the configured roots | received {:?}",
            env["PATH"]
        );
    }

    #[test]
    fn native_filesystem_bounds_alias_reads_and_reports_missing_paths() {
        let dir = crate::test_support::scratch_dir("toolchain-native");
        let alias = dir.join("alias");
        std::fs::write(&alias, "v22.1.0").unwrap();
        let path = alias.to_str().unwrap();
        assert!(NativeToolchainFs.exists(path));
        assert_eq!(NativeToolchainFs.read_alias(path), Some("v22.1.0".into()));
        assert_eq!(NativeToolchainFs.entries(dir.to_str().unwrap()), ["alias"]);
        std::fs::write(&alias, "x".repeat(4097)).unwrap();
        assert_eq!(NativeToolchainFs.read_alias(path), None);
        let missing = dir.join("missing");
        let missing = missing.to_str().unwrap();
        assert!(!NativeToolchainFs.exists(missing));
        assert_eq!(NativeToolchainFs.read_alias(missing), None);
        assert!(NativeToolchainFs.entries(missing).is_empty());
    }
}

#[cfg(all(test, unix))]
#[test]
fn native_directory_cache_tracks_installs_and_equal_metadata_replacement() {
    use crate::test_support::scratch_dir;
    let home = scratch_dir("toolchain-directory-cache");
    let versions = home.join("versions");
    std::fs::create_dir(&versions).unwrap();
    std::fs::create_dir(versions.join("v20.0.0")).unwrap();
    let path = versions.to_str().unwrap();
    assert_eq!(NativeToolchainFs.entries(path), ["v20.0.0"]);
    std::fs::create_dir(versions.join("v22.0.0")).unwrap();
    std::fs::File::open(&versions)
        .unwrap()
        .set_modified(std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(100))
        .unwrap();
    assert!(NativeToolchainFs.entries(path).contains(&"v22.0.0".into()));
    let modified = std::fs::metadata(&versions).unwrap().modified().unwrap();
    std::fs::rename(&versions, home.join("old-versions")).unwrap();
    std::fs::create_dir(&versions).unwrap();
    std::fs::create_dir(versions.join("v24.0.0")).unwrap();
    std::fs::File::open(&versions)
        .unwrap()
        .set_modified(modified)
        .unwrap();
    assert_eq!(NativeToolchainFs.entries(path), ["v24.0.0"]);
}

#[cfg(all(test, unix))]
#[test]
fn alias_cache_observes_in_place_edits_with_restored_timestamps() {
    use crate::test_support::scratch_dir;
    let home = scratch_dir("toolchain-alias-cache");
    let alias = home.join("default");
    assert!(
        NativeToolchainFs
            .read_alias(alias.to_str().unwrap())
            .is_none()
    );
    std::fs::write(&alias, "v20.0.0").unwrap();
    let modified = std::fs::metadata(&alias).unwrap().modified().unwrap();
    assert_eq!(
        NativeToolchainFs
            .read_alias(alias.to_str().unwrap())
            .as_deref(),
        Some("v20.0.0")
    );
    std::fs::write(&alias, "v22.0.0").unwrap();
    std::fs::File::options()
        .write(true)
        .open(&alias)
        .unwrap()
        .set_modified(modified)
        .unwrap();
    assert_eq!(
        NativeToolchainFs
            .read_alias(alias.to_str().unwrap())
            .as_deref(),
        Some("v22.0.0")
    );
}
