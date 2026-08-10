/**
 * The Claude adapter's decisions, isolated from the process that carries them.
 *
 * Three things are checked here that nothing else can check: the argv the turn
 * is launched with, the account-dependent permission matrix, and what the
 * `auth status` payload is allowed to turn into. The first two are where a
 * mistake reaches the vendor as an unrunnable flag; the third is where a mistake
 * puts somebody's email address on the wire.
 */

import { describe, expect, it } from 'bun:test';
import { buildTurnArgv } from '../../../src/services/external-agents/claude/adapter';
import { parseClaudeAuthStatus } from '../../../src/services/external-agents/claude/auth';
import {
  buildSupportedConfigurations,
  CLAUDE_CANONICAL_DEFAULT_MODE,
  CLAUDE_CLI_DEFAULT_MODE,
  CLAUDE_UNSUPPORTED_REASON_KEYS,
  claudeAutoModeRefusal,
  claudeEffectiveDefault,
  claudePermissionMode,
  readAutoModeDisabled,
} from '../../../src/services/external-agents/claude/permissions';
import {
  compareClaudeVersions,
  parseClaudeVersion,
} from '../../../src/services/external-agents/claude/version';

const SUBSCRIPTION = {
  accountKind: 'subscription',
  autoModeDisabledByPolicy: false,
  effectiveDefaultIsAuto: false,
} as const;

const CONFIGURATION = {
  level: 'default',
  routing: 'user',
  workspaceRoots: ['/work/repo'],
} as const;

function argv(overrides: Parameters<typeof buildTurnArgv>[0]) {
  return buildTurnArgv(overrides);
}

describe('buildTurnArgv', () => {
  const base = {
    executable: '/usr/bin/claude',
    session: { sessionId: 'a5f3', established: false },
    configuration: CONFIGURATION,
    availability: SUBSCRIPTION,
  };

  /**
   * The one that matters most. argv is world-readable in `ps`, so a prompt
   * placed there would publish the conversation to every account on the machine.
   */
  it('never puts the prompt in argv', () => {
    const result = argv(base);
    expect(result).toContain('--input-format');
    expect(result[result.indexOf('--input-format') + 1]).toBe('stream-json');
  });

  it('asks for the flags token-level deltas need', () => {
    const result = argv(base);
    expect(result).toContain('--verbose');
    expect(result).toContain('--include-partial-messages');
    expect(result).toContain('--forward-subagent-text');
  });

  it('mints the session on the first turn and resumes it afterwards', () => {
    expect(argv(base)).toContain('--session-id');
    expect(argv(base)).toContain('a5f3');
    const resumed = argv({ ...base, session: { sessionId: 'a5f3', established: true } });
    expect(resumed).toContain('--resume');
    expect(resumed).not.toContain('--session-id');
  });

  /** `default` is the config spelling; `manual` is what the CLI's parser takes. */
  it('passes manual on the command line while default is what is persisted', () => {
    const result = argv(base);
    expect(result[result.indexOf('--permission-mode') + 1]).toBe(CLAUDE_CLI_DEFAULT_MODE);
    expect(CLAUDE_CLI_DEFAULT_MODE).toBe('manual');
    expect(CLAUDE_CANONICAL_DEFAULT_MODE).toBe('default');
  });

  it('uses plan for read-only and bypassPermissions for full access', () => {
    const readOnly = argv({
      ...base,
      configuration: { ...CONFIGURATION, level: 'read-only' },
    });
    expect(readOnly[readOnly.indexOf('--permission-mode') + 1]).toBe('plan');
    const full = argv({ ...base, configuration: { ...CONFIGURATION, level: 'full-access' } });
    expect(full[full.indexOf('--permission-mode') + 1]).toBe('bypassPermissions');
  });

  /**
   * `bypassPermissions` is the supported spelling of full access. The two
   * `--dangerously-skip-permissions` flags are the interactive escape hatches
   * and must never appear in a MangoStudio-launched process.
   */
  it('never passes a dangerously-skip-permissions flag', () => {
    for (const level of ['read-only', 'default', 'full-access'] as const) {
      const result = argv({ ...base, configuration: { ...CONFIGURATION, level } });
      expect(result.join(' ')).not.toContain('dangerously-skip-permissions');
    }
  });

  it('forwards a model only when one was chosen', () => {
    expect(argv(base)).not.toContain('--model');
    const withModel = argv({
      ...base,
      configuration: { ...CONFIGURATION, model: 'claude-sonnet-5' },
    });
    expect(withModel[withModel.indexOf('--model') + 1]).toBe('claude-sonnet-5');
  });
});

describe('permission mode resolution', () => {
  it('offers auto-review only on a subscription account', () => {
    expect(claudePermissionMode('default', 'auto-review', SUBSCRIPTION)).toBe('auto');
    expect(
      claudePermissionMode('default', 'auto-review', { ...SUBSCRIPTION, accountKind: 'api-key' })
    ).toBeUndefined();
  });

  /**
   * Managed settings are read directly rather than inferred from a failed run,
   * because a startup rejection is indistinguishable from any other startup
   * failure — and guessing wrong means passing a mode an administrator turned
   * off on purpose.
   */
  it('refuses auto when managed settings disable it, whatever the plan says', () => {
    const policy = { ...SUBSCRIPTION, autoModeDisabledByPolicy: true };
    expect(claudeAutoModeRefusal(policy)).toBe(CLAUDE_UNSUPPORTED_REASON_KEYS.autoDisabledByPolicy);
    expect(claudePermissionMode('default', 'auto-review', policy)).toBeUndefined();
  });

  it('fails closed when the account could not be established', () => {
    const unknown = { autoModeDisabledByPolicy: false, effectiveDefaultIsAuto: false };
    expect(claudeAutoModeRefusal(unknown)).toBe(CLAUDE_UNSUPPORTED_REASON_KEYS.autoUnverified);
  });

  it('reads disableAutoMode only from the literal the vendor documents', () => {
    expect(readAutoModeDisabled({ disableAutoMode: 'disable' })).toBe(true);
    expect(readAutoModeDisabled({ disableAutoMode: true })).toBe(false);
    expect(readAutoModeDisabled({})).toBe(false);
    expect(readAutoModeDisabled(null)).toBe(false);
  });

  /**
   * The 2026-08-14 flip. The assertion is deliberately "follows the account"
   * rather than a mode string: pinning `manual` would opt every Pro, Max and
   * Team user out of the mode Claude is moving them to, and MangoStudio would be
   * the only place their agent behaved differently.
   */
  it('lets the default level follow the account rather than pinning manual', () => {
    expect(claudeEffectiveDefault(SUBSCRIPTION)).toEqual({ mode: 'manual', canonical: 'default' });
    expect(claudeEffectiveDefault({ ...SUBSCRIPTION, effectiveDefaultIsAuto: true })).toEqual({
      mode: 'auto',
      canonical: 'auto',
    });
  });

  it('keeps policy ahead of the account when the two disagree', () => {
    expect(
      claudeEffectiveDefault({
        ...SUBSCRIPTION,
        effectiveDefaultIsAuto: true,
        autoModeDisabledByPolicy: true,
      })
    ).toEqual({ mode: 'manual', canonical: 'default' });
  });
});

describe('buildSupportedConfigurations', () => {
  function cell(
    configurations: ReturnType<typeof buildSupportedConfigurations>,
    level: string,
    routing: string
  ) {
    return configurations.find(
      (candidate) => candidate.level === level && candidate.routing === routing
    );
  }

  it('returns the whole matrix, refusals included', () => {
    expect(buildSupportedConfigurations(SUBSCRIPTION)).toHaveLength(6);
  });

  it('persists the canonical default rather than the CLI alias', () => {
    const configurations = buildSupportedConfigurations(SUBSCRIPTION);
    expect(cell(configurations, 'default', 'user')).toMatchObject({
      supported: true,
      vendorId: 'default',
    });
  });

  it('explains an unavailable auto instead of quietly dropping it', () => {
    const configurations = buildSupportedConfigurations({
      ...SUBSCRIPTION,
      accountKind: 'api-key',
    });
    expect(cell(configurations, 'default', 'auto-review')).toMatchObject({
      supported: false,
      unsupportedReasonKey: CLAUDE_UNSUPPORTED_REASON_KEYS.autoNeedsSubscription,
    });
  });

  /**
   * `acceptEdits` auto-approves edits with no classifier: a different risk
   * profile under the same label. It is never offered as a stand-in for
   * `default` + `auto-review`.
   */
  it('never substitutes acceptEdits for default plus auto-review', () => {
    const configurations = buildSupportedConfigurations({
      ...SUBSCRIPTION,
      autoModeDisabledByPolicy: true,
    });
    expect(configurations.some((candidate) => candidate.vendorId === 'acceptEdits')).toBe(false);
    expect(cell(configurations, 'default', 'auto-review')?.supported).toBe(false);
  });

  it('marks every unattended combination as unattended', () => {
    const configurations = buildSupportedConfigurations(SUBSCRIPTION);
    expect(cell(configurations, 'full-access', 'user')?.unattended).toBe(true);
    expect(cell(configurations, 'default', 'auto-review')?.unattended).toBe(true);
    expect(cell(configurations, 'read-only', 'user')?.unattended).toBe(false);
  });
});

describe('parseClaudeAuthStatus', () => {
  const SIGNED_IN = JSON.stringify({
    loggedIn: true,
    authMethod: 'claude.ai',
    apiProvider: 'firstParty',
    email: 'someone@example.com',
    orgId: 'c32a94a2-9272-4e9f-ba4f-5d3dcfb32b0a',
    orgName: "someone@example.com's Organization",
    subscriptionType: 'pro',
  });

  /**
   * The status call returns more personal data than any other vendor's. None of
   * the three identifying fields may appear in what crosses to the hub.
   */
  it('keeps the email, org id and org name inside the runtime', () => {
    const result = parseClaudeAuthStatus(SIGNED_IN);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('someone@example.com');
    expect(serialized).not.toContain('c32a94a2');
    expect(serialized).not.toContain('Organization');
  });

  it('returns a recognizable label and the plan tier', () => {
    expect(parseClaudeAuthStatus(SIGNED_IN)).toMatchObject({
      authState: 'signed-in',
      accountKind: 'subscription',
      account: { label: 'Claude account', planType: 'pro' },
    });
  });

  it.each([
    ['claude.ai', 'firstParty', 'subscription'],
    ['apiKey', 'firstParty', 'api-key'],
    ['bedrock', 'amazonBedrock', 'cloud-provider'],
    ['vertex', 'googleVertex', 'cloud-provider'],
  ] as const)('derives %s/%s as %s', (authMethod, apiProvider, kind) => {
    expect(
      parseClaudeAuthStatus(JSON.stringify({ loggedIn: true, authMethod, apiProvider }))
    ).toMatchObject({ accountKind: kind });
  });

  it('treats only an explicit false as signed out', () => {
    expect(parseClaudeAuthStatus('{"loggedIn":false}').authState).toBe('signed-out');
  });

  /**
   * Claude may keep credentials in the system keychain, so anything short of a
   * definite answer stays `unknown` rather than becoming a signed-out verdict
   * the user would have to argue with.
   */
  it.each([
    ['empty output', ''],
    ['prose', 'command not found'],
    ['truncated json', '{"loggedIn":'],
    ['a payload without loggedIn', '{"authMethod":"claude.ai"}'],
  ])('reads %s as unknown', (_label, payload) => {
    expect(parseClaudeAuthStatus(payload).authState).toBe('unknown');
  });

  it('tolerates a warning line printed before the payload', () => {
    expect(parseClaudeAuthStatus(`update available\n${SIGNED_IN}`).authState).toBe('signed-in');
  });
});

describe('version gating', () => {
  it('parses the installed format', () => {
    expect(parseClaudeVersion('2.1.226 (Claude Code)')).toMatchObject({
      major: 2,
      minor: 1,
      patch: 226,
      text: '2.1.226',
    });
  });

  it('refuses a build below the flag floor and allows one above it', () => {
    const minimum = parseClaudeVersion('2.1.211');
    const tooOld = parseClaudeVersion('2.1.205 (Claude Code)');
    const newer = parseClaudeVersion('2.2.0 (Claude Code)');
    if (!minimum || !tooOld || !newer) throw new Error('fixture versions must parse');
    expect(compareClaudeVersions(tooOld, minimum)).toBeLessThan(0);
    expect(compareClaudeVersions(newer, minimum)).toBeGreaterThan(0);
  });

  it('returns undefined rather than guessing at an unreadable version', () => {
    expect(parseClaudeVersion('not a version')).toBeUndefined();
  });
});
