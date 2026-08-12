import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  EXTERNAL_APPROVAL_ROUTINGS,
  EXTERNAL_PERMISSION_LEVELS,
} from '@mangostudio/shared/external-agents';
import type { ExternalAgentAdapter } from '../../../src/services/external-agents/adapter';
import {
  CODEX_OPT_OUT_FAMILY_METHODS,
  CodexAppServerAdapter,
  optOutNotificationMethods,
} from '../../../src/services/external-agents/codex/adapter';
import {
  CODEX_ERROR_CODES,
  planCodexServerRequest,
  refuseHostToolCall,
} from '../../../src/services/external-agents/codex/approvals';
import {
  buildSupportedConfigurations,
  CODEX_PERMISSION_PROFILE_IDS,
  encodeApprovalPolicy,
  encodeApprovalsReviewer,
} from '../../../src/services/external-agents/codex/permissions';
import {
  CODEX_OPT_OUT_NOTIFICATION_METHODS,
  CODEX_OPT_OUT_NOTIFICATION_PREFIXES,
  CODEX_PROTOCOL_PACKAGE,
  CODEX_PROTOCOL_PACKAGE_SPEC,
  MINIMUM_CODEX_VERSION,
} from '../../../src/services/external-agents/codex/pinned';
import type { SandboxMode } from '../../../src/services/external-agents/codex/protocol/v2/SandboxMode';
import type { SandboxPolicy } from '../../../src/services/external-agents/codex/protocol/v2/SandboxPolicy';
import {
  encodeThreadSandboxMode,
  encodeTurnSandboxPolicy,
} from '../../../src/services/external-agents/codex/sandbox';
import {
  compareCodexVersions,
  isCodexVersionSupported,
  parseCodexVersion,
  requireCodexVersion,
} from '../../../src/services/external-agents/codex/version';
import { assertExternalAgentAdapterConformance } from '../../../src/services/external-agents/registry';
import { commandApprovalParams, permissionProfiles } from '../../support/codex-fixtures';

describe('the two sandbox encoders are not interchangeable', () => {
  it('encodes thread/start as a kebab-case string and turn/start as a tagged object', () => {
    expect(encodeThreadSandboxMode('read-only')).toBe('read-only');
    expect(encodeThreadSandboxMode('default')).toBe('workspace-write');
    expect(encodeThreadSandboxMode('full-access')).toBe('danger-full-access');

    expect(encodeTurnSandboxPolicy('read-only', [])).toEqual({
      type: 'readOnly',
      networkAccess: false,
    });
    expect(encodeTurnSandboxPolicy('default', ['/workspace'])).toEqual({
      type: 'workspaceWrite',
      writableRoots: ['/workspace'],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    });
    expect(encodeTurnSandboxPolicy('full-access', [])).toEqual({ type: 'dangerFullAccess' });
  });

  it('does not type-check a SandboxMode where a SandboxPolicy belongs', () => {
    const mode: SandboxMode = encodeThreadSandboxMode('read-only');
    const policy: SandboxPolicy = encodeTurnSandboxPolicy('read-only', []);

    // The trap this whole module exists for. Sending the string form to
    // `turn/start` fails at runtime with `invalid type: string "read-only",
    // expected internally tagged enum SandboxPolicyDeserialize`; these two
    // assertions make it fail at build time instead. If either line ever stops
    // erroring, the shapes have converged and the guard is gone.
    // @ts-expect-error a SandboxMode is a string and can never be a SandboxPolicy
    const wrongWay: SandboxPolicy = mode;
    // @ts-expect-error a SandboxPolicy is an object and can never be a SandboxMode
    const alsoWrong: SandboxMode = policy;

    expect(wrongWay).toBeDefined();
    expect(alsoWrong).toBeDefined();
  });

  it('never leaves network access to a vendor default', () => {
    const readOnly = encodeTurnSandboxPolicy('read-only', []);
    const workspace = encodeTurnSandboxPolicy('default', ['/workspace']);
    expect(readOnly).toHaveProperty('networkAccess', false);
    expect(workspace).toHaveProperty('networkAccess', false);
  });
});

describe('permissions — D4 as Codex fields', () => {
  it('pairs each level with the approval policy that matches its promise', () => {
    expect(encodeApprovalPolicy('read-only')).toBe('on-request');
    expect(encodeApprovalPolicy('default')).toBe('on-request');
    expect(encodeApprovalPolicy('full-access')).toBe('never');
  });

  it('maps routing onto the reviewer, never the legacy guardian subagent', () => {
    expect(encodeApprovalsReviewer('user')).toBe('user');
    expect(encodeApprovalsReviewer('auto-review')).toBe('auto_review');
  });

  it('returns the full 2 x 3 matrix when every profile is allowed', () => {
    const configurations = buildSupportedConfigurations(permissionProfiles());
    expect(configurations).toHaveLength(
      EXTERNAL_PERMISSION_LEVELS.length * EXTERNAL_APPROVAL_ROUTINGS.length
    );
    expect(configurations.every((entry) => entry.supported)).toBe(true);
  });

  it('treats a profile the vendor did not list exactly like a disallowed one', () => {
    const configurations = buildSupportedConfigurations([
      { id: ':read-only', description: null, allowed: true },
    ]);
    const unsupported = configurations.filter((entry) => !entry.supported);
    expect(unsupported.map((entry) => entry.level)).toEqual([
      'default',
      'default',
      'full-access',
      'full-access',
    ]);
  });

  it('marks unattended combinations so the UI can warn', () => {
    const configurations = buildSupportedConfigurations(permissionProfiles());
    const attended = configurations.filter((entry) => !entry.unattended);
    expect(attended.map((entry) => `${entry.level}/${entry.routing}`)).toEqual([
      'read-only/user',
      'default/user',
    ]);
  });

  it('names the built-in profile each level selects', () => {
    expect(CODEX_PERMISSION_PROFILE_IDS).toEqual({
      'read-only': ':read-only',
      default: ':workspace',
      'full-access': ':danger-full-access',
    });
  });
});

describe('server requests — the refusal table', () => {
  it('refuses item/tool/call unconditionally', () => {
    const plan = planCodexServerRequest('item/tool/call', { tool: 'anything' }, 'req-1', 0);
    expect(plan).toMatchObject({
      outcome: 'refuse',
      code: CODEX_ERROR_CODES.methodNotSupported,
    });
    expect(refuseHostToolCall().outcome).toBe('refuse');
  });

  it('answers the v1 approval requests with an error, as a v2 client should', () => {
    for (const method of ['applyPatchApproval', 'execCommandApproval']) {
      expect(planCodexServerRequest(method, {}, 'req-1', 0)).toMatchObject({ outcome: 'refuse' });
    }
  });

  it('refuses credential-shaped requests it never opted into', () => {
    for (const method of ['attestation/generate', 'account/chatgptAuthTokens/refresh']) {
      expect(planCodexServerRequest(method, {}, 'req-1', 0)).toMatchObject({
        outcome: 'refuse',
        message: expect.stringContaining('does not hold or mint Codex credentials'),
      });
    }
  });

  it('refuses an unknown method rather than leaving the vendor unanswered', () => {
    expect(planCodexServerRequest('some/futureRequest', {}, 'req-1', 0)).toMatchObject({
      outcome: 'refuse',
      code: CODEX_ERROR_CODES.methodNotSupported,
    });
  });

  it('offers only the payload-free members of the command decision enum', () => {
    const plan = planCodexServerRequest(
      'item/commandExecution/requestApproval',
      commandApprovalParams('ls'),
      'req-1',
      1_000
    );
    if (plan.outcome !== 'approval') throw new Error('expected an approval');
    expect(plan.request.options.map((option) => option.id)).toEqual([
      'accept',
      'acceptForSession',
      'decline',
      'cancel',
    ]);
    expect(plan.encode('accept')).toEqual({ decision: 'accept' });
    expect(() => plan.encode('acceptWithExecpolicyAmendment')).toThrow();
  });

  it('echoes back exactly the permissions Codex asked for, never a widened set', () => {
    const plan = planCodexServerRequest(
      'item/permissions/requestApproval',
      {
        threadId: 't',
        turnId: 'u',
        itemId: 'i',
        environmentId: null,
        startedAtMs: 0,
        cwd: '/workspace',
        reason: 'needs network',
        permissions: { network: { allowedDomains: ['example.com'] }, fileSystem: null },
      },
      'req-1',
      1_000
    );
    if (plan.outcome !== 'approval') throw new Error('expected an approval');
    expect(plan.encode('grant:turn')).toEqual({
      permissions: { network: { allowedDomains: ['example.com'] } },
      scope: 'turn',
    });
    expect(plan.encode('deny')).toEqual({ permissions: {}, scope: 'turn' });
  });

  it('refuses a multi-question input form rather than flattening the decision set', () => {
    const plan = planCodexServerRequest(
      'item/tool/requestUserInput',
      {
        threadId: 't',
        turnId: 'u',
        itemId: 'i',
        isBlocking: true,
        autoResolutionMs: null,
        questions: [
          { id: 'a', header: 'A', question: 'A?', isOther: false, isSecret: false, options: [] },
          { id: 'b', header: 'B', question: 'B?', isOther: false, isSecret: false, options: [] },
        ],
      },
      'req-1',
      0
    );
    expect(plan).toMatchObject({ outcome: 'refuse', code: CODEX_ERROR_CODES.invalidRequest });
  });
});

describe('the pinned contract', () => {
  it('gates on a version that is at least the one the contract came from', () => {
    expect(
      compareCodexVersions(
        requireCodexVersion(MINIMUM_CODEX_VERSION),
        requireCodexVersion(CODEX_PROTOCOL_PACKAGE.version)
      )
    ).toBeGreaterThanOrEqual(0);
    expect(CODEX_PROTOCOL_PACKAGE_SPEC).toBe(`@openai/codex@${CODEX_PROTOCOL_PACKAGE.version}`);
    expect(CODEX_PROTOCOL_PACKAGE.integrity).toMatch(/^sha512-/);
  });

  it('reads a version out of every banner form a CLI install might print', () => {
    expect(parseCodexVersion('codex-cli 0.147.0')?.text).toBe('0.147.0');
    expect(parseCodexVersion('0.147.0')?.text).toBe('0.147.0');
    expect(parseCodexVersion('codex 0.148.1-alpha.2')?.text).toBe('0.148.1');
    expect(parseCodexVersion('no version here')).toBeUndefined();
  });

  it('refuses an unreadable version instead of guessing either way', () => {
    const minimum = requireCodexVersion(MINIMUM_CODEX_VERSION);
    expect(isCodexVersionSupported(undefined, minimum)).toBe(false);
    expect(isCodexVersionSupported(parseCodexVersion('0.146.9'), minimum)).toBe(false);
    expect(isCodexVersionSupported(parseCodexVersion('0.147.0'), minimum)).toBe(true);
    expect(isCodexVersionSupported(parseCodexVersion('1.0.0'), minimum)).toBe(true);
  });

  it('opts out of every member of every suppressed family, by exact name', () => {
    // The vendor matches `optOutNotificationMethods` literally — there is no
    // wildcard — so the hand-listed family members must still cover every
    // matching name in the generated union. This reads the generated file
    // rather than a copy of it, so a version bump that adds `app/thing/updated`
    // fails here instead of that notification quietly starting to arrive.
    const generated = readFileSync(
      join(
        import.meta.dir,
        '../../../src/services/external-agents/codex/protocol/ServerNotification.ts'
      ),
      'utf8'
    );
    const declared = new Set(
      [...generated.matchAll(/"method"\s*:\s*"([^"]+)"/g)].map((match) => match[1] as string)
    );
    const shouldSuppress = [...declared].filter((method) =>
      CODEX_OPT_OUT_NOTIFICATION_PREFIXES.some((prefix) => method.startsWith(prefix))
    );
    expect(shouldSuppress.length).toBeGreaterThan(0);

    const optedOut = new Set(optOutNotificationMethods());
    for (const method of shouldSuppress) {
      expect({ method, optedOut: optedOut.has(method) }).toEqual({ method, optedOut: true });
    }
    for (const method of CODEX_OPT_OUT_NOTIFICATION_METHODS) {
      expect(optedOut.has(method)).toBe(true);
    }
    // And every name listed by hand is one the vendor actually declares.
    for (const method of [...CODEX_OPT_OUT_FAMILY_METHODS, ...CODEX_OPT_OUT_NOTIFICATION_METHODS]) {
      expect({ method, declared: declared.has(method) }).toEqual({ method, declared: true });
    }
  });

  it('keeps the vendored contract where the regeneration script writes it', () => {
    const sandbox = readFileSync(
      join(
        import.meta.dir,
        '../../../src/services/external-agents/codex/protocol/v2/SandboxPolicy.ts'
      ),
      'utf8'
    );
    expect(sandbox).toContain('GENERATED CODE! DO NOT MODIFY BY HAND!');
    expect(sandbox).toContain('dangerFullAccess');
  });
});

describe('adapter conformance', () => {
  it('advertises no optional capability it cannot serve', () => {
    const adapter = new CodexAppServerAdapter();
    expect(() =>
      assertExternalAgentAdapterConformance(adapter, {
        structuredStreaming: true,
        reasoningStream: true,
        interactiveApprovals: true,
        resume: true,
        modelCatalog: true,
        images: true,
        usageReporting: true,
        cancellation: true,
        // Codex's own capability set, `steering: true` included: `steer` is
        // implemented, so the flag and the member agree.
        steering: true,
        sessionListing: false,
        nativeReview: false,
        accountUsage: false,
      })
    ).not.toThrow();
  });

  it('implements steer, unlike the three opportunistic capabilities still waiting on their own plans', () => {
    // Typed as the interface so the optional members are visible: the registry
    // derives the four opportunistic capabilities from exactly this presence
    // check.
    const adapter: ExternalAgentAdapter = new CodexAppServerAdapter();
    expect(adapter.steer).toBeInstanceOf(Function);
    expect(adapter.listSessions).toBeUndefined();
    expect(adapter.startReview).toBeUndefined();
    expect(adapter.refreshAccountUsage).toBeUndefined();
  });

  it('refuses to claim session listing while `listSessions` is unimplemented', () => {
    const adapter: ExternalAgentAdapter = new CodexAppServerAdapter();
    expect(() =>
      assertExternalAgentAdapterConformance(adapter, {
        structuredStreaming: true,
        reasoningStream: true,
        interactiveApprovals: true,
        resume: true,
        modelCatalog: true,
        images: true,
        usageReporting: true,
        cancellation: true,
        steering: true,
        sessionListing: true,
        nativeReview: false,
        accountUsage: false,
      })
    ).toThrow(/advertises sessionListing=true/);
  });
});
