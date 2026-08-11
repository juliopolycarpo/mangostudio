/**
 * The committed vendor contracts, read back against what the adapters claim.
 *
 * `bun run vendor-contracts:check` proves the captures still match the
 * *binaries*. Nothing there proves they still match the **adapters** — a
 * maintainer can record a Cursor handshake that no longer carries a key
 * `handshake.ts` requires, or a Claude surface missing a flag `buildTurnArgv`
 * passes, and the capture would be a faithful record of a build this runtime
 * cannot drive. That gap is what this file closes, and it closes it offline:
 * these assertions run in `bun run test` on a machine with no vendor CLI
 * installed at all.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildTurnArgv } from '../../../src/services/external-agents/claude/adapter';
import {
  CLAUDE_REQUIRED_CLI_FLAGS,
  parseClaudeCliSurface,
} from '../../../src/services/external-agents/claude/cli-surface';
import {
  auditCursorHandshake,
  CURSOR_KNOWN_AGENT_CAPABILITY_KEYS,
  CURSOR_REQUIRED_HANDSHAKE_KEYS,
} from '../../../src/services/external-agents/cursor/handshake';
import { CURSOR_ACP_PROTOCOL_VERSION } from '../../../src/services/external-agents/cursor/pinned';
import type { AcpInitializeResponse } from '../../../src/services/external-agents/cursor/protocol';

const EXTERNAL_AGENTS_DIR = join(import.meta.dir, '../../../src/services/external-agents');

function contract<T>(vendor: string, file: string): T {
  return JSON.parse(readFileSync(join(EXTERNAL_AGENTS_DIR, vendor, 'contract', file), 'utf8')) as T;
}

interface ContractManifest {
  readonly set: string;
  readonly command: string;
  readonly capturedFrom: string;
  readonly capturedAt: string;
  readonly checksum: string;
}

describe('every contract records where it came from', () => {
  it.each([
    ['codex', 'codex-protocol'],
    ['cursor', 'cursor-acp'],
    ['claude', 'claude-cli'],
  ])('%s names its set, its source build and a checksum', (vendor, setId) => {
    const manifest = contract<ContractManifest>(vendor, 'manifest.json');

    expect(manifest.set).toBe(setId);
    expect(manifest.command.length).toBeGreaterThan(0);
    expect(manifest.capturedFrom.length).toBeGreaterThan(0);
    // A date without a checksum cannot tell a regeneration that produced
    // identical output from one that was never run.
    expect(manifest.checksum).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(manifest.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('the recorded Cursor handshake satisfies what the adapter requires', () => {
  const initialize = contract<AcpInitializeResponse>('cursor', 'initialize.json');

  it('carries every key the audit refuses to run without', () => {
    const audit = auditCursorHandshake(initialize);

    expect(audit.missing).toEqual([]);
    for (const key of CURSOR_REQUIRED_HANDSHAKE_KEYS) {
      expect(Object.hasOwn(initialize as object, key)).toBe(true);
    }
  });

  /**
   * The declared "known" list is what decides whether a capability key gets
   * logged as new. Letting it drift past the recorded handshake would either
   * log on every startup or stop reporting genuinely new keys.
   */
  it('declares exactly the capability keys the recorded handshake carries', () => {
    expect(Object.keys(initialize.agentCapabilities ?? {}).sort()).toEqual([
      ...CURSOR_KNOWN_AGENT_CAPABILITY_KEYS,
    ]);
    expect(auditCursorHandshake(initialize).unrecognized).toEqual([]);
  });

  it('was captured against the protocol version this runtime speaks', () => {
    expect(initialize.protocolVersion).toBe(CURSOR_ACP_PROTOCOL_VERSION);
  });
});

describe('the recorded Claude surface satisfies what the adapter passes', () => {
  const surface = contract<{ flags: string[]; permissionModes: string[] }>(
    'claude',
    'cli-surface.json'
  );

  it('declares every flag the required list names', () => {
    expect(CLAUDE_REQUIRED_CLI_FLAGS.filter((flag) => !surface.flags.includes(flag))).toEqual([]);
  });

  /**
   * The other direction, and the one a declared list gets wrong on its own: a
   * flag removed from `buildTurnArgv` but left in `CLAUDE_REQUIRED_CLI_FLAGS`
   * would keep greying out builds over an argument nothing sends.
   */
  it('requires nothing the turn argv does not actually pass', () => {
    const argv = new Set(
      buildTurnArgv({
        executable: '/usr/bin/claude',
        session: { sessionId: 'session', established: false },
        configuration: {
          level: 'default',
          routing: 'user',
          workspaceRoots: ['/work'],
          model: 'opus',
        },
        availability: { autoModeDisabledByPolicy: false, effectiveDefaultIsAuto: false },
      })
    );
    // `--resume` is the only required flag a first turn cannot show: it is the
    // alternative to `--session-id`, and one run passes exactly one of them.
    const unsent = CLAUDE_REQUIRED_CLI_FLAGS.filter((flag) => !argv.has(flag));

    expect(unsent).toEqual(['--resume']);
    expect(
      buildTurnArgv({
        executable: '/usr/bin/claude',
        session: { sessionId: 'session', established: true },
        configuration: { level: 'default', routing: 'user', workspaceRoots: ['/work'] },
        availability: { autoModeDisabledByPolicy: false, effectiveDefaultIsAuto: false },
      })
    ).toContain('--resume');
  });

  it('offers the permission modes the matrix maps onto', () => {
    // `manual`, `plan` and `bypassPermissions` are unconditional; `auto` is
    // account-dependent and only has to exist as a choice.
    for (const mode of ['manual', 'plan', 'bypassPermissions', 'auto']) {
      expect(surface.permissionModes).toContain(mode);
    }
  });

  /** The parser and the capture must read the same text the same way. */
  it('round-trips through the runtime parser', () => {
    const declared = parseClaudeCliSurface(
      surface.flags.map((flag) => `  ${flag} <value>    Description`).join('\n')
    );

    expect([...declared.flags].sort()).toEqual([...surface.flags].sort());
  });
});
