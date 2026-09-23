//! The installer's child environment: an allowlist over the toolchain-adjusted host snapshot.
//!
//! Mirrors `buildInstallEnvironment` in `apps/runtime/src/services/install.ts`. Inheriting the
//! whole environment would hand a third-party installer every credential this runtime holds.

use std::collections::BTreeMap;

/// Host keys an installer legitimately needs on every platform.
const INSTALL_ENV_KEYS: [&str; 20] = [
    "PATH",
    "HOME",
    "SHELL",
    "TMPDIR",
    "TMP",
    "TEMP",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_RUNTIME_DIR",
    "NVM_DIR",
    "FNM_DIR",
    "BUN_INSTALL",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
];

/// win32-only keys: what lets PowerShell start, plus what winget and vendor scripts read.
const WIN32_INSTALL_ENV_KEYS: [&str; 11] = [
    "SystemRoot",
    "WINDIR",
    "ComSpec",
    "PATHEXT",
    "SystemDrive",
    "USERPROFILE",
    "LOCALAPPDATA",
    "APPDATA",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "ProgramData",
];

/// The only keys a recipe's own `env` may set; anything else it sends is dropped.
const RECIPE_ENV_KEYS: [&str; 4] = ["NVM_DIR", "PROFILE", "CODEX_NON_INTERACTIVE", "FNM_DIR"];

/// Filters `source` (the toolchain-adjusted host environment) down to the install allowlist and
/// overlays the constant recipe keys from `recipe`.
///
/// `platform` is the host's `process.platform` value, injected so the win32 allowlist is
/// reachable from tests on any host. A differently-cased `PATH` key (Windows' `Path`) is read
/// case-insensitively and always written back as `PATH`.
///
/// # Example
///
/// ```ignore
/// let source = BTreeMap::from([("Path".into(), "C:\\nodejs".into()), ("TOKEN".into(), "x".into())]);
/// let env = install_environment(&source, &BTreeMap::new(), "win32");
/// assert_eq!(env, BTreeMap::from([("PATH".into(), "C:\\nodejs".into())]));
/// ```
pub(crate) fn install_environment(
    source: &BTreeMap<String, String>,
    recipe: &BTreeMap<String, String>,
    platform: &str,
) -> BTreeMap<String, String> {
    let win32: &[&str] = if platform == "win32" {
        &WIN32_INSTALL_ENV_KEYS
    } else {
        &[]
    };
    let path_key = source
        .keys()
        .find(|key| key.eq_ignore_ascii_case("PATH"))
        .map_or("PATH", String::as_str);
    let mut env = BTreeMap::new();
    for key in INSTALL_ENV_KEYS.iter().chain(win32) {
        let lookup = if *key == "PATH" { path_key } else { key };
        if let Some(value) = source.get(lookup) {
            env.insert((*key).to_owned(), value.clone());
        }
    }
    for key in RECIPE_ENV_KEYS {
        if let Some(value) = recipe.get(key) {
            env.insert(key.to_owned(), value.clone());
        }
    }
    env
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::install_environment;

    fn map(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
            .collect()
    }

    /// TS: "passes only allowlisted environment keys plus constant recipe overrides".
    #[test]
    fn passes_only_allowlisted_keys_plus_constant_recipe_overrides() {
        let env = install_environment(
            &map(&[
                ("PATH", "/bin"),
                ("HOME", "/home/tester"),
                ("XDG_CONFIG_HOME", "/home/tester/.config"),
                ("HTTPS_PROXY", "https://proxy.test"),
                ("ANTHROPIC_API_KEY", "secret"),
                ("GITHUB_TOKEN", "secret"),
                ("FNM_DIR", "/home/tester/.local/share/fnm"),
            ]),
            &map(&[
                ("PROFILE", "/dev/null"),
                ("NVM_DIR", "/home/tester/.nvm"),
                ("ANTHROPIC_API_KEY", "still-secret"),
            ]),
            "linux",
        );

        assert_eq!(
            env,
            map(&[
                ("PATH", "/bin"),
                ("HOME", "/home/tester"),
                ("XDG_CONFIG_HOME", "/home/tester/.config"),
                ("HTTPS_PROXY", "https://proxy.test"),
                ("FNM_DIR", "/home/tester/.local/share/fnm"),
                ("PROFILE", "/dev/null"),
                ("NVM_DIR", "/home/tester/.nvm"),
            ]),
            "expected only allowlisted host keys and constant recipe keys"
        );
    }

    /// TS: "accepts CODEX_NON_INTERACTIVE and FNM_DIR as constant recipe overrides".
    #[test]
    fn accepts_codex_non_interactive_and_fnm_dir_recipe_overrides() {
        let env = install_environment(
            &map(&[("PATH", "/bin")]),
            &map(&[
                ("CODEX_NON_INTERACTIVE", "1"),
                ("FNM_DIR", "/home/tester/.fnm"),
                ("ANTHROPIC_API_KEY", "secret"),
            ]),
            "linux",
        );

        assert_eq!(
            env,
            map(&[
                ("PATH", "/bin"),
                ("CODEX_NON_INTERACTIVE", "1"),
                ("FNM_DIR", "/home/tester/.fnm"),
            ])
        );
    }

    /// TS: "forwards the win32-only keys PowerShell and its installers need, only on win32" and
    /// "selects the win32 environment allowlist from the injected platform".
    #[test]
    fn forwards_win32_keys_only_for_an_injected_win32_platform() {
        let source = map(&[
            ("PATH", "C:\\bin"),
            ("SystemRoot", "C:\\Windows"),
            ("WINDIR", "C:\\Windows"),
            ("ComSpec", "C:\\Windows\\System32\\cmd.exe"),
            ("PATHEXT", ".EXE;.BAT"),
            ("SystemDrive", "C:"),
            ("USERPROFILE", "C:\\Users\\tester"),
            ("LOCALAPPDATA", "C:\\Users\\tester\\AppData\\Local"),
            ("APPDATA", "C:\\Users\\tester\\AppData\\Roaming"),
            ("ProgramFiles", "C:\\Program Files"),
            ("ProgramFiles(x86)", "C:\\Program Files (x86)"),
            ("ProgramData", "C:\\ProgramData"),
        ]);

        assert_eq!(
            install_environment(&source, &BTreeMap::new(), "win32"),
            source,
            "expected every win32 key forwarded on win32"
        );
        assert_eq!(
            install_environment(&source, &BTreeMap::new(), "linux"),
            map(&[("PATH", "C:\\bin")]),
            "expected only PATH forwarded off win32"
        );
    }

    /// TS: "reads a differently-cased PATH key and normalizes it to PATH".
    #[test]
    fn reads_a_differently_cased_path_key_and_normalizes_it() {
        let env = install_environment(
            &map(&[("Path", "C:\\nodejs"), ("HOME", "C:\\Users\\tester")]),
            &BTreeMap::new(),
            "linux",
        );

        assert_eq!(
            env,
            map(&[("PATH", "C:\\nodejs"), ("HOME", "C:\\Users\\tester")]),
            "expected the Path value written back under PATH and no Path key"
        );
    }
}
