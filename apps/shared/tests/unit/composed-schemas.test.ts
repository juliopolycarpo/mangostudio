/**
 * Behavior of every production `Type.Composite` shape, pinned as a table.
 *
 * Composition is the schema operator most exposed to a TypeBox major: the
 * required set, the optional set, and `additionalProperties` of a composed
 * object are all derived rather than written down, so a change in how the
 * operator folds its members silently reshapes eight public contracts at once.
 * Each case therefore states the folded result explicitly — what is required,
 * what stays optional, and whether unknown keys survive — instead of trusting
 * that reading the members back would produce it.
 *
 * The assertions stay on `Value.Check` and the stable JSON Schema keywords a
 * consumer can see. TypeBox's internal annotations are deliberately not
 * snapshotted: they are not the contract, and pinning them turns every upstream
 * patch release into a failing suite.
 */

import { describe, expect, it } from 'bun:test';
import type { Static, TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

import type {
  AgentCliStatus,
  InstallBlockedResponse,
  RuntimePairingIssue,
} from '../../src/environments';
import {
  AgentCliStatusSchema,
  InstallBlockedResponseSchema,
  RuntimePairingIssueSchema,
} from '../../src/environments';
import type {
  PropagationBackupSet,
  PropagationUndo,
  StagedRemovalLeftover,
} from '../../src/library';
import {
  PropagationBackupSetSchema,
  PropagationUndoSchema,
  StagedRemovalLeftoverSchema,
} from '../../src/library';
import type { RuleFilePreviewResponse } from '../../src/prompt-rules';
import { RuleFilePreviewResponseSchema } from '../../src/prompt-rules';
import type { RealtimeErrorMessage } from '../../src/realtime';
import { RealtimeErrorMessageSchema } from '../../src/realtime';

/**
 * A composed schema and the folded shape it must keep producing.
 *
 * `base` doubles as the `Static<>` conformance check: each fixture is annotated
 * with the derived type, so a composition that stops producing that type fails
 * the typecheck rather than the assertion.
 */
interface CompositeCase<Base extends object> {
  readonly name: string;
  readonly schema: TSchema;
  /** The minimal value carrying every required field and no optional one. */
  readonly base: Base;
  /** Optional fields, applied over `base`, that must still validate. */
  readonly optionalFields: Record<string, unknown>;
  /** Required keys after folding, in the order the composed schema lists them. */
  readonly required: readonly string[];
  /** Declared keys after folding, required and optional together. */
  readonly properties: readonly string[];
  /** `false` when unknown keys are rejected, `undefined` when they survive. */
  readonly additionalProperties: false | undefined;
  /** Field-level rejections proving inherited constraints still bite. */
  readonly invalid: InvalidCase[];
}

interface InvalidCase {
  readonly why: string;
  readonly patch: object;
}

/**
 * Erase the fixture's own type into the table's row type.
 *
 * The `Static<>` conformance is enforced where each fixture is declared — every
 * `base` above is annotated with the schema's exported type — so the table only
 * needs the value to be spreadable.
 */
function compositeCase<T extends TSchema, Base extends Static<T> & object>(
  value: CompositeCase<Base> & { readonly schema: T }
): CompositeCase<object> {
  return value;
}

const REALTIME_ERROR: RealtimeErrorMessage = {
  type: 'error',
  error: 'Unauthorized',
  code: 'UNAUTHORIZED',
};

const RULE_FILE_PREVIEW: RuleFilePreviewResponse = {
  label: 'AGENTS.md',
  path: '/repo/AGENTS.md',
  exists: true,
  readable: true,
  truncated: false,
};

const PAIRING_ISSUE: RuntimePairingIssue = {
  environmentId: 'workshop',
  createdAt: 1_700_000_000_000,
  lastSeenAt: null,
  token: 'mrt_public.secret',
};

const AGENT_CLI_STATUS: AgentCliStatus = {
  id: 'claude',
  health: 'ok',
  installations: [
    {
      path: '/usr/local/bin/claude',
      rawPath: '/usr/local/bin/claude',
      version: '1.2.3',
      origin: 'path',
      effective: true,
    },
  ],
  findings: [],
  installable: true,
  probedAtMs: 1_700_000_000_000,
  targetId: 'claude',
  configHome: '/home/runner/.claude',
  configHomeExists: true,
  authenticated: true,
  authSignal: 'file-present',
  locations: [],
};

const INSTALL_BLOCKED: InstallBlockedResponse = {
  error: 'This recipe cannot run on this machine',
  recipe: {
    id: 'bun.install.official',
    runtimeId: 'bun',
    action: 'install',
    inputKind: 'none',
    platforms: ['linux'],
    argv: ['bash', '-lc', 'true'],
    copyCommand: 'curl -fsSL https://bun.sh/install | bash',
    requires: [],
    writes: ['~/.bun'],
    networkAccess: true,
    timeoutMs: 600_000,
    supported: true,
    missingRequirements: [],
    guard: { allowed: false, reasons: [] },
  },
};

const PROPAGATION_UNDO: PropagationUndo = {
  backupId: 'backup-1',
  restored: [{ locationId: 'claude-skills', destinationPath: '/home/runner/.claude/skills' }],
  removed: [],
  skipped: [],
  environmentId: 'workshop',
};

const PROPAGATION_BACKUP_SET: PropagationBackupSet = {
  backupId: 'backup-1',
  createdAtMs: 1_700_000_000_000,
  sizeBytes: 4_096,
  entryCount: 2,
  pinned: false,
  lastCopyResourceKeys: [],
  operation: 'propagation',
  resourceKeys: ['skill:review'],
  evictsNext: false,
  manifestReadable: true,
  environmentId: 'workshop',
  availability: 'available',
};

const STAGED_REMOVAL_LEFTOVER: StagedRemovalLeftover = {
  locationId: 'claude-skills',
  path: '/home/runner/.claude/skills/.mango-staged-abc',
  modifiedAtMs: 1_700_000_000_000,
  environmentId: 'workshop',
};

const CASES: CompositeCase<object>[] = [
  compositeCase({
    name: 'RealtimeErrorMessageSchema',
    schema: RealtimeErrorMessageSchema,
    base: REALTIME_ERROR,
    optionalFields: { details: { reason: 'expired' } },
    required: ['type', 'error'],
    properties: ['type', 'error', 'code', 'details'],
    // The only composite that states `additionalProperties` on the call itself.
    additionalProperties: false,
    invalid: [
      { why: 'the discriminating literal is wrong', patch: { type: 'warning' } },
      { why: 'an inherited required field is missing', patch: { error: undefined } },
      { why: 'an inherited field has the wrong type', patch: { error: 42 } },
      { why: 'an inherited optional field has the wrong type', patch: { code: 7 } },
      { why: 'the inherited record rejects a non-string value', patch: { details: { a: 1 } } },
    ],
  }),
  compositeCase({
    name: 'RuleFilePreviewResponseSchema',
    schema: RuleFilePreviewResponseSchema,
    base: RULE_FILE_PREVIEW,
    optionalFields: { kind: 'agents', sizeBytes: 128, error: 'unreadable', content: '# Rules' },
    required: ['label', 'path', 'exists', 'readable', 'truncated'],
    properties: [
      'kind',
      'label',
      'path',
      'exists',
      'readable',
      'sizeBytes',
      'error',
      'content',
      'truncated',
    ],
    additionalProperties: undefined,
    invalid: [
      { why: 'an inherited required field is missing', patch: { label: undefined } },
      { why: 'the added required field is missing', patch: { truncated: undefined } },
      { why: 'the added field has the wrong type', patch: { truncated: 'no' } },
      { why: 'an inherited optional union is not a member', patch: { kind: 'cursor' } },
      { why: 'an inherited numeric bound is violated', patch: { sizeBytes: -1 } },
    ],
  }),
  compositeCase({
    name: 'RuntimePairingIssueSchema',
    schema: RuntimePairingIssueSchema,
    base: PAIRING_ISSUE,
    optionalFields: {},
    required: ['environmentId', 'createdAt', 'lastSeenAt', 'token'],
    properties: ['environmentId', 'createdAt', 'lastSeenAt', 'token'],
    // Characterized, not endorsed: both members declare
    // `additionalProperties: false`, and the composition drops it. See the
    // dedicated test below.
    additionalProperties: undefined,
    invalid: [
      { why: 'the added secret is missing', patch: { token: undefined } },
      { why: 'the added secret is empty', patch: { token: '' } },
      { why: 'an inherited id violates its pattern', patch: { environmentId: 'Workshop' } },
      { why: 'an inherited integer bound is violated', patch: { createdAt: -1 } },
      { why: 'an inherited nullable field is neither member', patch: { lastSeenAt: 'never' } },
    ],
  }),
  compositeCase({
    name: 'AgentCliStatusSchema',
    schema: AgentCliStatusSchema,
    base: AGENT_CLI_STATUS,
    optionalFields: {
      effective: {
        path: '/usr/local/bin/claude',
        rawPath: '/usr/local/bin/claude',
        version: '1.2.3',
        origin: 'path',
        effective: true,
      },
    },
    required: [
      'id',
      'health',
      'installations',
      'findings',
      'installable',
      'probedAtMs',
      'targetId',
      'configHome',
      'configHomeExists',
      'authenticated',
      'authSignal',
      'locations',
    ],
    properties: [
      'id',
      'health',
      'installations',
      'effective',
      'findings',
      'installable',
      'probedAtMs',
      'targetId',
      'configHome',
      'configHomeExists',
      'authenticated',
      'authSignal',
      'locations',
    ],
    additionalProperties: undefined,
    invalid: [
      { why: 'an inherited union is not a member', patch: { health: 'degraded' } },
      { why: 'an inherited required array is missing', patch: { installations: undefined } },
      { why: 'the added target union is not a member', patch: { targetId: 'aider' } },
      { why: 'the added auth signal is not a member', patch: { authSignal: 'maybe' } },
      { why: 'the added required field is missing', patch: { configHome: undefined } },
      { why: 'an inherited nested array element is malformed', patch: { installations: [{}] } },
    ],
  }),
  compositeCase({
    name: 'InstallBlockedResponseSchema',
    schema: InstallBlockedResponseSchema,
    base: INSTALL_BLOCKED,
    optionalFields: { code: 'INSTALL_BLOCKED', details: { reason: 'guard' } },
    required: ['error', 'recipe'],
    properties: ['error', 'code', 'details', 'recipe'],
    additionalProperties: undefined,
    invalid: [
      { why: 'the inherited error message is missing', patch: { error: undefined } },
      { why: 'the added recipe is missing', patch: { recipe: undefined } },
      { why: 'the inherited optional code has the wrong type', patch: { code: 500 } },
      {
        why: 'the added recipe is not a recipe',
        patch: { recipe: { id: 'bun.install.official' } },
      },
    ],
  }),
  compositeCase({
    name: 'PropagationUndoSchema',
    schema: PropagationUndoSchema,
    base: PROPAGATION_UNDO,
    optionalFields: {},
    required: ['backupId', 'restored', 'removed', 'skipped', 'environmentId'],
    properties: ['backupId', 'restored', 'removed', 'skipped', 'environmentId'],
    additionalProperties: undefined,
    invalid: [
      { why: 'the added machine id is missing', patch: { environmentId: undefined } },
      { why: 'the added machine id violates its pattern', patch: { environmentId: 'Workshop' } },
      { why: 'an inherited required array is missing', patch: { removed: undefined } },
      { why: 'an inherited array element is malformed', patch: { restored: [{ locationId: '' }] } },
      {
        why: 'an inherited skip reason is not a member',
        patch: { skipped: [{ locationId: 'x', destinationPath: '/x', reason: 'because' }] },
      },
    ],
  }),
  compositeCase({
    name: 'PropagationBackupSetSchema',
    schema: PropagationBackupSetSchema,
    base: PROPAGATION_BACKUP_SET,
    optionalFields: {},
    required: [
      'backupId',
      'createdAtMs',
      'sizeBytes',
      'entryCount',
      'pinned',
      'lastCopyResourceKeys',
      'operation',
      'resourceKeys',
      'evictsNext',
      'manifestReadable',
      'environmentId',
      'availability',
    ],
    properties: [
      'backupId',
      'createdAtMs',
      'sizeBytes',
      'entryCount',
      'pinned',
      'lastCopyResourceKeys',
      'operation',
      'resourceKeys',
      'evictsNext',
      'manifestReadable',
      'environmentId',
      'availability',
    ],
    additionalProperties: undefined,
    invalid: [
      { why: 'the added availability code is not a member', patch: { availability: 'maybe' } },
      { why: 'the added machine id is missing', patch: { environmentId: undefined } },
      { why: 'an inherited operation label is not a member', patch: { operation: 'restore' } },
      { why: 'an inherited integer bound is violated', patch: { sizeBytes: -1 } },
      { why: 'an inherited integer is fractional', patch: { entryCount: 1.5 } },
      { why: 'an inherited required flag is missing', patch: { manifestReadable: undefined } },
    ],
  }),
  compositeCase({
    name: 'StagedRemovalLeftoverSchema',
    schema: StagedRemovalLeftoverSchema,
    base: STAGED_REMOVAL_LEFTOVER,
    optionalFields: {},
    required: ['locationId', 'path', 'modifiedAtMs', 'environmentId'],
    properties: ['locationId', 'path', 'modifiedAtMs', 'environmentId'],
    additionalProperties: undefined,
    invalid: [
      { why: 'the added machine id is missing', patch: { environmentId: undefined } },
      { why: 'an inherited path is empty', patch: { path: '' } },
      { why: 'an inherited timestamp is negative', patch: { modifiedAtMs: -1 } },
      { why: 'an inherited location id is empty', patch: { locationId: '' } },
    ],
  }),
];

/** Apply a patch, treating an explicit `undefined` as "delete this key". */
function patched(base: object, patch: object): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete result[key];
    else result[key] = value;
  }
  return result;
}

/** Read a stable JSON Schema keyword without asserting TypeBox's own annotations. */
function keyword<T>(schema: TSchema, name: string): T {
  return (schema as unknown as Record<string, T>)[name] as T;
}

describe.each(CASES)('$name', (testCase) => {
  it('accepts the minimal value carrying only required fields', () => {
    expect(Value.Check(testCase.schema, testCase.base)).toBe(true);
  });

  it('keeps every optional field optional', () => {
    // Both directions in one case: the base above already omits them all, and
    // supplying them together must not conflict with the inherited members.
    expect(Value.Check(testCase.schema, { ...testCase.base, ...testCase.optionalFields })).toBe(
      true
    );
  });

  it('folds the member required and property sets', () => {
    expect(keyword<string>(testCase.schema, 'type')).toBe('object');
    expect(keyword<string[]>(testCase.schema, 'required')).toEqual([...testCase.required]);
    expect(Object.keys(keyword<object>(testCase.schema, 'properties'))).toEqual([
      ...testCase.properties,
    ]);
  });

  it('keeps its unknown-key policy', () => {
    expect(keyword<unknown>(testCase.schema, 'additionalProperties')).toBe(
      testCase.additionalProperties
    );
    const withUnknown = { ...testCase.base, mangoUnexpectedKey: 'x' };
    expect(Value.Check(testCase.schema, withUnknown)).toBe(testCase.additionalProperties !== false);
  });

  it.each(testCase.invalid)('rejects a value where $why', ({ patch }) => {
    expect(Value.Check(testCase.schema, patched(testCase.base as object, patch))).toBe(false);
  });
});

describe('Type.Composite unknown-key inheritance', () => {
  it('does not inherit a member additionalProperties: false', () => {
    // Pinned because it is surprising, not because it is desired.
    // `RuntimePairingTokenSchema` and the inline object composed with it both
    // declare `{ additionalProperties: false }`, yet the composed response
    // accepts unknown keys — the operator folds properties and required, and
    // drops everything else unless the call site restates it, the way
    // `RealtimeErrorMessageSchema` does.
    //
    // If a TypeBox major starts propagating member strictness, this case flips
    // and three currently-permissive response contracts silently tighten.
    const strictMember = { environmentId: 'workshop', createdAt: 1, lastSeenAt: null };

    expect(Value.Check(RuntimePairingIssueSchema, { ...strictMember, token: 't', extra: 1 })).toBe(
      true
    );
    expect(Value.Check(RealtimeErrorMessageSchema, { ...REALTIME_ERROR, extra: 1 })).toBe(false);
  });
});
