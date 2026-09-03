import type { LibraryTargetId } from '../../library';
import type { RuntimeDefinition, SemVer } from './binary-scan';

type ExternalAgentTargetId = Exclude<LibraryTargetId, 'mangostudio'>;

interface FileAuthDefinition {
  readonly kind: 'file';
  readonly fileName: string;
  /** Claude may use a keychain, so a missing file is not a signed-out verdict. */
  readonly unknownWhenMissing: boolean;
}

interface ConfigKeyAuthDefinition {
  readonly kind: 'config-key';
  readonly fileName: string;
  readonly key: string;
}

export interface ExternalAgentCliDefinition {
  readonly kind: 'cli';
  readonly targetId: ExternalAgentTargetId;
  readonly runtime: RuntimeDefinition;
  readonly auth: FileAuthDefinition | ConfigKeyAuthDefinition;
}

export interface SelfAgentCliDefinition {
  readonly kind: 'self';
  readonly targetId: 'mangostudio';
}

export type AgentCliDefinition = ExternalAgentCliDefinition | SelfAgentCliDefinition;

function parseVersionMatch(raw: string, pattern: RegExp): SemVer | null {
  const match = raw.trim().match(pattern);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function parseClaudeVersion(raw: string): SemVer | null {
  return parseVersionMatch(raw, /^(\d+)\.(\d+)\.(\d+)(?:\s+\(Claude Code\))?$/);
}

export function parseCodexVersion(raw: string): SemVer | null {
  return parseVersionMatch(raw, /^codex-cli\s+(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/);
}

export function parseCursorAgentVersion(raw: string): SemVer | null {
  return parseVersionMatch(raw, /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/);
}

const noWellKnownDirectories = () => [];

// Verified on Linux 2026-07-26: `claude --version` printed
// `2.1.220 (Claude Code)`.
export const CLAUDE_AGENT_CLI_DEFINITION: ExternalAgentCliDefinition = {
  kind: 'cli',
  targetId: 'claude',
  runtime: {
    id: 'claude',
    binaryNames: ['claude'],
    versionArgs: ['--version'],
    parseVersion: parseClaudeVersion,
    keepUnparsedVersion: true,
    wellKnownDirs: noWellKnownDirectories,
  },
  auth: {
    kind: 'file',
    fileName: '.credentials.json',
    unknownWhenMissing: true,
  },
};

// Verified on Linux 2026-07-26: `codex --version` printed
// `codex-cli 0.145.0`.
export const CODEX_AGENT_CLI_DEFINITION: ExternalAgentCliDefinition = {
  kind: 'cli',
  targetId: 'codex',
  runtime: {
    id: 'codex',
    binaryNames: ['codex'],
    versionArgs: ['--version'],
    parseVersion: parseCodexVersion,
    keepUnparsedVersion: true,
    wellKnownDirs: noWellKnownDirectories,
  },
  auth: {
    kind: 'file',
    fileName: 'auth.json',
    unknownWhenMissing: false,
  },
};

// Verified against docs.cursor.com 2026-09-03: the CLI is documented and
// installed as `agent`. `cursor-agent` stays second for an install laid down
// before the rename — Cursor has not said the old name is ever removed.
export const CURSOR_AGENT_CLI_DEFINITION: ExternalAgentCliDefinition = {
  kind: 'cli',
  targetId: 'cursor',
  runtime: {
    id: 'cursor',
    binaryNames: ['agent', 'cursor-agent'],
    versionArgs: ['--version'],
    parseVersion: parseCursorAgentVersion,
    keepUnparsedVersion: true,
    wellKnownDirs: noWellKnownDirectories,
  },
  auth: {
    kind: 'config-key',
    fileName: 'cli-config.json',
    key: 'authInfo',
  },
};

export const MANGOSTUDIO_AGENT_CLI_DEFINITION: SelfAgentCliDefinition = {
  kind: 'self',
  targetId: 'mangostudio',
};

export const AGENT_CLI_DEFINITIONS: readonly AgentCliDefinition[] = [
  MANGOSTUDIO_AGENT_CLI_DEFINITION,
  CLAUDE_AGENT_CLI_DEFINITION,
  CODEX_AGENT_CLI_DEFINITION,
  CURSOR_AGENT_CLI_DEFINITION,
];
