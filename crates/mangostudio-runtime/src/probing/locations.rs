//! The `locations` array `probing.agent-clis` reports for each of the four
//! agent-CLI targets, ported deliberately narrowly from
//! `apps/shared/src/library/` — not a port of the library method group.
//!
//! # Exact scope of this carve-out
//!
//! Ported:
//! - `apps/shared/src/library/location-probe.ts`'s `describeLocation`/
//!   `describeTargetLocations`, as [`describe_location`]/
//!   [`describe_target_locations`].
//! - `apps/shared/src/library/fs-probe.ts`'s `nearestExistingWritable`, as
//!   [`nearest_existing_writable`].
//! - The 24 [`LocationDefinition`] rows from
//!   `apps/shared/src/library/registry.ts`'s `LIBRARY_LOCATION_DEFINITIONS`
//!   that the four agent-CLI targets (`mangostudio`, `claude`, `codex`,
//!   `cursor`) actually read — which turns out to be all of them, since
//!   every location in that table is read by at least one of exactly these
//!   four targets (there is no fifth target in this repository yet whose
//!   locations this crate would have reason to skip).
//! - The per-target ordered, deduplicated location-id lists
//!   `listLibraryTargetLocationIds` computes from `TargetDefinition.reads` —
//!   hardcoded here as [`location_ids_for_target`] rather than re-deriving
//!   them from a ported `reads` map, since the four lists are themselves
//!   the whole fact this crate needs and never change independently of the
//!   table above.
//! - `claudeConfigHome`/`codexConfigHome`/`cursorConfigHome` (plus
//!   `mangoConfigHome`, `apps/runtime`'s wire calls
//!   `TargetDefinition.resolveConfigHome` for `mangostudio`'s own
//!   `describeSelfAgent`), as [`claude_config_home`]/[`codex_config_home`]/
//!   [`cursor_config_home`]/[`mango_config_home`].
//!
//! Deliberately **not** ported: `resourceSlug`/`format` (resource-writer
//! concerns, never read by a location *status*), `TargetDefinition.reads`
//! as a general data structure (collapsed into the four fixed lists above),
//! `resourceEntryName`, `assertLibraryRegistryConsistency`, and everything
//! in `apps/shared/src/library/schemas.ts`/`machine/` — settings read/
//! write/merge/conflict-resolution, which is a whole method group
//! (`library.*`) this plan does not add. If a later location needs more of
//! that machinery to answer truthfully, it belongs there, not bolted onto
//! this module.

use serde::Serialize;

use super::detection::agent_cli_definitions::AgentTargetId;
use super::detection::path_env::{PathEnv, dirname_path, join_path};

/// How a [`LocationDefinition`]'s path is organised on disk — decides
/// whether [`describe_location`] even attempts an entry count.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocationLayout {
    /// A directory whose entries are themselves directories (e.g. a skill
    /// per subdirectory).
    DirectoryOfDirs,
    /// A directory whose entries are files (e.g. one command per file).
    DirectoryOfFiles,
    /// A single file; never entry-counted.
    SingleFile,
}

/// The filesystem seam [`describe_location`] needs, mirroring
/// `apps/shared/src/library/location-probe.ts`'s `LocationFsProbe`
/// interface (`FsProbe` plus `isReadable`/`countEntries`). Synchronous,
/// like [`super::detection::auth_signal::AuthSignalFs`] — a real
/// implementation is bare `std::fs`/`nix::unistd::access` wrapped in one
/// [`crate::blocking::run_blocking`] call per whole listing, not per
/// method; see `crate::probing::host`'s own module docs for why.
pub trait LocationFsProbe: Send + Sync {
    /// Whether `path` exists on disk.
    fn exists(&self, path: &str) -> bool;
    /// Whether this process can write to `path`.
    fn is_writable(&self, path: &str) -> bool;
    /// Whether this process can read `path`.
    fn is_readable(&self, path: &str) -> bool;
    /// Counts `path`'s entries, filtered per `layout` — mirrors
    /// `NODE_LOCATION_FS_PROBE.countEntries`: a dot-prefixed name is never
    /// counted (it can never be a resource slug), a symlink is always
    /// counted (its target's own type is not re-checked), and everything
    /// else is counted only when its own type matches `layout`. `None`
    /// when `path` cannot be listed at all — mirrors `describeLocation`'s
    /// own `safeEntryCount` catch, which reports no count rather than
    /// failing the whole status.
    fn count_entries(&self, path: &str, layout: LocationLayout) -> Option<usize>;
}

/// One resource location this crate can report a status for. A `const`
/// table entry, mirroring one row of
/// `apps/shared/src/library/registry.ts`'s `LIBRARY_LOCATION_DEFINITIONS`
/// — see this module's own docs for exactly which fields of that row
/// survive the port (`format`/`resourceSlug` do not, since neither is read
/// by a location status).
#[derive(Debug, Clone, Copy)]
pub struct LocationDefinition {
    /// The wire `LibraryLocationId`, e.g. `"claude-skills"`.
    pub id: &'static str,
    /// The wire `ResourceKind`: `"skill"`, `"subagent"`, `"command"`,
    /// `"instruction"`, `"setting"`, or `"hook"`.
    pub kind: &'static str,
    /// The wire `LibraryScope`. Always `"home"` — every location this
    /// repository defines today is home-scoped; a workspace location is a
    /// new row here, not a signature change (mirrors `registry.ts`'s own
    /// comment on `TargetDefinition.reads`).
    pub scope: &'static str,
    /// Resolves this location's path for `env`, or `None` when it cannot
    /// exist there (an unsupported platform, or a variant gated to one
    /// platform only).
    pub resolve_path: fn(&PathEnv) -> Option<String>,
    /// The wire `LocationAccess`: `"read-write"` or `"read-only"`.
    pub access: &'static str,
    /// This location's on-disk shape.
    pub layout: LocationLayout,
    /// Every agent-CLI target that reads this location.
    pub read_by: &'static [AgentTargetId],
}

/// One [`LocationDefinition`], resolved against a real `env` and probed
/// through `fs` — the wire `LibraryLocationStatus` shape [`probing.agent-clis`'s
/// catalog schema declares for each entry of a status's `locations` array.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocationStatus {
    /// This location's id.
    pub id: &'static str,
    /// This location's kind.
    pub kind: &'static str,
    /// This location's scope.
    pub scope: &'static str,
    /// This location's resolved path, or `None` when it cannot exist on
    /// this host.
    pub path: Option<String>,
    /// This location's access mode.
    pub access: &'static str,
    /// Whether `path` exists.
    pub exists: bool,
    /// Whether this process can read `path`.
    pub readable: bool,
    /// Whether this process can write `path` — or, when `path` does not
    /// exist yet, whether it *could* be created (the nearest existing
    /// ancestor is writable).
    pub writable: bool,
    /// Every agent-CLI target that reads this location.
    pub target_ids: Vec<AgentTargetId>,
    /// This location's entry count, when it is a directory this process
    /// could list. `None` for a `single-file` location, a location that
    /// does not exist or is not readable, or one whose listing failed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entry_count: Option<u32>,
}

/// Whether a not-yet-created `path` could be made: walks up to the nearest
/// existing ancestor and checks that it is writable. Mirrors
/// `apps/shared/src/library/fs-probe.ts`'s `nearestExistingWritable`
/// exactly, reusing [`dirname_path`] rather than a second path-splitting
/// routine.
#[must_use]
pub fn nearest_existing_writable(path: &str, platform: &str, fs: &dyn LocationFsProbe) -> bool {
    let mut current = dirname_path(platform, path);
    while !fs.exists(&current) {
        let parent = dirname_path(platform, &current);
        if parent == current {
            return false;
        }
        current = parent;
    }
    fs.is_writable(&current)
}

/// Counts `path`'s entries per `layout`, reporting `None` rather than
/// propagating a listing failure — mirrors `describeLocation`'s own
/// `safeEntryCount`.
fn entry_count(fs: &dyn LocationFsProbe, path: &str, layout: LocationLayout) -> Option<u32> {
    // A directory listing in the billions is not a real case this wire
    // field needs to represent exactly; saturating rather than panicking
    // keeps a pathological directory from failing an otherwise-successful
    // status.
    fs.count_entries(path, layout)
        .map(|count| u32::try_from(count).unwrap_or(u32::MAX))
}

/// Resolves and probes one [`LocationDefinition`], mirroring
/// `describeLocation` exactly: a location whose path cannot exist on this
/// host reports every boolean `false` and `path: null`; otherwise
/// existence, readability and (for a directory layout) an entry count are
/// probed, and writability falls back to [`nearest_existing_writable`]
/// when the path does not exist yet.
#[must_use]
pub fn describe_location(
    definition: &LocationDefinition,
    env: &PathEnv,
    fs: &dyn LocationFsProbe,
) -> LocationStatus {
    let target_ids = definition.read_by.to_vec();
    let Some(path) = (definition.resolve_path)(env) else {
        return LocationStatus {
            id: definition.id,
            kind: definition.kind,
            scope: definition.scope,
            path: None,
            access: definition.access,
            exists: false,
            readable: false,
            writable: false,
            target_ids,
            entry_count: None,
        };
    };

    let exists = fs.exists(&path);
    let readable = exists && fs.is_readable(&path);
    let writable = if exists {
        fs.is_writable(&path)
    } else {
        nearest_existing_writable(&path, &env.platform, fs)
    };
    let entry_count = if exists && readable && definition.layout != LocationLayout::SingleFile {
        entry_count(fs, &path, definition.layout)
    } else {
        None
    };

    LocationStatus {
        id: definition.id,
        kind: definition.kind,
        scope: definition.scope,
        path: Some(path),
        access: definition.access,
        exists,
        readable,
        writable,
        target_ids,
        entry_count,
    }
}

/// Every [`LocationStatus`] `target` reads, in
/// [`location_ids_for_target`]'s order. Mirrors
/// `describeTargetLocations`.
#[must_use]
pub fn describe_target_locations(
    target: AgentTargetId,
    env: &PathEnv,
    fs: &dyn LocationFsProbe,
) -> Vec<LocationStatus> {
    location_ids_for_target(target)
        .iter()
        .filter_map(|id| location_by_id(id))
        .map(|definition| describe_location(definition, env, fs))
        .collect()
}

/// Looks up one [`LocationDefinition`] by id.
#[must_use]
pub fn location_by_id(id: &str) -> Option<&'static LocationDefinition> {
    LOCATION_DEFINITIONS
        .iter()
        .find(|location| location.id == id)
}

/// The ordered, deduplicated location ids `target` reads — this crate's
/// hardcoded mirror of `listLibraryTargetLocationIds`, which computes the
/// same list by flattening `TargetDefinition.reads` (in `skill`,
/// `subagent`, `command`, `instruction`, `setting`, `hook` order) and
/// deduplicating. Hardcoded rather than re-derived because these four
/// lists — not a general `reads` map — are the whole fact this crate needs,
/// and they only change when `registry.ts`'s own table does, at which
/// point this list needs updating right alongside it regardless of how it
/// is expressed.
#[must_use]
pub fn location_ids_for_target(target: AgentTargetId) -> &'static [&'static str] {
    match target {
        AgentTargetId::Mangostudio => &[
            "mango-skills",
            "agents-skills",
            "claude-skills",
            "mango-agents",
            "mango-instructions",
            "mango-settings",
        ],
        AgentTargetId::Claude => &[
            "claude-skills",
            "claude-agents",
            "claude-commands",
            "claude-instructions",
            "claude-settings",
            "claude-hooks",
        ],
        AgentTargetId::Codex => &[
            "codex-skills",
            "agents-skills",
            "codex-agents",
            "codex-prompts",
            "codex-instructions",
            "codex-settings",
            "codex-hooks",
            "codex-permission-rules",
        ],
        AgentTargetId::Cursor => &[
            "cursor-skills",
            "cursor-skills-builtin",
            "cursor-agents",
            "cursor-commands",
            "cursor-rules",
            "cursor-settings",
        ],
    }
}

// --- Path resolution -------------------------------------------------
//
// Mirrors `registry.ts`'s own small resolver combinators
// (`homePath`/`configuredDir`/`claudePath`/`codexPath`/`cursorConfigHome`/…)
// as named functions rather than closures capturing `...parts`, since Rust
// has no ergonomic equivalent of that spread for a `fn` pointer — the
// per-location wrapper functions further below are what stay this thin.

/// Whether `env` describes a platform this crate resolves a home-scoped
/// location on at all. Mirrors `registry.ts`'s `supportsHomeLocations`.
fn supports_home_locations(env: &PathEnv) -> bool {
    matches!(env.platform.as_str(), "linux" | "darwin" | "win32")
}

/// Whether `value` is an absolute path for `platform`, mirroring
/// `path.posix.isAbsolute`/`path.win32.isAbsolute` closely enough for this
/// module's own needs (a leading separator on POSIX; a leading separator
/// or a drive letter on win32) — see [`super::detection::path_env`]'s own
/// module docs for why this crate cannot use [`std::path::Path`] for this.
fn is_absolute_path(platform: &str, value: &str) -> bool {
    if platform == "win32" {
        let bytes = value.as_bytes();
        (!bytes.is_empty() && (bytes[0] == b'/' || bytes[0] == b'\\'))
            || (bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':')
    } else {
        value.starts_with('/')
    }
}

/// `value`, resolved against `home_dir` for `platform` — mirrors
/// `registry.ts`'s `resolveEnvPath`. An absolute `value` is returned as
/// given (this crate's [`super::detection::path_env`] module does not
/// resolve `.`/`..` segments anywhere else either, so neither does this);
/// a relative one is joined onto `home_dir`.
fn resolve_env_path(platform: &str, home_dir: &str, value: &str) -> String {
    if is_absolute_path(platform, value) {
        value.to_string()
    } else {
        join_path(platform, &[home_dir, value])
    }
}

/// `env.env[variable]`, resolved as an absolute-or-relative-to-home
/// override when set and non-blank; `home_dir/fallback_parts` otherwise.
/// Mirrors `registry.ts`'s `configuredDir`.
fn configured_dir(env: &PathEnv, variable: &str, fallback_parts: &[&str]) -> String {
    match env
        .env_var(variable)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(configured) => resolve_env_path(&env.platform, &env.home_dir, configured),
        None => {
            let mut parts = vec![env.home_dir.as_str()];
            parts.extend_from_slice(fallback_parts);
            join_path(&env.platform, &parts)
        }
    }
}

/// `home_dir/parts`, or `None` on a platform with no home-scoped
/// locations. Mirrors `registry.ts`'s `homePath`.
fn home_path(env: &PathEnv, parts: &[&str]) -> Option<String> {
    if !supports_home_locations(env) {
        return None;
    }
    let mut all = vec![env.home_dir.as_str()];
    all.extend_from_slice(parts);
    Some(join_path(&env.platform, &all))
}

/// `<home>/.mango`, unconditionally — MangoStudio's own config home always
/// resolves, on every platform this crate runs on. Mirrors
/// `registry.ts`'s `mangoConfigHome`.
#[must_use]
pub fn mango_config_home(env: &PathEnv) -> String {
    join_path(&env.platform, &[&env.home_dir, ".mango"])
}

fn mango_skills_path(env: &PathEnv) -> Option<String> {
    if !supports_home_locations(env) {
        return None;
    }
    Some(configured_dir(env, "SKILLS_DIR", &[".mango", "skills"]))
}

fn mango_agents_path(env: &PathEnv) -> Option<String> {
    if !supports_home_locations(env) {
        return None;
    }
    Some(configured_dir(env, "AGENTS_DIR", &[".mango", "agents"]))
}

fn agents_skills_path(env: &PathEnv) -> Option<String> {
    home_path(env, &[".agents", "skills"])
}

fn mango_instructions_path(env: &PathEnv) -> Option<String> {
    home_path(env, &[".mango", "AGENTS.md"])
}

fn mango_settings_path(env: &PathEnv) -> Option<String> {
    home_path(env, &[".mango", "config.toml"])
}

/// Claude's config home, honouring `CLAUDE_CONFIG_DIR`. Mirrors
/// `registry.ts`'s `claudeConfigHome`.
#[must_use]
pub fn claude_config_home(env: &PathEnv) -> String {
    configured_dir(env, "CLAUDE_CONFIG_DIR", &[".claude"])
}

fn claude_path(env: &PathEnv, parts: &[&str]) -> Option<String> {
    if !supports_home_locations(env) {
        return None;
    }
    let home = claude_config_home(env);
    let mut all = vec![home.as_str()];
    all.extend_from_slice(parts);
    Some(join_path(&env.platform, &all))
}

fn claude_skills_path(env: &PathEnv) -> Option<String> {
    claude_path(env, &["skills"])
}

fn claude_agents_path(env: &PathEnv) -> Option<String> {
    claude_path(env, &["agents"])
}

fn claude_commands_path(env: &PathEnv) -> Option<String> {
    claude_path(env, &["commands"])
}

fn claude_instructions_path(env: &PathEnv) -> Option<String> {
    claude_path(env, &["CLAUDE.md"])
}

fn claude_settings_path(env: &PathEnv) -> Option<String> {
    claude_path(env, &["settings.json"])
}

fn claude_hooks_path(env: &PathEnv) -> Option<String> {
    // Claude has no separate hooks file; its hooks live in the same
    // `settings.json` the `claude-settings` location also reads — mirrors
    // `registry.ts`'s own `claude-hooks` row exactly.
    claude_path(env, &["settings.json"])
}

/// Codex's config home, honouring `CODEX_HOME`. Mirrors `registry.ts`'s
/// `codexConfigHome`.
#[must_use]
pub fn codex_config_home(env: &PathEnv) -> String {
    configured_dir(env, "CODEX_HOME", &[".codex"])
}

fn codex_path(env: &PathEnv, parts: &[&str]) -> Option<String> {
    if !supports_home_locations(env) {
        return None;
    }
    let home = codex_config_home(env);
    let mut all = vec![home.as_str()];
    all.extend_from_slice(parts);
    Some(join_path(&env.platform, &all))
}

/// `codex_path`, gated to Linux only — mirrors `registry.ts`'s
/// `codexLinuxOnlyPath`: Codex's own skills location is unverified on
/// darwin/win32 (see the `TODO(verify:…)` comments on the source row this
/// mirrors), so this crate reports it absent there rather than guessing.
fn codex_linux_only_path(env: &PathEnv, parts: &[&str]) -> Option<String> {
    if env.platform != "linux" {
        return None;
    }
    codex_path(env, parts)
}

fn codex_skills_path(env: &PathEnv) -> Option<String> {
    codex_linux_only_path(env, &["skills"])
}

fn codex_agents_path(env: &PathEnv) -> Option<String> {
    codex_path(env, &["agents"])
}

fn codex_prompts_path(env: &PathEnv) -> Option<String> {
    codex_path(env, &["prompts"])
}

fn codex_instructions_path(env: &PathEnv) -> Option<String> {
    codex_path(env, &["AGENTS.md"])
}

fn codex_settings_path(env: &PathEnv) -> Option<String> {
    codex_path(env, &["config.toml"])
}

fn codex_hooks_path(env: &PathEnv) -> Option<String> {
    codex_path(env, &["hooks.json"])
}

fn codex_permission_rules_path(env: &PathEnv) -> Option<String> {
    codex_path(env, &["rules"])
}

/// Cursor's config home: `CURSOR_CONFIG_DIR` first, then `XDG_CONFIG_HOME`
/// on Linux only, then the platform default. Mirrors `registry.ts`'s
/// `cursorConfigHome` exactly, including its Linux-only `XDG_CONFIG_HOME`
/// branch (posix-joined regardless of `env.platform`, which is safe only
/// because that branch is reached exclusively when `env.platform ==
/// "linux"` already).
#[must_use]
pub fn cursor_config_home(env: &PathEnv) -> String {
    if let Some(configured) = env
        .env_var("CURSOR_CONFIG_DIR")
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return resolve_env_path(&env.platform, &env.home_dir, configured);
    }
    if env.platform == "linux"
        && let Some(xdg_config_home) = env
            .env_var("XDG_CONFIG_HOME")
            .map(str::trim)
            .filter(|value| !value.is_empty())
    {
        let resolved = resolve_env_path(&env.platform, &env.home_dir, xdg_config_home);
        return join_path("linux", &[&resolved, "cursor"]);
    }
    join_path(&env.platform, &[&env.home_dir, ".cursor"])
}

fn cursor_settings_path(env: &PathEnv) -> Option<String> {
    if !supports_home_locations(env) {
        return None;
    }
    let home = cursor_config_home(env);
    Some(join_path(&env.platform, &[&home, "cli-config.json"]))
}

/// `home_dir/.cursor/parts`, gated to Linux only — mirrors `registry.ts`'s
/// `cursorLinuxOnlyPath`. Deliberately ignores `cursorConfigHome`'s own
/// `CURSOR_CONFIG_DIR`/`XDG_CONFIG_HOME` overrides, exactly as the
/// TypeScript source does: only `cursor-settings` reads the configured
/// home; every other Cursor location in this table is pinned to the plain
/// `~/.cursor` layout.
fn cursor_linux_only_path(env: &PathEnv, parts: &[&str]) -> Option<String> {
    if env.platform != "linux" {
        return None;
    }
    let mut all = vec![env.home_dir.as_str(), ".cursor"];
    all.extend_from_slice(parts);
    Some(join_path("linux", &all))
}

fn cursor_skills_path(env: &PathEnv) -> Option<String> {
    home_path(env, &[".cursor", "skills"])
}

fn cursor_skills_builtin_path(env: &PathEnv) -> Option<String> {
    cursor_linux_only_path(env, &["skills-cursor"])
}

fn cursor_agents_path(env: &PathEnv) -> Option<String> {
    home_path(env, &[".cursor", "agents"])
}

fn cursor_commands_path(env: &PathEnv) -> Option<String> {
    home_path(env, &[".cursor", "commands"])
}

fn cursor_rules_path(env: &PathEnv) -> Option<String> {
    cursor_linux_only_path(env, &["rules"])
}

/// Every location the four agent-CLI targets read, mirroring
/// `LIBRARY_LOCATION_DEFINITIONS` — see this module's own docs for exactly
/// which fields of that table survive the port.
pub const LOCATION_DEFINITIONS: &[LocationDefinition] = &[
    LocationDefinition {
        id: "mango-skills",
        kind: "skill",
        scope: "home",
        resolve_path: mango_skills_path,
        access: "read-write",
        layout: LocationLayout::DirectoryOfDirs,
        read_by: &[AgentTargetId::Mangostudio],
    },
    LocationDefinition {
        id: "agents-skills",
        kind: "skill",
        scope: "home",
        resolve_path: agents_skills_path,
        access: "read-write",
        layout: LocationLayout::DirectoryOfDirs,
        read_by: &[AgentTargetId::Mangostudio, AgentTargetId::Codex],
    },
    LocationDefinition {
        id: "claude-skills",
        kind: "skill",
        scope: "home",
        resolve_path: claude_skills_path,
        access: "read-write",
        layout: LocationLayout::DirectoryOfDirs,
        read_by: &[AgentTargetId::Mangostudio, AgentTargetId::Claude],
    },
    LocationDefinition {
        id: "codex-skills",
        kind: "skill",
        scope: "home",
        resolve_path: codex_skills_path,
        access: "read-write",
        layout: LocationLayout::DirectoryOfDirs,
        read_by: &[AgentTargetId::Codex],
    },
    LocationDefinition {
        id: "cursor-skills",
        kind: "skill",
        scope: "home",
        resolve_path: cursor_skills_path,
        access: "read-write",
        layout: LocationLayout::DirectoryOfDirs,
        read_by: &[AgentTargetId::Cursor],
    },
    LocationDefinition {
        id: "cursor-skills-builtin",
        kind: "skill",
        scope: "home",
        resolve_path: cursor_skills_builtin_path,
        access: "read-only",
        layout: LocationLayout::DirectoryOfDirs,
        read_by: &[AgentTargetId::Cursor],
    },
    LocationDefinition {
        id: "mango-agents",
        kind: "subagent",
        scope: "home",
        resolve_path: mango_agents_path,
        access: "read-write",
        layout: LocationLayout::DirectoryOfFiles,
        read_by: &[AgentTargetId::Mangostudio],
    },
    LocationDefinition {
        id: "claude-agents",
        kind: "subagent",
        scope: "home",
        resolve_path: claude_agents_path,
        access: "read-write",
        layout: LocationLayout::DirectoryOfFiles,
        read_by: &[AgentTargetId::Claude],
    },
    LocationDefinition {
        id: "codex-agents",
        kind: "subagent",
        scope: "home",
        resolve_path: codex_agents_path,
        access: "read-write",
        layout: LocationLayout::DirectoryOfFiles,
        read_by: &[AgentTargetId::Codex],
    },
    LocationDefinition {
        id: "cursor-agents",
        kind: "subagent",
        scope: "home",
        resolve_path: cursor_agents_path,
        access: "read-write",
        layout: LocationLayout::DirectoryOfFiles,
        read_by: &[AgentTargetId::Cursor],
    },
    LocationDefinition {
        id: "claude-commands",
        kind: "command",
        scope: "home",
        resolve_path: claude_commands_path,
        access: "read-write",
        layout: LocationLayout::DirectoryOfFiles,
        read_by: &[AgentTargetId::Claude],
    },
    LocationDefinition {
        id: "codex-prompts",
        kind: "command",
        scope: "home",
        resolve_path: codex_prompts_path,
        access: "read-write",
        layout: LocationLayout::DirectoryOfFiles,
        read_by: &[AgentTargetId::Codex],
    },
    LocationDefinition {
        id: "cursor-commands",
        kind: "command",
        scope: "home",
        resolve_path: cursor_commands_path,
        access: "read-write",
        layout: LocationLayout::DirectoryOfFiles,
        read_by: &[AgentTargetId::Cursor],
    },
    LocationDefinition {
        id: "mango-instructions",
        kind: "instruction",
        scope: "home",
        resolve_path: mango_instructions_path,
        access: "read-write",
        layout: LocationLayout::SingleFile,
        read_by: &[AgentTargetId::Mangostudio],
    },
    LocationDefinition {
        id: "claude-instructions",
        kind: "instruction",
        scope: "home",
        resolve_path: claude_instructions_path,
        access: "read-write",
        layout: LocationLayout::SingleFile,
        read_by: &[AgentTargetId::Claude],
    },
    LocationDefinition {
        id: "codex-instructions",
        kind: "instruction",
        scope: "home",
        resolve_path: codex_instructions_path,
        access: "read-write",
        layout: LocationLayout::SingleFile,
        read_by: &[AgentTargetId::Codex],
    },
    LocationDefinition {
        id: "cursor-rules",
        kind: "instruction",
        scope: "home",
        resolve_path: cursor_rules_path,
        access: "read-write",
        layout: LocationLayout::DirectoryOfFiles,
        read_by: &[AgentTargetId::Cursor],
    },
    LocationDefinition {
        id: "claude-settings",
        kind: "setting",
        scope: "home",
        resolve_path: claude_settings_path,
        access: "read-only",
        layout: LocationLayout::SingleFile,
        read_by: &[AgentTargetId::Claude],
    },
    LocationDefinition {
        id: "codex-settings",
        kind: "setting",
        scope: "home",
        resolve_path: codex_settings_path,
        access: "read-only",
        layout: LocationLayout::SingleFile,
        read_by: &[AgentTargetId::Codex],
    },
    LocationDefinition {
        id: "cursor-settings",
        kind: "setting",
        scope: "home",
        resolve_path: cursor_settings_path,
        access: "read-only",
        layout: LocationLayout::SingleFile,
        read_by: &[AgentTargetId::Cursor],
    },
    LocationDefinition {
        id: "mango-settings",
        kind: "setting",
        scope: "home",
        resolve_path: mango_settings_path,
        access: "read-only",
        layout: LocationLayout::SingleFile,
        read_by: &[AgentTargetId::Mangostudio],
    },
    LocationDefinition {
        id: "codex-hooks",
        kind: "hook",
        scope: "home",
        resolve_path: codex_hooks_path,
        access: "read-only",
        layout: LocationLayout::SingleFile,
        read_by: &[AgentTargetId::Codex],
    },
    LocationDefinition {
        id: "claude-hooks",
        kind: "hook",
        scope: "home",
        resolve_path: claude_hooks_path,
        access: "read-only",
        layout: LocationLayout::SingleFile,
        read_by: &[AgentTargetId::Claude],
    },
    LocationDefinition {
        id: "codex-permission-rules",
        kind: "hook",
        scope: "home",
        resolve_path: codex_permission_rules_path,
        access: "read-only",
        layout: LocationLayout::DirectoryOfFiles,
        read_by: &[AgentTargetId::Codex],
    },
];

#[cfg(test)]
mod tests {
    use std::collections::{HashMap, HashSet};

    use super::*;

    fn env(platform: &str, home_dir: &str, pairs: &[(&str, &str)]) -> PathEnv {
        PathEnv {
            platform: platform.to_string(),
            home_dir: home_dir.to_string(),
            env: pairs
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
        }
    }

    #[derive(Default)]
    struct FakeFs {
        existing: HashSet<String>,
        writable: HashSet<String>,
        readable: HashSet<String>,
        entries: HashMap<String, usize>,
    }

    impl LocationFsProbe for FakeFs {
        fn exists(&self, path: &str) -> bool {
            self.existing.contains(path)
        }
        fn is_writable(&self, path: &str) -> bool {
            self.writable.contains(path)
        }
        fn is_readable(&self, path: &str) -> bool {
            self.readable.contains(path)
        }
        fn count_entries(&self, path: &str, _layout: LocationLayout) -> Option<usize> {
            self.entries.get(path).copied()
        }
    }

    #[test]
    fn every_location_is_findable_by_id_and_every_target_list_resolves() {
        for target in [
            AgentTargetId::Mangostudio,
            AgentTargetId::Claude,
            AgentTargetId::Codex,
            AgentTargetId::Cursor,
        ] {
            for id in location_ids_for_target(target) {
                assert!(
                    location_by_id(id).is_some(),
                    "{target:?}'s own location id {id} must resolve to a real definition"
                );
            }
        }
    }

    #[test]
    fn every_definition_lists_the_target_that_reads_it_in_its_own_list() {
        for definition in LOCATION_DEFINITIONS {
            for target in definition.read_by {
                assert!(
                    location_ids_for_target(*target).contains(&definition.id),
                    "{:?} claims target {:?} reads it, but that target's own list omits it",
                    definition.id,
                    target
                );
            }
        }
    }

    #[test]
    fn claude_config_home_honors_an_override() {
        let overridden = env(
            "linux",
            "/home/tester",
            &[("CLAUDE_CONFIG_DIR", "/custom/claude")],
        );
        assert_eq!(claude_config_home(&overridden), "/custom/claude");
        let default_env = env("linux", "/home/tester", &[]);
        assert_eq!(claude_config_home(&default_env), "/home/tester/.claude");
    }

    #[test]
    fn cursor_config_home_prefers_the_explicit_override_over_xdg() {
        let e = env(
            "linux",
            "/home/tester",
            &[
                ("CURSOR_CONFIG_DIR", "/explicit/cursor"),
                ("XDG_CONFIG_HOME", "/xdg/config"),
            ],
        );
        assert_eq!(cursor_config_home(&e), "/explicit/cursor");
    }

    #[test]
    fn cursor_config_home_falls_back_to_xdg_on_linux_only() {
        let linux_env = env(
            "linux",
            "/home/tester",
            &[("XDG_CONFIG_HOME", "/xdg/config")],
        );
        assert_eq!(cursor_config_home(&linux_env), "/xdg/config/cursor");
        let mac_env = env(
            "darwin",
            "/Users/tester",
            &[("XDG_CONFIG_HOME", "/xdg/config")],
        );
        assert_eq!(cursor_config_home(&mac_env), "/Users/tester/.cursor");
    }

    #[test]
    fn cursor_settings_uses_the_configured_home_but_skills_does_not() {
        let e = env(
            "linux",
            "/home/tester",
            &[("CURSOR_CONFIG_DIR", "/explicit/cursor")],
        );
        assert_eq!(
            cursor_settings_path(&e).as_deref(),
            Some("/explicit/cursor/cli-config.json")
        );
        assert_eq!(
            cursor_skills_path(&e).as_deref(),
            Some("/home/tester/.cursor/skills")
        );
    }

    #[test]
    fn codex_linux_only_locations_are_absent_off_linux() {
        let mac_env = env("darwin", "/Users/tester", &[]);
        assert_eq!(codex_skills_path(&mac_env), None);
        let linux_env = env("linux", "/home/tester", &[]);
        assert_eq!(
            codex_skills_path(&linux_env).as_deref(),
            Some("/home/tester/.codex/skills")
        );
    }

    #[test]
    fn describe_location_reports_every_false_when_the_path_cannot_exist() {
        let mac_env = env("darwin", "/Users/tester", &[]);
        let fs = FakeFs::default();
        let definition = location_by_id("codex-skills").unwrap();
        let status = describe_location(definition, &mac_env, &fs);
        assert_eq!(status.path, None);
        assert!(!status.exists);
        assert!(!status.readable);
        assert!(!status.writable);
    }

    #[test]
    fn describe_location_falls_back_to_nearest_existing_writable_when_absent() {
        let e = env("linux", "/home/tester", &[]);
        let mut fs = FakeFs::default();
        fs.existing.insert("/home/tester/.mango".to_string());
        fs.writable.insert("/home/tester/.mango".to_string());
        let definition = location_by_id("mango-skills").unwrap();
        let status = describe_location(definition, &e, &fs);
        assert_eq!(status.path.as_deref(), Some("/home/tester/.mango/skills"));
        assert!(!status.exists);
        assert!(
            status.writable,
            "the nearest existing ancestor is writable, so this not-yet-created path is too"
        );
    }

    #[test]
    fn describe_location_counts_entries_only_when_readable_and_not_single_file() {
        let e = env("linux", "/home/tester", &[]);
        let mut fs = FakeFs::default();
        let path = "/home/tester/.claude/skills";
        fs.existing.insert(path.to_string());
        fs.readable.insert(path.to_string());
        fs.entries.insert(path.to_string(), 3);
        let definition = location_by_id("claude-skills").unwrap();
        let status = describe_location(definition, &e, &fs);
        assert_eq!(status.entry_count, Some(3));

        let settings_path = "/home/tester/.claude/settings.json";
        let mut settings_fs = FakeFs::default();
        settings_fs.existing.insert(settings_path.to_string());
        settings_fs.readable.insert(settings_path.to_string());
        settings_fs.entries.insert(settings_path.to_string(), 99);
        let settings_definition = location_by_id("claude-settings").unwrap();
        let settings_status = describe_location(settings_definition, &e, &settings_fs);
        assert_eq!(
            settings_status.entry_count, None,
            "a single-file location is never entry-counted, even when the fake fs has an answer"
        );
    }

    #[test]
    fn nearest_existing_writable_walks_up_to_the_first_real_ancestor() {
        let mut fs = FakeFs::default();
        fs.existing.insert("/a".to_string());
        fs.writable.insert("/a".to_string());
        assert!(nearest_existing_writable("/a/b/c/d", "linux", &fs));
    }

    #[test]
    fn nearest_existing_writable_reports_false_when_nothing_up_to_root_exists() {
        let fs = FakeFs::default();
        assert!(!nearest_existing_writable("/a/b/c", "linux", &fs));
    }
}
