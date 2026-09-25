//! The five [`RuntimeDefinition`] constants and their version parsers and
//! well-known-directory functions, mirroring
//! `apps/shared/src/environments/detection/runtime-definitions.ts`.

use std::sync::LazyLock;

use regex::Regex;

use super::binary_scan::RuntimeDefinition;
use super::fnm::{fnm_default_alias_bin_dir, fnm_root_candidates};
use super::path_env::{PathEnv, join_path};
use super::types::{RuntimeId, SemVer};

pub use super::binary_scan::windows_default_fnm_dir;

static OPTIONAL_V_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^v?(\d+)\.(\d+)\.(\d+)").expect("a fixed, hand-checked pattern"));
static PLAIN_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(\d+)\.(\d+)\.(\d+)").expect("a fixed, hand-checked pattern"));

/// Parses `node --version` output (`v22.13.0`); the leading `v` is
/// optional and trailing content after the version is tolerated (a
/// release candidate suffix, for instance).
#[must_use]
pub fn parse_node_version(raw: &str) -> Option<SemVer> {
    SemVer::parse_trimmed(raw, &OPTIONAL_V_PATTERN)
}

/// Parses `bun --version` output (`1.2.3`); no `v` prefix.
#[must_use]
pub fn parse_bun_version(raw: &str) -> Option<SemVer> {
    SemVer::parse_trimmed(raw, &PLAIN_PATTERN)
}

/// Parses `winget --version` output (`v1.29.290`).
#[must_use]
pub fn parse_winget_version(raw: &str) -> Option<SemVer> {
    SemVer::parse_trimmed(raw, &OPTIONAL_V_PATTERN)
}

/// `raw` is searched rather than anchored: fnm and git prefix their
/// version with their own name. That makes every position in `raw` its
/// own match attempt, so each component is capped at `{1,9}` rather than
/// left as `\d+` — unbounded, rejecting a long digit run costs quadratic
/// time, and `raw` is a probed binary's stdout rather than a shape this
/// process controls. No real version component is nine digits wide.
fn parse_semver_anywhere(raw: &str, pattern: &Regex) -> Option<SemVer> {
    SemVer::from_captures(&pattern.captures(raw)?)
}

static FNM_VERSION_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(\d{1,9})\.(\d{1,9})\.(\d{1,9})").expect("a fixed, hand-checked pattern")
});

/// Parses `fnm --version` output: `fnm 1.38.1`.
#[must_use]
pub fn parse_fnm_version(raw: &str) -> Option<SemVer> {
    parse_semver_anywhere(raw, &FNM_VERSION_PATTERN)
}

static GIT_VERSION_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)git version\s+(\d{1,9})\.(\d{1,9})\.(\d{1,9})")
        .expect("a fixed, hand-checked pattern")
});

/// Parses `git --version` output: `git version 2.43.0`, or
/// `2.43.0.windows.1` on win32 — the suffix is dropped.
#[must_use]
pub fn parse_git_version(raw: &str) -> Option<SemVer> {
    parse_semver_anywhere(raw, &GIT_VERSION_PATTERN)
}

fn present(value: Option<&str>) -> Option<&str> {
    value.filter(|value| !value.trim().is_empty())
}

/// The same truthiness `LOCALAPPDATA ? … : []`/`ProgramFiles ? … : []`
/// check in the TypeScript source: non-empty, but not trimmed first —
/// distinct from `present`, which the node well-known-directories list
/// above needs because its own final filter trims.
fn non_empty(value: Option<&str>) -> Option<&str> {
    value.filter(|value| !value.is_empty())
}

/// The well-known Node directories to search beyond `PATH`.
#[must_use]
pub fn well_known_node_directories(env: &PathEnv) -> Vec<String> {
    if env.is_windows() {
        let mut dirs = Vec::new();
        if let Some(nvm_symlink) = present(env.env_var("NVM_SYMLINK")) {
            dirs.push(nvm_symlink.to_string());
        }
        if let Some(program_files) = present(env.env_var("ProgramFiles")) {
            dirs.push(join_path("win32", &[program_files, "nodejs"]));
        }
        if let Some(program_files_x86) = present(env.env_var("ProgramFiles(x86)")) {
            dirs.push(join_path("win32", &[program_files_x86, "nodejs"]));
        }
        if let Some(localappdata) = present(env.env_var("LOCALAPPDATA")) {
            dirs.push(join_path("win32", &[localappdata, "Programs", "nodejs"]));
        }
        let fnm_dir = present(env.env_var("FNM_DIR"))
            .map(str::to_string)
            .or_else(|| windows_default_fnm_dir(env));
        if let Some(fnm_dir) = fnm_dir {
            dirs.push(join_path("win32", &[&fnm_dir, "aliases", "default"]));
        }
        if let Some(volta_home) = present(env.env_var("VOLTA_HOME")) {
            dirs.push(join_path("win32", &[volta_home, "bin"]));
        }
        return dirs;
    }

    let mut dirs = vec![
        "/usr/local/bin".to_string(),
        "/opt/homebrew/bin".to_string(),
        join_path(&env.platform, &[&env.home_dir, ".volta", "bin"]),
    ];
    for root in fnm_root_candidates(env) {
        dirs.push(fnm_default_alias_bin_dir(&env.platform, &root));
    }
    dirs
}

fn well_known_bun_directories(env: &PathEnv) -> Vec<String> {
    let configured_root = present(env.env_var("BUN_INSTALL"));
    let root = match configured_root {
        Some(root) => root.to_string(),
        None => join_path(&env.platform, &[&env.home_dir, ".bun"]),
    };
    vec![join_path(&env.platform, &[&root, "bin"])]
}

/// fnm installs its binary into its own root, so the search list is the
/// root ladder itself — [`fnm_root_candidates`], never a second spelling
/// of it. On win32 winget links the executable elsewhere, which is the
/// one directory the ladder does not own.
fn well_known_fnm_directories(env: &PathEnv) -> Vec<String> {
    let mut dirs = Vec::new();
    if env.is_windows()
        && let Some(localappdata) = non_empty(env.env_var("LOCALAPPDATA"))
    {
        // winget's fnm manifest links here.
        dirs.push(join_path(
            "win32",
            &[localappdata, "Microsoft", "WinGet", "Links"],
        ));
    }
    dirs.extend(fnm_root_candidates(env));
    dirs
}

fn well_known_git_directories(env: &PathEnv) -> Vec<String> {
    if !env.is_windows() {
        return Vec::new();
    }
    match non_empty(env.env_var("ProgramFiles")) {
        Some(program_files) => vec![join_path("win32", &[program_files, "Git", "cmd"])],
        None => Vec::new(),
    }
}

fn well_known_winget_directories(env: &PathEnv) -> Vec<String> {
    if !env.is_windows() {
        return Vec::new();
    }
    match non_empty(env.env_var("LOCALAPPDATA")) {
        Some(localappdata) => vec![join_path(
            "win32",
            &[localappdata, "Microsoft", "WindowsApps"],
        )],
        None => Vec::new(),
    }
}

/// Node.js.
pub const NODE_RUNTIME_DEFINITION: RuntimeDefinition = RuntimeDefinition {
    id: RuntimeId::Node,
    binary_names: &["node"],
    version_args: &["--version"],
    parse_version: parse_node_version,
    keep_unparsed_version: false,
    well_known_dirs: well_known_node_directories,
    include_bare_binary_names: false,
    shared_binary_names: &[],
    windows_powershell_scripts: false,
};

/// Bun.
pub const BUN_RUNTIME_DEFINITION: RuntimeDefinition = RuntimeDefinition {
    id: RuntimeId::Bun,
    binary_names: &["bun"],
    version_args: &["--version"],
    parse_version: parse_bun_version,
    keep_unparsed_version: false,
    well_known_dirs: well_known_bun_directories,
    include_bare_binary_names: false,
    shared_binary_names: &[],
    windows_powershell_scripts: false,
};

/// fnm — the second helper-managed Node manager; win32-installable,
/// unlike nvm.
pub const FNM_RUNTIME_DEFINITION: RuntimeDefinition = RuntimeDefinition {
    id: RuntimeId::Fnm,
    binary_names: &["fnm"],
    version_args: &["--version"],
    parse_version: parse_fnm_version,
    keep_unparsed_version: false,
    well_known_dirs: well_known_fnm_directories,
    include_bare_binary_names: false,
    shared_binary_names: &[],
    windows_powershell_scripts: false,
};

/// git — probed as a prerequisite for the Windows recipes; never
/// installed by MangoStudio.
pub const GIT_RUNTIME_DEFINITION: RuntimeDefinition = RuntimeDefinition {
    id: RuntimeId::Git,
    binary_names: &["git"],
    version_args: &["--version"],
    parse_version: parse_git_version,
    keep_unparsed_version: false,
    well_known_dirs: well_known_git_directories,
    include_bare_binary_names: false,
    shared_binary_names: &[],
    windows_powershell_scripts: false,
};

/// winget — probed as a prerequisite for the Windows recipes; never
/// installed by MangoStudio.
pub const WINGET_RUNTIME_DEFINITION: RuntimeDefinition = RuntimeDefinition {
    id: RuntimeId::Winget,
    binary_names: &["winget"],
    version_args: &["--version"],
    parse_version: parse_winget_version,
    keep_unparsed_version: false,
    well_known_dirs: well_known_winget_directories,
    include_bare_binary_names: false,
    shared_binary_names: &[],
    windows_powershell_scripts: false,
};

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    fn win32_env() -> PathEnv {
        PathEnv {
            platform: "win32".to_string(),
            home_dir: "C:\\Users\\tester".to_string(),
            env: HashMap::from([
                (
                    "LOCALAPPDATA".to_string(),
                    "C:\\Users\\tester\\AppData\\Local".to_string(),
                ),
                (
                    "APPDATA".to_string(),
                    "C:\\Users\\tester\\AppData\\Roaming".to_string(),
                ),
                ("ProgramFiles".to_string(), "C:\\Program Files".to_string()),
            ]),
        }
    }

    fn posix_env() -> PathEnv {
        PathEnv {
            platform: "linux".to_string(),
            home_dir: "/home/tester".to_string(),
            env: HashMap::new(),
        }
    }

    #[test]
    fn accepts_node_and_bun_output_formats_and_rejects_garbage() {
        assert_eq!(
            parse_node_version("v22.13.0"),
            Some(SemVer {
                major: 22,
                minor: 13,
                patch: 0
            })
        );
        assert_eq!(
            parse_bun_version("1.2.3"),
            Some(SemVer {
                major: 1,
                minor: 2,
                patch: 3
            })
        );
        assert_eq!(parse_node_version("not a version"), None);
        assert_eq!(parse_bun_version("v1.2.3"), None);
    }

    #[test]
    fn parses_fnm_version_output() {
        assert_eq!(
            parse_fnm_version("fnm 1.38.1"),
            Some(SemVer {
                major: 1,
                minor: 38,
                patch: 1
            })
        );
        assert_eq!(parse_fnm_version("not a version"), None);
    }

    #[test]
    fn parses_git_version_dropping_a_win32_windows_suffix() {
        assert_eq!(
            parse_git_version("git version 2.43.0"),
            Some(SemVer {
                major: 2,
                minor: 43,
                patch: 0
            })
        );
        assert_eq!(
            parse_git_version("git version 2.43.0.windows.1"),
            Some(SemVer {
                major: 2,
                minor: 43,
                patch: 0
            })
        );
        assert_eq!(parse_git_version("not a version"), None);
    }

    #[test]
    fn parses_winget_version_output() {
        assert_eq!(
            parse_winget_version("v1.29.290"),
            Some(SemVer {
                major: 1,
                minor: 29,
                patch: 290
            })
        );
        assert_eq!(parse_winget_version("not a version"), None);
    }

    /// Both `parse_fnm_version` and `parse_git_version` search rather than
    /// anchor, so every position in a long digit run is its own match
    /// attempt. A bounded `{1,9}` repetition keeps that linear; this
    /// proves correctness (rejects the input) rather than timing it, since
    /// a timing assertion in CI is its own source of flakiness — the
    /// TypeScript test this mirrors measures wall time instead and notes
    /// ~1.2s unbounded vs ~0.5ms bounded on its own machine.
    #[test]
    fn rejects_a_long_digit_run_without_a_match() {
        let digits = "0".repeat(30_000);
        assert_eq!(parse_fnm_version(&digits), None);
        assert_eq!(parse_git_version(&format!("git version {digits}")), None);
    }

    #[test]
    fn resolves_fnm_well_known_directories_the_winget_link_then_fnm_dir_then_its_default() {
        let env = win32_env();
        assert_eq!(
            (FNM_RUNTIME_DEFINITION.well_known_dirs)(&env),
            vec![
                "C:\\Users\\tester\\AppData\\Local\\Microsoft\\WinGet\\Links".to_string(),
                "C:\\Users\\tester\\AppData\\Roaming\\fnm".to_string()
            ]
        );

        let mut with_fnm_dir = env.clone();
        with_fnm_dir
            .env
            .insert("FNM_DIR".to_string(), "C:\\custom\\fnm".to_string());
        assert_eq!(
            (FNM_RUNTIME_DEFINITION.well_known_dirs)(&with_fnm_dir),
            vec![
                "C:\\Users\\tester\\AppData\\Local\\Microsoft\\WinGet\\Links".to_string(),
                "C:\\custom\\fnm".to_string(),
                "C:\\Users\\tester\\AppData\\Roaming\\fnm".to_string(),
            ]
        );

        assert_eq!(
            (FNM_RUNTIME_DEFINITION.well_known_dirs)(&posix_env()),
            vec![
                "/home/tester/.local/share/fnm".to_string(),
                "/home/tester/.fnm".to_string()
            ]
        );
    }

    #[test]
    fn resolves_git_well_known_directories_on_win32_only() {
        assert_eq!(
            (GIT_RUNTIME_DEFINITION.well_known_dirs)(&win32_env()),
            vec!["C:\\Program Files\\Git\\cmd".to_string()]
        );
        assert!((GIT_RUNTIME_DEFINITION.well_known_dirs)(&posix_env()).is_empty());
    }

    /// An empty (but present) `ProgramFiles`/`LOCALAPPDATA` must read the
    /// same as an absent one — matching the TypeScript source's own
    /// `ProgramFiles ? … : []` truthiness check, not "the key exists".
    #[test]
    fn an_empty_env_var_is_treated_as_absent_for_git_and_winget_and_fnms_winget_link() {
        let mut env = win32_env();
        env.env.insert("ProgramFiles".to_string(), String::new());
        env.env.insert("LOCALAPPDATA".to_string(), String::new());
        assert!((GIT_RUNTIME_DEFINITION.well_known_dirs)(&env).is_empty());
        assert!((WINGET_RUNTIME_DEFINITION.well_known_dirs)(&env).is_empty());
        assert!(
            !(FNM_RUNTIME_DEFINITION.well_known_dirs)(&env)
                .iter()
                .any(|dir| dir.contains("WinGet"))
        );
    }

    #[test]
    fn resolves_winget_well_known_directories_on_win32_only() {
        assert_eq!(
            (WINGET_RUNTIME_DEFINITION.well_known_dirs)(&win32_env()),
            vec!["C:\\Users\\tester\\AppData\\Local\\Microsoft\\WindowsApps".to_string()]
        );
        assert!((WINGET_RUNTIME_DEFINITION.well_known_dirs)(&posix_env()).is_empty());
    }

    #[test]
    fn resolves_node_well_known_directories_on_win32_with_the_default_fnm_alias() {
        let dirs = (NODE_RUNTIME_DEFINITION.well_known_dirs)(&win32_env());
        assert!(
            dirs.contains(
                &"C:\\Users\\tester\\AppData\\Roaming\\fnm\\aliases\\default".to_string()
            )
        );
        assert!(dirs.contains(&"C:\\Program Files\\nodejs".to_string()));
    }

    #[test]
    fn resolves_bun_well_known_directory_under_a_custom_bun_install() {
        let mut env = posix_env();
        env.env
            .insert("BUN_INSTALL".to_string(), "/opt/bun-custom".to_string());
        assert_eq!(
            (BUN_RUNTIME_DEFINITION.well_known_dirs)(&env),
            vec!["/opt/bun-custom/bin".to_string()]
        );
    }

    #[test]
    fn resolves_bun_well_known_directory_under_the_default_home() {
        let env = posix_env();
        assert_eq!(
            (BUN_RUNTIME_DEFINITION.well_known_dirs)(&env),
            vec!["/home/tester/.bun/bin".to_string()]
        );
    }
}
