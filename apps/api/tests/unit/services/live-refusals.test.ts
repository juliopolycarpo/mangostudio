import { describe, expect, it } from 'bun:test';
import { delimiter, join } from 'node:path';

import type { ExternalAgentDescriptor } from '@mangostudio/shared/external-agents';
import { NO_EXTERNAL_AGENT_CAPABILITIES } from '@mangostudio/shared/external-agents';

import {
  cachedBeforeRefusal,
  CheapPassFake,
  executableDirectory,
  isOlderVersion,
  LIVE_REFUSAL_CASES,
  type LiveRefusalCase,
  refusalEnvironment,
  refusedReason,
  requestedRefusalCases,
  requiredExecutable,
  SingleTargetDiscovery,
  sseFrames,
  versionOf,
} from '../../support/external-agents/live-refusals';

function caseNamed(id: LiveRefusalCase['id']): LiveRefusalCase {
  const found = LIVE_REFUSAL_CASES.find((entry) => entry.id === id);
  if (!found) throw new Error(`expected a case named ${id} | received: none`);
  return found;
}

describe('requestedRefusalCases', () => {
  it('selects nothing when the variable is unset or blank', () => {
    expect(requestedRefusalCases(undefined)).toEqual([]);
    expect(requestedRefusalCases('  ')).toEqual([]);
  });

  it('selects the named cases in their defined order, ignoring spacing', () => {
    expect(requestedRefusalCases(' codex-outdated , codex-signed-out ').map((c) => c.id)).toEqual([
      'codex-signed-out',
      'codex-outdated',
    ]);
  });

  it('rejects a name it does not know, naming the value and the accepted names', () => {
    expect(() => requestedRefusalCases('codex-signed-out,codex-signedout')).toThrow(
      'expected MANGOSTUDIO_LIVE_AGENT_REFUSALS to name only codex-signed-out | claude-signed-out | cursor-signed-out | codex-outdated | codex-outdated-reopen | codex-child-killed-between-turns | claude-reopen-after-connection-drop | claude-reopen-after-killed-turn | received: codex-signedout'
    );
  });
});

describe('refusalEnvironment', () => {
  const base = { emptyDirectory: '/scratch/empty', inheritedPath: '/usr/bin' };

  it('points only the vendor config home at the empty directory for a signed-out codex', () => {
    expect(refusalEnvironment(caseNamed('codex-signed-out'), base)).toEqual({
      CODEX_HOME: '/scratch/empty',
    });
  });

  it('points only the vendor config home at the empty directory for a signed-out claude', () => {
    expect(refusalEnvironment(caseNamed('claude-signed-out'), base)).toEqual({
      CLAUDE_CONFIG_DIR: '/scratch/empty',
    });
  });

  it('moves the whole home for cursor and keeps the real binary reachable first on PATH', () => {
    expect(
      refusalEnvironment(caseNamed('cursor-signed-out'), {
        ...base,
        cursorDirectory: '/home/ada/.local/bin',
      })
    ).toEqual({
      HOME: '/scratch/empty',
      USERPROFILE: '/scratch/empty',
      XDG_CONFIG_HOME: join('/scratch/empty', '.config'),
      PATH: ['/home/ada/.local/bin', '/usr/bin'].join(delimiter),
    });
  });

  it('puts the older codex first on PATH and signs nothing in', () => {
    expect(
      refusalEnvironment(caseNamed('codex-outdated'), {
        ...base,
        outdatedCodexDirectory: '/scratch/old/bin',
      })
    ).toEqual({
      CODEX_HOME: '/scratch/empty',
      PATH: ['/scratch/old/bin', '/usr/bin'].join(delimiter),
    });
  });

  it('gives the second runtime of the reopen flow an empty codex home and the older binary', () => {
    expect(
      refusalEnvironment(caseNamed('codex-outdated-reopen'), {
        ...base,
        outdatedCodexDirectory: '/scratch/old/bin',
      })
    ).toEqual({
      CODEX_HOME: '/scratch/empty',
      PATH: ['/scratch/old/bin', '/usr/bin'].join(delimiter),
    });
  });

  it('refuses an outdated case without the older binary, saying which variable names it', () => {
    expect(() => refusalEnvironment(caseNamed('codex-outdated'), base)).toThrow(
      'expected MANGOSTUDIO_LIVE_OUTDATED_CODEX_DIR to name the directory of an older codex | received: none'
    );
  });

  it('refuses a cursor case without the directory of the real binary', () => {
    expect(() => refusalEnvironment(caseNamed('cursor-signed-out'), base)).toThrow(
      'expected the directory of the real cursor-agent for cursor-signed-out | received: none'
    );
  });
});

describe('version helpers', () => {
  it('reads the dotted version out of a version line', () => {
    expect(versionOf('codex-cli 0.150.0')).toBe('0.150.0');
    expect(() => versionOf('codex')).toThrow(
      'expected a dotted version in the version line | received: codex'
    );
  });

  it('orders versions numerically, not as text', () => {
    expect(isOlderVersion('0.150.0', '0.154.0')).toBe(true);
    expect(isOlderVersion('0.9.0', '0.10.0')).toBe(true);
    expect(isOlderVersion('0.154.0', '0.154.0')).toBe(false);
    expect(isOlderVersion('1.0.0', '0.154.0')).toBe(false);
  });

  it('names the program when it was not found on PATH', () => {
    expect(executableDirectory('cursor-agent', '/home/ada/.local/bin/cursor-agent')).toBe(
      '/home/ada/.local/bin'
    );
    expect(() => executableDirectory('cursor-agent', null)).toThrow(
      'expected cursor-agent to be on PATH | received: not found'
    );
  });
});

describe('SingleTargetDiscovery', () => {
  it('asks the runtime about the one target whatever the caller listed', async () => {
    const asked: unknown[] = [];
    const client = {
      manifest: { platform: 'linux' },
      externalAgents: {
        discover: (params: unknown) => {
          asked.push(params);
          return Promise.resolve({ descriptors: [] });
        },
      },
    };
    const scoped = new SingleTargetDiscovery(client as never, 'codex');

    await scoped.externalAgents.discover({
      targetIds: ['claude', 'codex', 'cursor'],
      timeoutMs: 5,
    });

    expect(asked).toEqual([{ targetIds: ['codex'], timeoutMs: 5 }]);
    expect(scoped.manifest as unknown).toBe(client.manifest);
  });
});

describe('CheapPassFake', () => {
  it('reports the target installed and looking signed in, as a stale scan would', async () => {
    const [status] = await new CheapPassFake('cursor').listAgentCliStatuses();
    expect({ id: status?.id, authenticated: status?.authenticated }).toEqual({
      id: 'cursor',
      authenticated: true,
    });
  });
});

describe('cachedBeforeRefusal', () => {
  const live: ExternalAgentDescriptor = {
    targetId: 'codex',
    environmentId: 'env',
    installed: true,
    version: '0.150.0',
    requiredVersion: '0.154.0',
    authState: 'signed-in',
    capabilities: NO_EXTERNAL_AGENT_CAPABILITIES,
    supportedConfigurations: [],
    unavailableReason: 'version-unsupported',
    remedy: { kind: 'update' },
  };

  it('drops the reason, remedy and required version and keeps a supported pair', () => {
    const cached = cachedBeforeRefusal(live);
    expect({
      reason: cached.unavailableReason,
      remedy: cached.remedy,
      required: cached.requiredVersion,
      pairs: cached.supportedConfigurations.map((pair) => pair.supported),
      authState: cached.authState,
    }).toEqual({
      reason: undefined,
      remedy: undefined,
      required: undefined,
      pairs: [true],
      authState: 'signed-in',
    });
  });
});

describe('the codex-child-killed-between-turns case', () => {
  it('layers nothing over the runtime environment, so the signed-in account and current codex are used', () => {
    expect(
      refusalEnvironment(caseNamed('codex-child-killed-between-turns'), {
        emptyDirectory: '/scratch/empty',
        inheritedPath: '/usr/bin',
      })
    ).toEqual({});
  });

  it('names no refusal reason, because nothing is refused', () => {
    expect(() => refusedReason(caseNamed('codex-child-killed-between-turns'))).toThrow(
      'expected case codex-child-killed-between-turns to name a refusal reason | received: none'
    );
    expect(refusedReason(caseNamed('codex-signed-out'))).toBe('signed-out');
  });
});

describe('LIVE_REFUSAL_CASES', () => {
  it('expects every selector to refuse except cursor, whose status surface cannot say signed out', () => {
    expect(
      Object.fromEntries(LIVE_REFUSAL_CASES.map((entry) => [entry.id, entry.selectorRefuses]))
    ).toEqual({
      'codex-signed-out': true,
      'claude-signed-out': true,
      'cursor-signed-out': false,
      'codex-outdated': true,
      'codex-outdated-reopen': false,
      'codex-child-killed-between-turns': false,
      'claude-reopen-after-connection-drop': false,
      'claude-reopen-after-killed-turn': false,
    });
  });
});

describe('requiredExecutable', () => {
  it('returns the located path and names the program when there is none', () => {
    expect(requiredExecutable('codex', '/usr/bin/codex')).toBe('/usr/bin/codex');
    expect(() => requiredExecutable('codex', undefined)).toThrow(
      'expected codex to be on PATH | received: not found'
    );
  });
});

describe('sseFrames', () => {
  it('parses data frames and skips comments', () => {
    expect(sseFrames(': keep-alive\n\ndata: {"type":"a"}\n\ndata: {"type":"done"}\n\n')).toEqual([
      { type: 'a' },
      { type: 'done' },
    ]);
  });
});
