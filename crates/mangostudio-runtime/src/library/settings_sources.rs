//! `library.settings-sources`: the raw bytes of every settings and hook
//! source on this machine — `readSettingsSources` from
//! `apps/shared/src/library/machine/settings-sources.ts`.
//!
//! Only opening happens here; parsing, redaction and comparison are the
//! hub's. A missing file is `present: false` (an ordinary state, not a
//! failure); a file that exists but cannot be turned into text reports why
//! (`unreadable`, `not-regular-file`, `too-large`). A settings path is a
//! fixed vendor name, so a final-component symlink is refused rather than
//! followed (`O_NOFOLLOW` where the platform has it, as TypeScript does).

use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::Read;
use std::path::Path;

use serde::Serialize;

use super::js::{buffer_to_utf8_string, cmp_utf16};
use crate::probing::detection::agent_cli_definitions::AgentTargetId;
use crate::probing::detection::path_env::PathEnv;
use crate::probing::locations::{
    LocationDefinition, ResourceFormat, location_by_id, location_ids_for_target,
};

/// `MAX_SETTINGS_SOURCE_BYTES`, for one file or one rules directory's total.
const MAX_SETTINGS_SOURCE_BYTES: u64 = 512 * 1024;

/// `RuntimeSettingsReadFailure`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ReadFailure {
    Unreadable,
    NotRegularFile,
    TooLarge,
}

/// `RuntimeSettingsRuleFile`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct RuleFile {
    pub name: String,
    pub content: String,
}

/// `RuntimeSettingsSource`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Source {
    pub location_id: &'static str,
    pub present: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure_reason: Option<ReadFailure>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rules: Option<Vec<RuleFile>>,
}

impl Source {
    fn absent(location_id: &'static str) -> Self {
        Self {
            location_id,
            present: false,
            size_bytes: None,
            failure_reason: None,
            content: None,
            rules: None,
        }
    }

    fn failed(location_id: &'static str, reason: ReadFailure) -> Self {
        Self {
            present: true,
            failure_reason: Some(reason),
            ..Self::absent(location_id)
        }
    }
}

/// `RuntimeSettingsSourcesResult`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SettingsSources {
    pub home_dir: String,
    pub sources: Vec<Source>,
}

/// Every location a target reads settings or hooks from, in target then
/// registry order, deduplicated — `settingsSourceLocationIds`. Each
/// target's list already orders settings before hooks.
#[must_use]
pub(crate) fn settings_source_location_ids() -> Vec<&'static str> {
    let mut ids: Vec<&'static str> = Vec::new();
    for target in [
        AgentTargetId::Mangostudio,
        AgentTargetId::Claude,
        AgentTargetId::Codex,
        AgentTargetId::Cursor,
    ] {
        for id in location_ids_for_target(target) {
            let kind = location_by_id(id).map(|location| location.kind);
            if matches!(kind, Some("setting" | "hook")) && !ids.contains(id) {
                ids.push(id);
            }
        }
    }
    ids
}

/// `readSettingsSources`. Two locations naming one file read it once.
///
/// # Example
///
/// ```ignore
/// let sources = read_settings_sources(&env);
/// assert_eq!(sources.sources[0].location_id, "mango-settings");
/// ```
#[must_use]
pub(crate) fn read_settings_sources(env: &PathEnv) -> SettingsSources {
    let mut by_path: HashMap<String, Source> = HashMap::new();
    let sources = settings_source_location_ids()
        .into_iter()
        .map(|id| {
            let Some(location) = location_by_id(id) else {
                return Source::absent(id);
            };
            let Some(path) = (location.resolve_path)(env) else {
                return Source::absent(location.id);
            };
            if let Some(cached) = by_path.get(&path) {
                return Source {
                    location_id: location.id,
                    ..cached.clone()
                };
            }
            let source = read_source(location, &path);
            by_path.insert(path, source.clone());
            source
        })
        .collect();
    SettingsSources {
        home_dir: env.home_dir.clone(),
        sources,
    }
}

fn read_source(location: &LocationDefinition, path: &str) -> Source {
    if location.format == ResourceFormat::RulesDsl {
        return match read_rules_directory(Path::new(path)) {
            None => Source::absent(location.id),
            Some(Ok((rules, size_bytes))) => Source {
                present: true,
                size_bytes: Some(size_bytes),
                rules: Some(rules),
                ..Source::absent(location.id)
            },
            Some(Err(reason)) => Source::failed(location.id, reason),
        };
    }
    match read_bounded(Path::new(path)) {
        Ok((content, size_bytes)) => Source {
            present: true,
            size_bytes: Some(size_bytes),
            content: Some(content),
            ..Source::absent(location.id)
        },
        Err(None) => Source::absent(location.id),
        Err(Some(reason)) => Source::failed(location.id, reason),
    }
}

type RulesRead = Result<(Vec<RuleFile>, u64), ReadFailure>;

/// `None` is an absent directory; an empty existing one is `Ok(([], 0))`.
fn read_rules_directory(path: &Path) -> Option<RulesRead> {
    let entries = match std::fs::read_dir(path) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(error) if error.kind() == std::io::ErrorKind::NotADirectory => {
            return Some(Err(ReadFailure::NotRegularFile));
        }
        Err(_) => return Some(Err(ReadFailure::Unreadable)),
    };
    let mut files: Vec<(String, bool)> = Vec::new();
    for entry in entries {
        let Ok(entry) = entry else {
            return Some(Err(ReadFailure::Unreadable));
        };
        // `Dirent.isFile()` does not follow a symlink.
        let is_file = entry.file_type().is_ok_and(|kind| kind.is_file());
        files.push((entry.file_name().to_string_lossy().into_owned(), is_file));
    }
    files.sort_by(|(left, _), (right, _)| cmp_utf16(left, right));

    let mut rules = Vec::new();
    let mut size_bytes = 0u64;
    for (name, is_file) in files {
        if name.starts_with('.') || !is_file || !name.ends_with(".rules") {
            continue;
        }
        let (content, file_bytes) = match read_bounded(&path.join(&name)) {
            Ok(read) => read,
            // Unlinked between listing and open: skip it, the directory
            // itself still demonstrably exists.
            Err(None) => continue,
            Err(Some(_)) => return Some(Err(ReadFailure::Unreadable)),
        };
        size_bytes += file_bytes;
        if size_bytes > MAX_SETTINGS_SOURCE_BYTES {
            return Some(Err(ReadFailure::TooLarge));
        }
        rules.push(RuleFile { name, content });
    }
    Some(Ok((rules, size_bytes)))
}

/// `readBoundedUtf8` plus `classifyReadError`: `Err(None)` is "nothing
/// there", `Err(Some(reason))` a real failure.
fn read_bounded(path: &Path) -> Result<(String, u64), Option<ReadFailure>> {
    let file = open_no_follow(path).map_err(|error| classify(path, &error))?;
    let metadata = file.metadata().map_err(|_| Some(ReadFailure::Unreadable))?;
    if !metadata.is_file() {
        return Err(Some(ReadFailure::NotRegularFile));
    }
    if metadata.len() > MAX_SETTINGS_SOURCE_BYTES {
        return Err(Some(ReadFailure::TooLarge));
    }
    let mut bytes = Vec::with_capacity(usize::try_from(metadata.len()).unwrap_or(0));
    file.take(metadata.len())
        .read_to_end(&mut bytes)
        .map_err(|_| Some(ReadFailure::Unreadable))?;
    Ok((buffer_to_utf8_string(&bytes), metadata.len()))
}

fn open_no_follow(path: &Path) -> std::io::Result<std::fs::File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // Non-blocking as well, so a FIFO swapped in cannot wedge the worker
        // before the `fstat` check refuses it.
        options.custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK);
    }
    options.open(path)
}

fn classify(path: &Path, error: &std::io::Error) -> Option<ReadFailure> {
    if error.kind() == std::io::ErrorKind::NotFound {
        return None;
    }
    #[cfg(unix)]
    if matches!(
        error.raw_os_error(),
        Some(nix::libc::ELOOP | nix::libc::EISDIR)
    ) {
        return Some(ReadFailure::NotRegularFile);
    }
    // Windows refuses to open a directory at all (Node reports EISDIR).
    if cfg!(windows) && path.is_dir() {
        return Some(ReadFailure::NotRegularFile);
    }
    Some(ReadFailure::Unreadable)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env_at(home: &Path) -> PathEnv {
        PathEnv {
            platform: crate::health::node_platform().to_string(),
            home_dir: home.to_string_lossy().into_owned(),
            env: HashMap::new(),
        }
    }

    fn source<'a>(sources: &'a SettingsSources, id: &str) -> &'a Source {
        sources
            .sources
            .iter()
            .find(|source| source.location_id == id)
            .unwrap()
    }

    /// `settings-sources-locations.test.ts`: a missing rules directory is
    /// absent, an existing empty one is present with no rules.
    #[test]
    fn a_rules_directory_is_absent_until_it_exists_then_present_even_empty() {
        let home = crate::test_support::scratch_dir("library-rules-dir");
        let absent = read_settings_sources(&env_at(&home));
        assert!(!source(&absent, "codex-permission-rules").present);
        std::fs::create_dir_all(home.join(".codex/rules")).unwrap();
        let empty = read_settings_sources(&env_at(&home));
        let rules = source(&empty, "codex-permission-rules");
        assert_eq!(
            (rules.present, rules.rules.as_deref()),
            (true, Some(&[][..])),
            "expected present with an empty rule list | received {rules:?}"
        );
    }

    /// `settings-sources.test.ts` "refuses a settings path that is a
    /// symlink": a fixed vendor path pointing elsewhere is not followed.
    #[cfg(unix)]
    #[test]
    fn a_settings_path_that_is_a_symlink_is_refused() {
        let home = crate::test_support::scratch_dir("library-settings-symlink");
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        std::fs::write(home.join("elsewhere.json"), "{\"secret\": true}").unwrap();
        std::os::unix::fs::symlink(
            home.join("elsewhere.json"),
            home.join(".claude/settings.json"),
        )
        .unwrap();
        let sources = read_settings_sources(&env_at(&home));
        let settings = source(&sources, "claude-settings");
        assert_eq!(settings.failure_reason, Some(ReadFailure::NotRegularFile));
        assert_eq!(
            settings.content, None,
            "the symlink target must never be read"
        );
    }

    #[test]
    fn source_locations_follow_target_order_settings_before_hooks() {
        assert_eq!(
            settings_source_location_ids(),
            [
                "mango-settings",
                "claude-settings",
                "claude-hooks",
                "codex-settings",
                "codex-hooks",
                "codex-permission-rules",
                "cursor-settings",
            ]
        );
    }
}
