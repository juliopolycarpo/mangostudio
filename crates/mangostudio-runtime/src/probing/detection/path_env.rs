//! Injectable platform inputs, mirroring
//! `apps/shared/src/runtime-env/path-env.ts`'s `PathEnv`, plus the
//! platform-parameterized path joining every detector needs.
//!
//! # Why this crate cannot use [`std::path::Path`]
//!
//! Every TypeScript detector this module ports picks `node:path`'s `posix`
//! or `win32` API by `deps.platform`, not by the host this process actually
//! runs on — a Linux CI host still has to reproduce win32 path joining to
//! test the win32 branches ([`crate::probing::detection::runtime_definitions`]'s
//! well-known Windows directories, [`crate::probing::detection::fnm`]'s
//! `FNM_DIR` layout). [`std::path::Path`] always joins with the *compiling*
//! platform's separator, so it cannot stand in here. [`join_path`] and
//! [`dirname_path`] below are a deliberately small hand-rolled replacement:
//! they join and split on separators, collapsing a redundant duplicate
//! (`/usr/bin` and `/usr/bin/` both join to `/usr/bin/node`, which
//! `crate::probing::detection::binary_scan`'s own candidate dedup relies
//! on), but they do **not** resolve `.`/`..` segments the way
//! `path.normalize` does — no path this port joins ever contains one.

use std::collections::HashMap;

/// Injectable platform inputs for resolving user-owned runtime and library
/// paths — this crate's mirror of `PathEnv`.
#[derive(Debug, Clone, Default)]
pub struct PathEnv {
    /// `process.platform`'s value: `"win32"`, `"darwin"`, `"linux"`, …
    pub platform: String,
    /// The current user's home directory.
    pub home_dir: String,
    /// Environment variables this detection layer reads. Keys are exact
    /// (`PATH`, `ProgramFiles(x86)`, `APPDATA`, …) — unlike Node on
    /// Windows, this map is never case-folded; a host adapter that reads
    /// `std::env::var` on a platform with case-insensitive variable names
    /// is responsible for populating the exact keys this module expects.
    pub env: HashMap<String, String>,
}

impl PathEnv {
    /// `self.env.get(key)`, as a borrowed `&str` — the common case every
    /// detector needs, without repeating the `Option<&String>` shape.
    #[must_use]
    pub fn env_var(&self, key: &str) -> Option<&str> {
        self.env.get(key).map(String::as_str)
    }

    /// [`PathEnv::env_var`] trimmed, or `None` when it is unset or blank —
    /// how every detector reads a variable that names a directory
    /// (`NVM_DIR`, `FNM_DIR`, `APPDATA`, …), since an exported-but-empty
    /// value means "not configured", not "the current directory".
    ///
    /// # Example
    ///
    /// ```
    /// use mangostudio_runtime::probing::detection::path_env::PathEnv;
    ///
    /// let mut env = PathEnv::default();
    /// env.env.insert("NVM_DIR".into(), "  /opt/nvm ".into());
    /// env.env.insert("FNM_DIR".into(), "   ".into());
    /// assert_eq!(env.non_blank_var("NVM_DIR"), Some("/opt/nvm"));
    /// assert_eq!(env.non_blank_var("FNM_DIR"), None);
    /// ```
    #[must_use]
    pub fn non_blank_var(&self, key: &str) -> Option<&str> {
        self.env_var(key)
            .map(str::trim)
            .filter(|value| !value.is_empty())
    }

    /// Whether this environment describes a win32 host.
    #[must_use]
    pub fn is_windows(&self) -> bool {
        self.platform == "win32"
    }

    /// The separator between `PATH` entries on [`PathEnv::platform`] — `;`
    /// on win32, `:` everywhere else — decided by the described platform,
    /// never by the host this process runs on.
    ///
    /// # Example
    ///
    /// ```
    /// use mangostudio_runtime::probing::detection::path_env::PathEnv;
    ///
    /// let env = PathEnv { platform: "win32".into(), ..PathEnv::default() };
    /// assert_eq!(env.path_list_separator(), ";");
    /// ```
    #[must_use]
    pub fn path_list_separator(&self) -> &'static str {
        if self.is_windows() { ";" } else { ":" }
    }
}

/// The path separator [`join_path`] and [`dirname_path`] use for `platform`.
#[must_use]
pub fn separator(platform: &str) -> char {
    if platform == "win32" { '\\' } else { '/' }
}

/// The characters [`join_path`] and [`dirname_path`] treat as separators
/// when *reading* a path for `platform`. win32 accepts either slash as
/// input (mirroring `path.win32`, which normalizes a forward slash to a
/// backslash); POSIX accepts only `/` — a backslash is a legal POSIX
/// filename character, so treating it as a separator there would be wrong.
fn separator_chars(platform: &str) -> &'static [char] {
    if platform == "win32" {
        &['/', '\\']
    } else {
        &['/']
    }
}

/// Joins path segments the way `node:path`'s `posix.join`/`win32.join` do
/// for `platform`, regardless of which platform this process actually runs
/// on. See the module docs for what this does not attempt to reproduce.
///
/// # Example
///
/// ```
/// use mangostudio_runtime::probing::detection::path_env::join_path;
///
/// assert_eq!(join_path("linux", &["/usr/bin/", "node"]), "/usr/bin/node");
/// assert_eq!(join_path("linux", &["/usr/bin", "node"]), "/usr/bin/node");
/// assert_eq!(join_path("win32", &["C:\\Program Files", "nodejs"]), "C:\\Program Files\\nodejs");
/// ```
#[must_use]
pub fn join_path(platform: &str, parts: &[&str]) -> String {
    let sep = separator(platform);
    let seps = separator_chars(platform);
    let mut segments: Vec<&str> = Vec::new();
    let mut prefix = String::new();
    let mut seen_first = false;

    for part in parts {
        if part.is_empty() {
            continue;
        }
        let scan = if seen_first {
            *part
        } else {
            seen_first = true;
            let (leading, remainder) = leading_prefix(platform, seps, part);
            prefix = leading;
            remainder
        };
        segments.extend(scan.split(seps).filter(|segment| !segment.is_empty()));
    }

    let joined: Vec<&str> = segments;
    format!("{prefix}{}", joined.join(&sep.to_string()))
}

/// Splits an absolute-path prefix (a POSIX/win32 leading separator, or a
/// win32 drive letter like `C:`) off the first non-empty part, so the
/// remainder can be split into ordinary segments the same way every later
/// part is — this is what lets an embedded `/` inside a win32 root
/// (`C:/Users/x`) still normalize to `\` like the rest of the join.
fn leading_prefix<'a>(platform: &str, seps: &[char], part: &'a str) -> (String, &'a str) {
    if platform == "win32" {
        let bytes = part.as_bytes();
        if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
            let after_colon = &part[2..];
            let remainder = after_colon.strip_prefix(seps).unwrap_or(after_colon);
            return (format!("{}{}", &part[..2], separator(platform)), remainder);
        }
    }
    if let Some(remainder) = part.strip_prefix(seps) {
        return (separator(platform).to_string(), remainder);
    }
    (String::new(), part)
}

/// The parent directory of `path`, the way `node:path`'s
/// `posix.dirname`/`win32.dirname` compute it for `platform`.
///
/// # Example
///
/// ```
/// use mangostudio_runtime::probing::detection::path_env::dirname_path;
///
/// assert_eq!(dirname_path("win32", "C:\\Program Files\\nodejs\\node.exe"), "C:\\Program Files\\nodejs");
/// assert_eq!(dirname_path("linux", "/usr/bin/node"), "/usr/bin");
/// ```
#[must_use]
pub fn dirname_path(platform: &str, path: &str) -> String {
    let seps = separator_chars(platform);
    match path.rfind(seps) {
        Some(0) => path[..=0].to_string(),
        Some(index) => path[..index].to_string(),
        None => ".".to_string(),
    }
}

/// `path`, with `.`/`..` segments and duplicate separators resolved the way
/// `node:path`'s `posix.normalize`/`win32.normalize` resolve them for
/// `platform` — including their one surprising rule: a trailing separator
/// survives (`/a/b/../c/` normalizes to `/a/c/`).
///
/// [`join_path`] deliberately never does this (no path a detector joins
/// carries a `.` segment); this exists for the one place a *user-supplied*
/// path enters resolution, `registry.ts`'s `resolveEnvPath`, where the
/// TypeScript host normalizes and this crate therefore has to as well.
///
/// # Example
///
/// ```
/// use mangostudio_runtime::probing::detection::path_env::normalize_path;
///
/// assert_eq!(normalize_path("linux", "/a/b/../c/"), "/a/c/");
/// assert_eq!(normalize_path("win32", "D:/a/../b/"), "D:\\b\\");
/// ```
#[must_use]
pub fn normalize_path(platform: &str, path: &str) -> String {
    let sep = separator(platform);
    let seps = separator_chars(platform);
    let (prefix, rooted, rest) = split_root(platform, seps, path);
    let mut segments: Vec<&str> = Vec::new();
    for segment in rest.split(seps) {
        match segment {
            "" | "." => {}
            ".." if segments.last().is_some_and(|last| *last != "..") => {
                segments.pop();
            }
            ".." if rooted => {}
            other => segments.push(other),
        }
    }
    let mut normalized = prefix;
    if rooted {
        normalized.push(sep);
    }
    normalized.push_str(&segments.join(&sep.to_string()));
    if segments.is_empty() {
        if normalized.is_empty() {
            normalized.push('.');
        }
        return normalized;
    }
    if path.ends_with(seps) {
        normalized.push(sep);
    }
    normalized
}

/// `value` resolved against `base` the way `registry.ts`'s `resolveEnvPath`
/// does: an absolute `value` is [`normalize_path`]d, a relative one is
/// resolved onto `base` (`posix.resolve`/`win32.resolve`), which — unlike
/// normalize — never keeps a trailing separator.
///
/// # Example
///
/// ```
/// use mangostudio_runtime::probing::detection::path_env::resolve_path;
///
/// assert_eq!(resolve_path("linux", "/home/u", "./skills/"), "/home/u/skills");
/// assert_eq!(resolve_path("linux", "/home/u", "/a/b/../c/"), "/a/c/");
/// ```
#[must_use]
pub fn resolve_path(platform: &str, base: &str, value: &str) -> String {
    if is_absolute(platform, value) {
        return normalize_path(platform, value);
    }
    let joined = format!("{base}{}{value}", separator(platform));
    let normalized = normalize_path(platform, &joined);
    let root_len = root_length(platform, &normalized);
    let trimmed = normalized.trim_end_matches(separator_chars(platform));
    if trimmed.len() < root_len {
        return normalized[..root_len].to_string();
    }
    trimmed.to_string()
}

/// Whether `value` is absolute for `platform`, the way
/// `path.posix.isAbsolute`/`path.win32.isAbsolute` answer: a leading
/// separator, or (win32 only) a drive letter followed by a separator.
#[must_use]
pub fn is_absolute(platform: &str, value: &str) -> bool {
    let seps = separator_chars(platform);
    if value.starts_with(seps) {
        return true;
    }
    if platform != "win32" {
        return false;
    }
    let bytes = value.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'/' || bytes[2] == b'\\')
}

/// Splits `path` into its root prefix (a win32 drive or UNC share, emitted
/// with `platform`'s separator), whether that root is followed by a
/// separator, and the remainder to normalize.
fn split_root<'a>(platform: &str, seps: &[char], path: &'a str) -> (String, bool, &'a str) {
    if platform == "win32" {
        let bytes = path.as_bytes();
        if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
            let rest = &path[2..];
            let rooted = rest.starts_with(seps);
            return (path[..2].to_string(), rooted, rest);
        }
        if let Some((share, rest)) = unc_share(seps, path) {
            return (share, true, rest);
        }
    }
    let rooted = path.starts_with(seps);
    (String::new(), rooted, path)
}

/// `\\server\share` and the remainder after it, when `path` is a UNC path.
fn unc_share<'a>(seps: &[char], path: &'a str) -> Option<(String, &'a str)> {
    let without = path.strip_prefix(seps)?.strip_prefix(seps)?;
    let mut parts = without.splitn(3, seps);
    let server = parts.next().filter(|part| !part.is_empty())?;
    let share = parts.next().filter(|part| !part.is_empty())?;
    let rest = &without[server.len() + 1 + share.len()..];
    Some((format!("\\\\{server}\\{share}"), rest))
}

/// Byte length of `normalized`'s root (`/`, `C:\`, `\\server\share\`), so
/// trimming a trailing separator never eats the root itself.
fn root_length(platform: &str, normalized: &str) -> usize {
    let seps = separator_chars(platform);
    let (prefix, rooted, _) = split_root(platform, seps, normalized);
    prefix.len() + usize::from(rooted)
}

#[cfg(test)]
mod tests {
    use super::{PathEnv, dirname_path, join_path, normalize_path, resolve_path};

    /// Every expected value below is what `bun -e` printed for
    /// `isAbsolute(v) ? normalize(v) : resolve(home, v)` from `node:path`.
    #[test]
    fn resolve_path_matches_node_for_the_registry_override_corpus() {
        let cases = [
            ("linux", "/home/u", "./skills/", "/home/u/skills"),
            ("linux", "/home/u", "/a/b/../c/", "/a/c/"),
            ("linux", "/home/u", "skills", "/home/u/skills"),
            ("linux", "/home/u", "../x", "/home/x"),
            ("linux", "/home/u", "/a//b/./c", "/a/b/c"),
            ("linux", "/home/u", "/../a", "/a"),
            ("linux", "/home/u", "/", "/"),
            ("linux", "/home/u", "a/../..", "/home"),
            ("win32", "C:\\Users\\u", "D:/a/../b/", "D:\\b\\"),
            (
                "win32",
                "C:\\Users\\u",
                "skills\\x",
                "C:\\Users\\u\\skills\\x",
            ),
            ("win32", "C:\\Users\\u", "..\\x", "C:\\Users\\x"),
            (
                "win32",
                "C:\\Users\\u",
                "\\\\srv\\share\\a\\..\\b",
                "\\\\srv\\share\\b",
            ),
            ("win32", "C:\\Users\\u", "C:\\", "C:\\"),
            ("win32", "C:\\Users\\u", "\\foo", "\\foo"),
            ("win32", "C:\\Users\\u", "c:/A//b", "c:\\A\\b"),
        ];
        for (platform, home, value, expected) in cases {
            let received = resolve_path(platform, home, value);
            assert_eq!(
                received, expected,
                "resolve_path({platform}, {home:?}, {value:?}): expected {expected:?} | received {received:?}"
            );
        }
    }

    #[test]
    fn normalize_path_keeps_relative_leading_parent_segments() {
        assert_eq!(normalize_path("linux", "a/../../b"), "../b");
        assert_eq!(normalize_path("linux", ""), ".");
        assert_eq!(normalize_path("linux", "./"), ".");
    }

    #[test]
    fn env_var_reads_an_exact_case_sensitive_key() {
        let mut env = PathEnv::default();
        env.env.insert("PATH".to_string(), "/usr/bin".to_string());
        assert_eq!(env.env_var("PATH"), Some("/usr/bin"));
        assert_eq!(env.env_var("path"), None);
    }

    #[test]
    fn non_blank_var_trims_and_treats_blank_as_unset() {
        let mut env = PathEnv::default();
        env.env
            .insert("NVM_DIR".to_string(), " /opt/nvm\n".to_string());
        env.env.insert("FNM_DIR".to_string(), " \t ".to_string());
        assert_eq!(env.non_blank_var("NVM_DIR"), Some("/opt/nvm"));
        assert_eq!(env.non_blank_var("FNM_DIR"), None);
        assert_eq!(env.non_blank_var("MISSING"), None);
    }

    #[test]
    fn path_list_separator_follows_the_described_platform() {
        let mut env = PathEnv {
            platform: "win32".to_string(),
            ..PathEnv::default()
        };
        assert_eq!(env.path_list_separator(), ";");
        env.platform = "darwin".to_string();
        assert_eq!(env.path_list_separator(), ":");
    }

    #[test]
    fn join_path_collapses_a_redundant_trailing_separator() {
        assert_eq!(join_path("linux", &["/usr/bin/", "node"]), "/usr/bin/node");
        assert_eq!(join_path("linux", &["/usr/bin", "node"]), "/usr/bin/node");
    }

    #[test]
    fn join_path_accepts_either_slash_on_win32_but_emits_backslash() {
        assert_eq!(
            join_path("win32", &["C:/Users/x", "AppData/Roaming", "fnm"]),
            "C:\\Users\\x\\AppData\\Roaming\\fnm"
        );
    }

    #[test]
    fn join_path_never_treats_a_backslash_as_a_posix_separator() {
        // A literal backslash in a POSIX filename is not a path separator.
        assert_eq!(join_path("linux", &["/a", "b\\c"]), "/a/b\\c");
    }

    #[test]
    fn dirname_path_keeps_a_single_char_root() {
        assert_eq!(dirname_path("linux", "/node"), "/");
    }

    #[test]
    fn dirname_path_matches_win32_and_posix_examples() {
        assert_eq!(
            dirname_path("win32", "C:\\Program Files\\nodejs\\node.exe"),
            "C:\\Program Files\\nodejs"
        );
        assert_eq!(dirname_path("linux", "/usr/bin/node"), "/usr/bin");
    }
}
