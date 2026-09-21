//! The four agent-CLI definitions, mirroring
//! `apps/shared/src/environments/detection/agent-cli-definitions.ts`:
//! MangoStudio itself (`kind: 'self'`, no runtime scan of its own — it is
//! the process running this code) and Claude, Codex and Cursor
//! (`kind: 'cli'`, each with its own version-parse regex and an auth
//! probe definition).

use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use super::binary_scan::RuntimeDefinition;
use super::path_env::PathEnv;
use super::types::{RuntimeId, SemVer};

/// Which agent-CLI target a definition is about — this crate's mirror of
/// the four-variant `LibraryTargetId`, collapsed into one enum rather than
/// TypeScript's `LibraryTargetId`/`ExternalAgentTargetId` pair: Rust has
/// no structural "all of these except one" type the way `Exclude<>` gives
/// TypeScript, so [`AgentCliDefinition`]'s own `Cli`/`SelfTarget` split is
/// what keeps `mangostudio` from ever appearing where an external CLI is
/// expected, instead of a second, narrower id type.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentTargetId {
    /// MangoStudio itself.
    Mangostudio,
    /// Claude Code.
    Claude,
    /// Codex.
    Codex,
    /// Cursor's `agent` CLI.
    Cursor,
}

/// How an external agent CLI's sign-in state is probed.
#[derive(Debug, Clone, Copy)]
pub enum AgentAuthDefinition {
    /// A presence-only credential file. Claude may use a keychain instead,
    /// so a missing file is not necessarily a signed-out verdict — see
    /// `unknown_when_missing`.
    File {
        /// The credential file's name, under the CLI's config home.
        file_name: &'static str,
        /// Whether a missing file reads as [`super::types::AgentAuthSignal::Unknown`]
        /// (the CLI may keep credentials elsewhere) rather than a
        /// definite signed-out verdict.
        unknown_when_missing: bool,
    },
    /// A key inside the CLI's own JSON config.
    ConfigKey {
        /// The config file's name, under the CLI's config home.
        file_name: &'static str,
        /// The key whose presence signals sign-in.
        key: &'static str,
    },
}

/// One externally-hosted agent CLI: a target id, its runtime scan
/// definition, and how to probe its sign-in state.
#[derive(Debug, Clone, Copy)]
pub struct ExternalAgentCliDefinition {
    /// Which agent CLI this is.
    pub target_id: AgentTargetId,
    /// How to find and version-probe this CLI's binary.
    pub runtime: RuntimeDefinition,
    /// How to probe this CLI's sign-in state.
    pub auth: AgentAuthDefinition,
}

/// Every agent CLI this crate can report on.
#[derive(Debug, Clone, Copy)]
pub enum AgentCliDefinition {
    /// An externally-hosted vendor CLI.
    Cli(ExternalAgentCliDefinition),
    /// MangoStudio itself — no runtime scan, no auth probe: it is the
    /// process running this code.
    SelfTarget,
}

impl AgentCliDefinition {
    /// This definition's target id, for either variant — mirrors
    /// `selectById`'s own `idOf` callback in `service.ts`, which reads
    /// `definition.targetId` off either shape uniformly.
    #[must_use]
    pub fn target_id(&self) -> AgentTargetId {
        match self {
            AgentCliDefinition::Cli(cli) => cli.target_id,
            AgentCliDefinition::SelfTarget => AgentTargetId::Mangostudio,
        }
    }
}

fn parse_version_match(raw: &str, pattern: &Regex) -> Option<SemVer> {
    let captures = pattern.captures(raw.trim())?;
    Some(SemVer {
        major: captures[1].parse().ok()?,
        minor: captures[2].parse().ok()?,
        patch: captures[3].parse().ok()?,
    })
}

static CLAUDE_VERSION_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(\d+)\.(\d+)\.(\d+)(?:\s+\(Claude Code\))?$")
        .expect("a fixed, hand-checked pattern")
});

/// Parses `claude --version` output: `2.1.220 (Claude Code)`.
#[must_use]
pub fn parse_claude_version(raw: &str) -> Option<SemVer> {
    parse_version_match(raw, &CLAUDE_VERSION_PATTERN)
}

static CODEX_VERSION_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^codex-cli\s+(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$")
        .expect("a fixed, hand-checked pattern")
});

/// Parses `codex --version` output: `codex-cli 0.145.0`.
#[must_use]
pub fn parse_codex_version(raw: &str) -> Option<SemVer> {
    parse_version_match(raw, &CODEX_VERSION_PATTERN)
}

static CURSOR_AGENT_VERSION_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$")
        .expect("a fixed, hand-checked pattern")
});

/// Parses `cursor-agent --version`/`agent --version` output, e.g.
/// `2026.07.16-899851b`.
#[must_use]
pub fn parse_cursor_agent_version(raw: &str) -> Option<SemVer> {
    parse_version_match(raw, &CURSOR_AGENT_VERSION_PATTERN)
}

fn no_well_known_directories(_env: &PathEnv) -> Vec<String> {
    Vec::new()
}

/// Claude Code. Verified on Linux 2026-07-26: `claude --version` printed
/// `2.1.220 (Claude Code)`.
pub const CLAUDE_AGENT_CLI_DEFINITION: ExternalAgentCliDefinition = ExternalAgentCliDefinition {
    target_id: AgentTargetId::Claude,
    runtime: RuntimeDefinition {
        id: RuntimeId::Claude,
        binary_names: &["claude"],
        version_args: &["--version"],
        parse_version: parse_claude_version,
        keep_unparsed_version: true,
        well_known_dirs: no_well_known_directories,
        include_bare_binary_names: false,
    },
    auth: AgentAuthDefinition::File {
        file_name: ".credentials.json",
        unknown_when_missing: true,
    },
};

/// Codex. Verified on Linux 2026-07-26: `codex --version` printed
/// `codex-cli 0.145.0`.
pub const CODEX_AGENT_CLI_DEFINITION: ExternalAgentCliDefinition = ExternalAgentCliDefinition {
    target_id: AgentTargetId::Codex,
    runtime: RuntimeDefinition {
        id: RuntimeId::Codex,
        binary_names: &["codex"],
        version_args: &["--version"],
        parse_version: parse_codex_version,
        keep_unparsed_version: true,
        well_known_dirs: no_well_known_directories,
        include_bare_binary_names: false,
    },
    auth: AgentAuthDefinition::File {
        file_name: "auth.json",
        unknown_when_missing: false,
    },
};

/// Cursor. Verified against docs.cursor.com 2026-09-03: the CLI is
/// documented and installed as `agent`. `cursor-agent` stays second for
/// an install laid down before the rename — Cursor has not said the old
/// name is ever removed.
pub const CURSOR_AGENT_CLI_DEFINITION: ExternalAgentCliDefinition = ExternalAgentCliDefinition {
    target_id: AgentTargetId::Cursor,
    runtime: RuntimeDefinition {
        id: RuntimeId::Cursor,
        binary_names: &["agent", "cursor-agent"],
        version_args: &["--version"],
        parse_version: parse_cursor_agent_version,
        keep_unparsed_version: true,
        well_known_dirs: no_well_known_directories,
        include_bare_binary_names: false,
    },
    auth: AgentAuthDefinition::ConfigKey {
        file_name: "cli-config.json",
        key: "authInfo",
    },
};

/// MangoStudio itself, as an agent-CLI target.
pub const MANGOSTUDIO_AGENT_CLI_DEFINITION: AgentCliDefinition = AgentCliDefinition::SelfTarget;

/// Every agent CLI this crate can report on, in publication order.
pub const AGENT_CLI_DEFINITIONS: &[AgentCliDefinition] = &[
    MANGOSTUDIO_AGENT_CLI_DEFINITION,
    AgentCliDefinition::Cli(CLAUDE_AGENT_CLI_DEFINITION),
    AgentCliDefinition::Cli(CODEX_AGENT_CLI_DEFINITION),
    AgentCliDefinition::Cli(CURSOR_AGENT_CLI_DEFINITION),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_claude_version_with_and_without_the_claude_code_suffix() {
        assert_eq!(
            parse_claude_version("2.1.220 (Claude Code)"),
            Some(SemVer {
                major: 2,
                minor: 1,
                patch: 220
            })
        );
        assert_eq!(
            parse_claude_version("2.1.220"),
            Some(SemVer {
                major: 2,
                minor: 1,
                patch: 220
            })
        );
        assert_eq!(parse_claude_version("not a version"), None);
    }

    #[test]
    fn parses_codex_version_dropping_a_prerelease_suffix() {
        assert_eq!(
            parse_codex_version("codex-cli 0.145.0"),
            Some(SemVer {
                major: 0,
                minor: 145,
                patch: 0
            })
        );
        assert_eq!(
            parse_codex_version("codex-cli 0.145.0-beta.1"),
            Some(SemVer {
                major: 0,
                minor: 145,
                patch: 0
            })
        );
        assert_eq!(parse_codex_version("0.145.0"), None);
    }

    #[test]
    fn parses_cursor_agent_version_with_a_build_suffix() {
        assert_eq!(
            parse_cursor_agent_version("2026.7.16-899851b"),
            Some(SemVer {
                major: 2026,
                minor: 7,
                patch: 16
            })
        );
        assert_eq!(
            parse_cursor_agent_version("2026.7.16"),
            Some(SemVer {
                major: 2026,
                minor: 7,
                patch: 16
            })
        );
    }

    #[test]
    fn claude_and_codex_and_cursor_definitions_keep_unparsed_versions() {
        // Every one of these is a `const` literal, so clippy sees the
        // assertion's value at compile time — wrapping it in a `const`
        // block is what it asks for, and still fails the build (not just
        // this test) the moment one of these three definitions regresses.
        const {
            assert!(CLAUDE_AGENT_CLI_DEFINITION.runtime.keep_unparsed_version);
            assert!(CODEX_AGENT_CLI_DEFINITION.runtime.keep_unparsed_version);
            assert!(CURSOR_AGENT_CLI_DEFINITION.runtime.keep_unparsed_version);
        }
    }

    #[test]
    fn cursor_searches_the_renamed_binary_before_the_legacy_one() {
        assert_eq!(
            CURSOR_AGENT_CLI_DEFINITION.runtime.binary_names,
            &["agent", "cursor-agent"]
        );
    }

    #[test]
    fn agent_cli_definitions_lists_mangostudio_first_then_the_three_external_clis() {
        assert_eq!(AGENT_CLI_DEFINITIONS.len(), 4);
        assert!(matches!(
            AGENT_CLI_DEFINITIONS[0],
            AgentCliDefinition::SelfTarget
        ));
        assert!(
            matches!(AGENT_CLI_DEFINITIONS[1], AgentCliDefinition::Cli(definition) if definition.target_id == AgentTargetId::Claude)
        );
    }

    #[test]
    fn claude_auth_is_unknown_when_missing_but_codex_is_not() {
        let AgentAuthDefinition::File {
            unknown_when_missing: claude_unknown,
            ..
        } = CLAUDE_AGENT_CLI_DEFINITION.auth
        else {
            panic!("claude uses a file auth definition")
        };
        let AgentAuthDefinition::File {
            unknown_when_missing: codex_unknown,
            ..
        } = CODEX_AGENT_CLI_DEFINITION.auth
        else {
            panic!("codex uses a file auth definition")
        };
        assert!(claude_unknown);
        assert!(!codex_unknown);
    }
}
