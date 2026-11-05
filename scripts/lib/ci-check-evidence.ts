import Type, { type Static } from 'typebox';
import Value from 'typebox/value';

import { CHECK_RESULT_MAX_BYTES, type CheckResult, parseCheckResult } from './check-result';

const identitySchema = Type.Object(
  {
    repository: Type.String({ pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' }),
    sourceSha: Type.String({ pattern: '^[a-f0-9]{40}$' }),
    runId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    runAttempt: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    invocationId: Type.String({ pattern: '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' }),
  },
  { additionalProperties: false }
);
const diagnosticSchema = Type.Union([
  Type.Object(
    {
      root: Type.String({ minLength: 1 }),
      state: Type.Literal('completed'),
      errors: Type.Integer({ minimum: 0 }),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      root: Type.String({ minLength: 1 }),
      state: Type.Literal('unavailable'),
      reason: Type.String({ minLength: 1, maxLength: 2000 }),
    },
    { additionalProperties: false }
  ),
]);
const evidenceSchema = Type.Object(
  {
    kind: Type.Literal('mangostudio.ci-check-evidence'),
    schemaVersion: Type.Literal(1),
    identity: identitySchema,
    result: Type.Unknown(),
    diagnostics: Type.Array(diagnosticSchema, { maxItems: 64 }),
  },
  { additionalProperties: false }
);

export type CiCheckIdentity = Static<typeof identitySchema>;
export type CheckDiagnostic = Static<typeof diagnosticSchema>;
export interface CiCheckEvidence {
  readonly kind: 'mangostudio.ci-check-evidence';
  readonly schemaVersion: 1;
  readonly identity: CiCheckIdentity;
  readonly result: CheckResult;
  readonly diagnostics: CheckDiagnostic[];
}

/**
 * Validate cross-job evidence against caller-owned Actions facts and expected component roots.
 * @example parseCiCheckEvidence(text, identity, ['apps/api', 'scripts']);
 */
export function parseCiCheckEvidence(
  text: string,
  expected: CiCheckIdentity,
  roots: readonly string[]
): CiCheckEvidence {
  if (Buffer.byteLength(text) > CHECK_RESULT_MAX_BYTES)
    throw new Error(`CI Check evidence exceeds ${CHECK_RESULT_MAX_BYTES} bytes`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      'CI Check evidence: expected complete JSON; received invalid or interrupted report'
    );
  }
  if (!Value.Check(evidenceSchema, parsed))
    throw new Error(
      'CI Check evidence: expected versioned identity, result and diagnostics schema'
    );
  if (!Value.Check(identitySchema, expected))
    throw new Error('CI Check expected identity: received missing or invalid Actions facts');
  for (const key of Object.keys(expected) as (keyof CiCheckIdentity)[]) {
    if (parsed.identity[key] !== expected[key])
      throw new Error(
        `CI Check ${key}: expected ${expected[key]}; received ${parsed.identity[key]}`
      );
  }
  // The enclosing invocation is caller-owned. A self-described invocation from
  // an arbitrary local report is never sufficient cross-job evidence.
  const raw = parsed.result as CheckResult;
  const result = parseCheckResult(JSON.stringify(raw), {
    invocationId: expected.invocationId,
    args: ['--all', '--ci-report'],
    exitCode: raw?.exitCode,
  });
  const actualRoots = parsed.diagnostics.map((entry) => entry.root);
  if (
    new Set(actualRoots).size !== actualRoots.length ||
    JSON.stringify([...actualRoots].sort()) !== JSON.stringify([...roots].sort())
  ) {
    throw new Error(
      `CI Check diagnostics: expected roots ${JSON.stringify(roots)} exactly once; received ${JSON.stringify(actualRoots)}`
    );
  }
  for (const diagnostic of parsed.diagnostics) {
    const label = `typescript:${diagnostic.root.replaceAll('/', ':')}`;
    const task = result.tasks.find((entry) => entry.label === label);
    if (
      !task ||
      (diagnostic.state === 'completed' &&
        (task.state !== 'executed' || (diagnostic.errors === 0) !== (task.exitCode === 0))) ||
      (diagnostic.state === 'unavailable' && task.state !== 'unavailable')
    ) {
      throw new Error(
        `CI Check diagnostics for ${diagnostic.root}: expected matching ${label} task state; received ${JSON.stringify(task)}`
      );
    }
  }
  return { ...parsed, result };
}

/**
 * Extract diagnostics only from one checker's actual captured streams; crashes are unavailable.
 * @example checkerDiagnostic('apps/api', { stdout: '', stderr: '', exitCode: 0 });
 */
export function checkerDiagnostic(
  root: string,
  output: { readonly stdout: string; readonly stderr: string; readonly exitCode: number }
): CheckDiagnostic {
  const errors = (`${output.stdout}\n${output.stderr}`.match(/error TS\d+:/g) ?? []).length;
  if ((output.exitCode !== 0 && errors === 0) || (output.exitCode === 0 && errors !== 0)) {
    return {
      root,
      state: 'unavailable',
      reason: `bun check for ${root}: expected diagnostics consistent with exit; received exit ${output.exitCode}, ${errors} diagnostics`,
    };
  }
  return { root, state: 'completed', errors };
}

/**
 * Bind one supervised checker worker's receipt to its caller and observed exit.
 * @example parseCheckerReceipt(text, 'apps/api', invocationId, 0);
 */
export function parseCheckerReceipt(
  text: string,
  root: string,
  invocationId: string,
  observedExit: number
): CheckDiagnostic {
  if (Buffer.byteLength(text) > CHECK_RESULT_MAX_BYTES)
    throw new Error('TypeScript receipt exceeds size limit');
  const schema = Type.Object(
    {
      invocationId: Type.String(),
      diagnostic: diagnosticSchema,
      exitCode: Type.Integer({ minimum: 0, maximum: 0xffffffff }),
    },
    { additionalProperties: false }
  );
  const parsed: unknown = JSON.parse(text);
  if (!Value.Check(schema, parsed))
    throw new Error('TypeScript receipt: expected invocation, diagnostic and exit schema');
  if (
    parsed.invocationId !== invocationId ||
    parsed.diagnostic.root !== root ||
    parsed.exitCode !== observedExit
  )
    throw new Error(
      `TypeScript receipt: expected ${root} invocation ${invocationId} exit ${observedExit}; received ${JSON.stringify(parsed)}`
    );
  if (
    parsed.diagnostic.state === 'completed' &&
    (parsed.diagnostic.errors === 0) !== (observedExit === 0)
  )
    throw new Error(`TypeScript receipt for ${root}: diagnostics contradict exit ${observedExit}`);
  if (parsed.diagnostic.state === 'unavailable' && observedExit === 0)
    throw new Error(`TypeScript receipt for ${root}: unavailable diagnostics with successful exit`);
  return parsed.diagnostic;
}
