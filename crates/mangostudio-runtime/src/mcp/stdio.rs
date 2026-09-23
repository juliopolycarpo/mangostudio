//! What a stdio server is launched with: exact argv plus an allowlisted environment.

use std::collections::BTreeMap;
use std::path::PathBuf;

use super::process::StdioLaunch;
use super::types::{McpConfig, McpSecrets};
use crate::config::EnvSource;

/// Builds the launch for a stdio row, or says why the row cannot be launched.
///
/// # Example
/// ```ignore
/// let launch = stdio_launch(&config, &secrets, &crate::config::ProcessEnv)?;
/// ```
pub(crate) fn stdio_launch(
    config: &McpConfig,
    secrets: &McpSecrets,
    source: &dyn EnvSource,
) -> Result<StdioLaunch, String> {
    let command = config
        .command
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            format!(
                "MCP server \"{}\" has command {:?}; expected a non-empty stdio command",
                config.slug, config.command
            )
        })?;
    Ok(StdioLaunch {
        program: PathBuf::from(command),
        args: config.args.clone(),
        env: child_env(source, &config.env, &secrets.env),
    })
}

/// Allowlisted inherited variables, then the row's env, then its secret env (later wins).
///
/// Mirrors `apps/runtime/src/services/mcp/stdio-env.ts`: a stdio server inherits nothing but a
/// few basics, so the runtime's own credentials never reach it, and an exported shell function
/// (`() { ... }`) is never forwarded.
pub(crate) fn child_env(
    source: &dyn EnvSource,
    configured: &BTreeMap<String, String>,
    secrets: &BTreeMap<String, String>,
) -> BTreeMap<String, String> {
    #[cfg(windows)]
    const KEYS: &[&str] = &[
        "APPDATA",
        "HOMEDRIVE",
        "HOMEPATH",
        "LOCALAPPDATA",
        "PATH",
        "PROCESSOR_ARCHITECTURE",
        "SYSTEMDRIVE",
        "SYSTEMROOT",
        "TEMP",
        "USERNAME",
        "USERPROFILE",
        "PROGRAMFILES",
    ];
    #[cfg(not(windows))]
    const KEYS: &[&str] = &[
        "HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER", "TMPDIR", "LANG", "LC_ALL",
    ];
    let mut env = BTreeMap::new();
    for &key in KEYS {
        if let Some(value) = source.var(key).filter(|value| !value.starts_with("()")) {
            env.insert(key.to_owned(), value);
        }
    }
    env.extend(configured.clone());
    env.extend(secrets.clone());
    env
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::MapEnv;

    fn row(command: Option<&str>) -> McpConfig {
        McpConfig {
            id: "one".into(),
            slug: "fixture".into(),
            transport: "stdio".into(),
            command: command.map(str::to_owned),
            args: vec!["--flag".into()],
            env: BTreeMap::from([("PATH".into(), "/custom/bin".into())]),
            url: None,
            timeout_ms: None,
        }
    }

    #[test]
    fn secret_bearing_process_variables_never_reach_the_child() {
        let source = MapEnv::from([
            ("PATH", "/usr/bin"),
            ("BETTER_AUTH_SECRET", "auth-secret"),
            ("OPENAI_API_KEY", "provider-key"),
            ("RANDOM_APP_VAR", "not-allowlisted"),
        ]);
        let env = child_env(&source, &BTreeMap::new(), &BTreeMap::new());
        assert_eq!(env.keys().collect::<Vec<_>>(), vec!["PATH"]);
    }

    #[test]
    fn row_env_then_secret_env_override_inherited_values() {
        let source = MapEnv::from([("HOME", "/home/owner"), ("PATH", "/usr/bin")]);
        let configured = BTreeMap::from([
            ("PATH".into(), "/custom/bin".into()),
            ("MCP_FLAG".into(), "on".into()),
        ]);
        let secrets = BTreeMap::from([("MCP_FLAG".into(), "secret".into())]);
        let env = child_env(&source, &configured, &secrets);
        assert_eq!(env.get("PATH").map(String::as_str), Some("/custom/bin"));
        assert_eq!(env.get("MCP_FLAG").map(String::as_str), Some("secret"));
        #[cfg(not(windows))]
        assert_eq!(env.get("HOME").map(String::as_str), Some("/home/owner"));
    }

    #[test]
    fn exported_shell_functions_are_skipped() {
        let source = MapEnv::from([("PATH", "() { :; }; echo pwned")]);
        let env = child_env(&source, &BTreeMap::new(), &BTreeMap::new());
        assert!(
            !env.contains_key("PATH"),
            "expected no PATH | received {env:?}"
        );
    }

    #[test]
    fn a_row_without_a_command_is_refused_with_the_expected_shape() {
        let secrets = McpSecrets::default();
        let source = MapEnv::from([("PATH", "/usr/bin")]);
        for command in [None, Some("  ")] {
            let error = stdio_launch(&row(command), &secrets, &source)
                .expect_err("expected a refusal for a missing command");
            assert!(
                error.contains("expected a non-empty stdio command"),
                "expected the refusal to name the expected shape | received {error}"
            );
        }
        let launch = stdio_launch(&row(Some("server")), &secrets, &source).expect("launchable");
        assert_eq!(launch.program, PathBuf::from("server"));
        assert_eq!(launch.args, vec!["--flag".to_owned()]);
    }
}
