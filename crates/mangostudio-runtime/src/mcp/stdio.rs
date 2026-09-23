//! What a stdio server is launched with: exact argv plus an allowlisted environment.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

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
    let env = child_env(source, &config.env, &secrets.env);
    let program = if cfg!(windows) {
        resolve_windows_program(
            command,
            env_value(&env, "PATH"),
            env_value(&env, "PATHEXT"),
            &|candidate| candidate.is_file(),
        )
        .map_err(|message| format!("MCP server \"{}\" {message}", config.slug))?
    } else {
        PathBuf::from(command)
    };
    Ok(StdioLaunch {
        program,
        args: config.args.clone(),
        env,
    })
}

/// Extensions tried when the child environment carries no `PATHEXT`: Windows' own default,
/// the same fallback the runtime's binary probing uses.
const DEFAULT_PATHEXT: &str = ".COM;.EXE;.BAT;.CMD";

/// A variable from the child's environment map, matched case-insensitively as Windows does.
fn env_value<'a>(env: &'a BTreeMap<String, String>, key: &str) -> Option<&'a str> {
    env.iter()
        .find(|(name, _)| name.eq_ignore_ascii_case(key))
        .map(|(_, value)| value.as_str())
}

/// Resolves a stdio command the way the TypeScript host's cross-spawn does on Windows, so a
/// row such as `npx` finds `npx.cmd`: a bare name is searched in each `PATH` directory with each
/// `PATHEXT` extension (the name as written first when it already has one), and a path is tried
/// as written and then with each extension. The search reads only the environment the server
/// will run with, never the runtime's own, and does not look in the runtime's working directory.
///
/// # Example
/// ```ignore
/// let program = resolve_windows_program("npx", Some(r"C:\nodejs"), None, &|p| p.is_file())?;
/// assert_eq!(program, PathBuf::from(r"C:\nodejs\npx.CMD"));
/// ```
pub(crate) fn resolve_windows_program(
    command: &str,
    path: Option<&str>,
    pathext: Option<&str>,
    is_file: &dyn Fn(&Path) -> bool,
) -> Result<PathBuf, String> {
    let extensions = pathext
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(DEFAULT_PATHEXT)
        .split(';')
        .map(str::trim)
        .filter(|extension| !extension.is_empty())
        .collect::<Vec<_>>();
    let file_name = command.rsplit(['\\', '/']).next().unwrap_or(command);
    let has_extension = file_name.contains('.');
    let names = |base: &str| {
        let mut names = Vec::with_capacity(extensions.len() + 1);
        if has_extension {
            names.push(base.to_owned());
        }
        names.extend(
            extensions
                .iter()
                .map(|extension| format!("{base}{extension}")),
        );
        names
    };
    let is_path = command.contains(['\\', '/']) || command.contains(':');
    let candidates = if is_path {
        names(command)
    } else {
        path.unwrap_or_default()
            .split(';')
            .map(|directory| directory.trim().trim_matches('"'))
            .filter(|directory| !directory.is_empty())
            .flat_map(|directory| {
                let directory = directory.trim_end_matches(['\\', '/']);
                names(&format!("{directory}\\{command}"))
            })
            .collect()
    };
    candidates
        .into_iter()
        .map(PathBuf::from)
        .find(|candidate| is_file(candidate))
        .ok_or_else(|| {
            format!(
                "command \"{command}\" was not found on the server's PATH with extensions \
                 {extensions:?}; expected an executable name on that PATH or a full path"
            )
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

    fn on_disk(files: &'static [&'static str]) -> impl Fn(&Path) -> bool {
        move |candidate| files.iter().any(|file| Path::new(file) == candidate)
    }

    #[test]
    fn a_bare_name_finds_its_cmd_shim_on_the_child_path() {
        let exists = on_disk(&[r"C:\nodejs\npx.CMD", r"C:\nodejs\node.EXE"]);
        let resolved = resolve_windows_program(
            "npx",
            Some(r"C:\Windows\System32;C:\nodejs\"),
            Some(".COM;.EXE;.BAT;.CMD"),
            &exists,
        );
        assert_eq!(resolved, Ok(PathBuf::from(r"C:\nodejs\npx.CMD")));
        let defaulted = resolve_windows_program("npx", Some(r"C:\nodejs"), None, &exists);
        assert_eq!(
            defaulted,
            Ok(PathBuf::from(r"C:\nodejs\npx.CMD")),
            "expected the default PATHEXT"
        );
    }

    #[test]
    fn an_explicit_extension_is_tried_as_written_first() {
        let exists = on_disk(&[r"C:\tools\uvx.exe", r"C:\tools\uvx.exe.CMD"]);
        let resolved =
            resolve_windows_program("uvx.exe", Some(r"C:\tools"), Some(".EXE;.CMD"), &exists);
        assert_eq!(resolved, Ok(PathBuf::from(r"C:\tools\uvx.exe")));
    }

    #[test]
    fn a_path_is_used_as_written_or_with_an_extension_and_never_searched() {
        let exists = on_disk(&[r"D:\servers\run.bat", r"C:\elsewhere\run.bat"]);
        assert_eq!(
            resolve_windows_program(r"D:\servers\run.bat", Some(r"C:\elsewhere"), None, &exists),
            Ok(PathBuf::from(r"D:\servers\run.bat"))
        );
        assert_eq!(
            resolve_windows_program(
                r"D:\servers\run",
                Some(r"C:\elsewhere"),
                Some(".bat"),
                &exists
            ),
            Ok(PathBuf::from(r"D:\servers\run.bat")),
            "expected the path completed with an extension, not searched on PATH"
        );
    }

    #[test]
    fn a_missing_command_is_refused_with_the_expected_shape() {
        let error = resolve_windows_program("nope", Some(r"C:\tools"), None, &on_disk(&[]))
            .expect_err("expected not found");
        assert!(
            error.contains("command \"nope\" was not found")
                && error.contains("expected an executable"),
            "expected the command and the expected shape named | received {error}"
        );
        assert!(resolve_windows_program("npx", None, None, &on_disk(&[r"npx.cmd"])).is_err());
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
        // A full path to a real file resolves as written on every OS (on Windows the explicit
        // `.cmd` extension is tried as written first), so the control row stays launchable.
        let directory = crate::test_support::scratch_dir("mcp-stdio-launchable");
        let server = directory.join("server.cmd");
        std::fs::write(&server, "").expect("the control server file is written");
        let command = server.to_string_lossy().into_owned();
        let launch =
            stdio_launch(&row(Some(&command)), &secrets, &source).unwrap_or_else(|error| {
                panic!("expected the control row launchable | received {error}")
            });
        assert_eq!(launch.program, server);
        assert_eq!(launch.args, vec!["--flag".to_owned()]);
    }
}
