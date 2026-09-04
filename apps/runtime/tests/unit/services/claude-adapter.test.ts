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
import {
  buildTurnArgv,
  safeClaudeModel,
} from '../../../src/services/external-agents/claude/adapter';
import { parseClaudeAuthStatus } from '../../../src/services/external-agents/claude/auth';
import {
  claudeAcceptedModes,
  isUsableClaudeCliSurface,
  missingClaudeCliFlags,
  parseClaudeCliSurface,
} from '../../../src/services/external-agents/claude/cli-surface';
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
import { claudeManagedSettingsPath } from '../../../src/services/external-agents/claude/pinned';
import {
  compareClaudeVersions,
  parseClaudeVersion,
} from '../../../src/services/external-agents/claude/version';
import { CLAUDE_HELP_TEXT } from '../../support/claude-help';

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

  /**
   * Claude advertises no catalog, so a requested model reaches argv unvetted.
   * An argv array stops *shell* injection, not **argument** injection: a value
   * beginning with `-` is read by the CLI's parser as a new flag.
   */
  it('never lets a model value become another flag', () => {
    const hostile = argv({
      ...base,
      configuration: { ...CONFIGURATION, model: '--dangerously-skip-permissions' },
    });
    expect(hostile).not.toContain('--model');
    expect(hostile.join(' ')).not.toContain('dangerously-skip-permissions');
  });

  /**
   * `--effort` is admitted by membership in what the binary printed, not by
   * pattern. The vendor publishes the complete list, so there is no reason to
   * accept a shape and hope — and a stored per-chat effort outlives the install
   * that produced it, which is exactly when a downgrade would otherwise put an
   * unknown token on the command line.
   */
  it('passes an effort level this build declared', () => {
    const withEffort = argv({
      ...base,
      session: { ...base.session, acceptedEfforts: new Set(['low', 'high']) },
      configuration: { ...CONFIGURATION, effort: 'high' },
    });

    expect(withEffort[withEffort.indexOf('--effort') + 1]).toBe('high');
  });

  it('drops an effort level this build did not declare', () => {
    expect(
      argv({
        ...base,
        session: { ...base.session, acceptedEfforts: new Set(['low', 'high']) },
        configuration: { ...CONFIGURATION, effort: 'ultracode' },
      })
    ).not.toContain('--effort');
  });

  /**
   * The flag is pinning, not a fix: 2.1.260 with the default `host` and stdin
   * closed already denies immediately rather than parking. What it buys is that
   * the property survives another default change.
   */
  it('tells a build that offers the flag that nobody answers prompts', () => {
    const pinned = argv({ ...base, session: { ...base.session, declaresPermissionPrompts: true } });

    expect(pinned[pinned.indexOf('--permission-prompts') + 1]).toBe('none');
  });

  it('never claims a host answers prompts, because none does', () => {
    // `host` promises an answering SDK host. `interactiveApprovals` is false,
    // so saying it would park every approval-needing turn until the timeout.
    expect(
      argv({ ...base, session: { ...base.session, declaresPermissionPrompts: true } })
    ).not.toContain('host');
  });

  it('omits the flag on a build that does not declare it', () => {
    // 2.1.211–2.1.258. An undeclared flag is a startup failure on every turn.
    expect(argv(base)).not.toContain('--permission-prompts');
  });

  it('passes no effort at all to a build that declared none', () => {
    // Every build before 2.1.259. Absent is not empty, and it is the reason a
    // chat that stored an effort keeps working after a downgrade.
    expect(argv({ ...base, configuration: { ...CONFIGURATION, effort: 'high' } })).not.toContain(
      '--effort'
    );
  });
});

describe('safeClaudeModel', () => {
  it.each(['claude-sonnet-5', 'opus', 'anthropic.claude-3@20240229', 'us.anthropic/claude'])(
    'accepts %s',
    (model) => {
      expect(safeClaudeModel(model)).toBe(model);
    }
  );

  it.each([
    ['a leading dash', '--permission-mode'],
    ['a single dash', '-p'],
    ['an embedded space', 'sonnet --bare'],
    ['a shell metacharacter', 'sonnet;rm -rf /'],
    ['a newline', 'sonnet\n--bare'],
    ['an empty string', ''],
  ])('drops %s', (_label, model) => {
    expect(safeClaudeModel(model)).toBeUndefined();
  });

  it('drops an absurdly long value rather than passing it on', () => {
    expect(safeClaudeModel('a'.repeat(500))).toBeUndefined();
  });
});

describe('claudeManagedSettingsPath', () => {
  it('reads the Windows location from the environment', () => {
    // Relocatable, and the failure is silent and unsafe: an unreadable path is
    // caught, reads as "no policy", and leaves `auto` available for an account
    // whose administrator disabled it.
    expect(claudeManagedSettingsPath('win32', { PROGRAMDATA: 'D:\\Corp\\ProgramData' })).toBe(
      'D:\\Corp\\ProgramData\\ClaudeCode\\managed-settings.json'
    );
  });

  it('falls back to the conventional Windows location', () => {
    expect(claudeManagedSettingsPath('win32', {})).toBe(
      'C:\\ProgramData\\ClaudeCode\\managed-settings.json'
    );
  });

  it.each([
    ['darwin', '/Library/Application Support/ClaudeCode/managed-settings.json'],
    ['linux', '/etc/claude-code/managed-settings.json'],
  ] as const)('uses the documented %s location', (platform, expected) => {
    expect(claudeManagedSettingsPath(platform, {})).toBe(expected);
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

/**
 * The probe that made the version comparison above a fallback rather than the
 * gate. What the adapter needs to know is whether a flag exists, and `--help`
 * answers that directly.
 */
describe('the CLI surface probe', () => {
  const surface = parseClaudeCliSurface(CLAUDE_HELP_TEXT);

  it('finds every flag the turn argv passes', () => {
    expect(missingClaudeCliFlags(surface)).toEqual([]);
    expect(isUsableClaudeCliSurface(surface)).toBe(true);
  });

  it('reads the permission modes out of a wrapped choice list', () => {
    expect([...surface.permissionModes].sort()).toEqual([
      'acceptEdits',
      'auto',
      'bypassPermissions',
      'dontAsk',
      'manual',
      'plan',
    ]);
  });

  /**
   * The input is a subprocess's stdout, so "the vendor would never print that"
   * is not something this parser gets to rely on.
   *
   * Both shapes are here because the first fix only covered one of them. A
   * regex ending in a required `)` reruns its inner scan from every position
   * that starts `(choices:`, so repeating that prefix is quadratic even after
   * the `\s*`/`[^)]` overlap is gone. Only scanning with `indexOf` removes
   * both, and doubling the input has to stay roughly linear for that to hold.
   */
  it.each([
    ['one long unterminated run', (n: number) => `(choices:${' '.repeat(n)}`],
    ['a repeated unterminated prefix', (n: number) => '(choices:'.repeat(n)],
  ])('stays linear on %s', (_label, build) => {
    const line = (n: number) => `  --permission-mode <mode>   ${build(n)}`;
    const time = (n: number) => {
      const started = performance.now();
      expect(parseClaudeCliSurface(line(n)).permissionModes.size).toBe(0);
      return performance.now() - started;
    };

    time(8_000);
    expect(time(64_000)).toBeLessThan(1_000);
  });

  /**
   * `--forward-subagent-text`'s own description names `--output-format`, and an
   * option whose flags wrap puts its description on the following line. A
   * parser that scanned for `--token` anywhere would report both as declared
   * options and would therefore never notice a flag going away.
   */
  it('does not mistake a flag named in prose for one the binary offers', () => {
    const help = [
      'Options:',
      '  --keep <value>                        Mentions --removed in passing',
      '      and wraps onto a continuation line naming --alsoNotReal',
    ].join('\n');
    const parsed = parseClaudeCliSurface(help);

    expect(parsed.flags.has('--keep')).toBe(true);
    expect(parsed.flags.has('--removed')).toBe(false);
    expect(parsed.flags.has('--alsoNotReal')).toBe(false);
  });

  it('reports exactly the required flags a build dropped', () => {
    const trimmed = parseClaudeCliSurface(
      CLAUDE_HELP_TEXT.replace(/^ {2}--forward-subagent-text.*$/m, '  --something-else  Other')
    );

    expect(missingClaudeCliFlags(trimmed)).toEqual(['--forward-subagent-text']);
  });

  /**
   * A spawn that produced nothing must not read as "this build has no options".
   * Treating it that way would grey out a working install whenever a probe was
   * flaky, so callers fall back to the pin instead.
   */
  it('refuses to treat unreadable output as a binary with nothing in it', () => {
    expect(isUsableClaudeCliSurface(parseClaudeCliSurface(''))).toBe(false);
    expect(isUsableClaudeCliSurface(parseClaudeCliSurface('command not found'))).toBe(false);
  });
});

describe('permission modes are narrowed to what the build accepts', () => {
  const accepted = (...modes: readonly string[]) => ({
    ...SUBSCRIPTION,
    acceptedModes: new Set(modes),
  });

  it('refuses a combination whose mode this build does not list', () => {
    const configurations = buildSupportedConfigurations(accepted('plan', 'bypassPermissions'));
    const byPair = new Map(
      configurations.map((entry) => [`${entry.level}/${entry.routing}`, entry])
    );

    // `manual` is gone, so the pair that needs it is refused with a reason
    // rather than passed to a CLI that would reject it at startup.
    expect(byPair.get('default/user')).toMatchObject({
      supported: false,
      unsupportedReasonKey: CLAUDE_UNSUPPORTED_REASON_KEYS.modeMissing,
    });
    expect(byPair.get('read-only/user')?.supported).toBe(true);
    expect(byPair.get('full-access/user')?.supported).toBe(true);
  });

  it('narrows nothing when the probe could not answer', () => {
    const configurations = buildSupportedConfigurations(SUBSCRIPTION);
    expect(configurations.filter((entry) => entry.supported)).not.toHaveLength(0);
  });

  it('tolerates modes this runtime never passes', () => {
    const configurations = buildSupportedConfigurations(
      accepted('plan', 'manual', 'bypassPermissions', 'somethingCursorAdded')
    );
    expect(configurations.filter((entry) => entry.supported)).toHaveLength(3);
  });

  /**
   * The build whose flags are all there and whose choice list is not: a
   * `(choices: …)` that moved, wrapped differently, or was dropped from the
   * help text. That parses as a usable surface with no modes, and passing the
   * empty set on as authoritative would reject every mode and grey out a binary
   * that can run all of them. An unread vocabulary narrows nothing.
   */
  it('narrows nothing when the flags are all present but no choice list parsed', () => {
    const help = CLAUDE_HELP_TEXT.replace(/\(choices:[^)]*\)/g, '');
    const surface = parseClaudeCliSurface(help);

    expect(missingClaudeCliFlags(surface)).toEqual([]);
    expect(surface.permissionModes.size).toBe(0);
    expect(claudeAcceptedModes(surface)).toBeUndefined();

    const configurations = buildSupportedConfigurations({
      ...SUBSCRIPTION,
      ...(claudeAcceptedModes(surface) ? { acceptedModes: claudeAcceptedModes(surface) } : {}),
    });
    expect(configurations.filter((entry) => entry.supported)).not.toHaveLength(0);
  });

  it('still narrows on a surface that did declare its modes', () => {
    const surface = parseClaudeCliSurface(CLAUDE_HELP_TEXT);
    expect(claudeAcceptedModes(surface)).toEqual(surface.permissionModes);
  });
});
