// Internal, local Check subprocess result. It is deliberately independent of
// QA artifacts: a caller must supply the invocation identity and observed exit.

import Type, { type Static } from 'typebox';
import Value from 'typebox/value';

const label = Type.String({ pattern: '^[A-Za-z0-9_.:-]+$', maxLength: 200 });
const reason = Type.String({ minLength: 1, maxLength: 2000 });
// Windows process exits can carry the full unsigned 32-bit status.
const exitCode = Type.Integer({ minimum: 0, maximum: 0xffffffff });
const task = Type.Union([
  Type.Object(
    {
      label,
      state: Type.Literal('executed'),
      exitCode,
      durationMs: Type.Integer({ minimum: 0 }),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    { label, state: Type.Literal('unavailable'), reason },
    { additionalProperties: false }
  ),
]);

const CheckResultSchema = Type.Object(
  {
    kind: Type.Literal('mangostudio.check-result'),
    schemaVersion: Type.Literal(1),
    invocationId: Type.String({ pattern: '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' }),
    args: Type.Array(Type.String({ maxLength: 1000 }), { maxItems: 64 }),
    state: Type.Union([Type.Literal('completed'), Type.Literal('unavailable')]),
    exitCode,
    error: Type.Union([reason, Type.Null()]),
    plannedTasks: Type.Array(label, { maxItems: 64 }),
    tasks: Type.Array(task, { maxItems: 64 }),
  },
  { additionalProperties: false }
);

export type CheckResult = Static<typeof CheckResultSchema>;
export type CheckTaskResult = CheckResult['tasks'][number];
export const CHECK_RESULT_MAX_BYTES = 128 * 1024;

/** Facts the local caller supplied or observed, never taken from the report. */
export interface ExpectedCheckResult {
  readonly invocationId: string;
  readonly args: readonly string[];
  readonly exitCode: number;
}

const assertConsistent = (result: CheckResult): void => {
  if (
    new Set(result.plannedTasks).size !== result.plannedTasks.length ||
    result.tasks.length !== result.plannedTasks.length ||
    result.tasks.some((entry, index) => entry.label !== result.plannedTasks[index])
  ) {
    throw new Error('Check result must record every planned task exactly once, in order');
  }
  const unavailable = result.tasks.some((entry) => entry.state === 'unavailable');
  if (
    result.state === 'completed' &&
    result.tasks.length === 0 &&
    !result.args.some((arg) => arg === '--staged' || arg === '--changed')
  ) {
    throw new Error('Completed Check result has no tasks for an unscoped invocation');
  }
  if (result.state === 'completed' && (unavailable || result.error !== null)) {
    throw new Error('Completed Check result contains unavailable tasks or a setup error');
  }
  if (result.state === 'unavailable' && !unavailable && result.error === null) {
    throw new Error('Unavailable Check result has no task or setup reason');
  }
  const failed = result.tasks.some((entry) => entry.state === 'executed' && entry.exitCode !== 0);
  const expectedExit = failed ? 1 : 0;
  if (
    (result.state === 'unavailable' && result.exitCode === 0) ||
    (result.state === 'completed' && result.exitCode !== expectedExit)
  ) {
    throw new Error(`Check result exit ${result.exitCode} contradicts its task results`);
  }
};

/** Validate the complete bounded JSON result and its local invocation identity. */
export const parseCheckResult = (text: string, expected: ExpectedCheckResult): CheckResult => {
  if (Buffer.byteLength(text, 'utf8') > CHECK_RESULT_MAX_BYTES) {
    throw new Error(`Check result exceeds ${CHECK_RESULT_MAX_BYTES} bytes`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Check result is not valid JSON (missing or interrupted report)');
  }
  if (!Value.Check(CheckResultSchema, parsed)) {
    throw new Error('Check result failed schema validation');
  }
  assertConsistent(parsed);
  if (parsed.invocationId !== expected.invocationId) {
    throw new Error('Check result invocation identity does not match the local subprocess');
  }
  if (JSON.stringify(parsed.args) !== JSON.stringify(expected.args)) {
    throw new Error('Check result arguments do not match the local subprocess');
  }
  if (parsed.exitCode !== expected.exitCode) {
    throw new Error(
      `Check result exit ${parsed.exitCode} does not match subprocess exit ${expected.exitCode}`
    );
  }
  return parsed;
};

/** Refuse to write any result the local consumer would reject. */
export const serializeCheckResult = (result: CheckResult): string => {
  const text = `${JSON.stringify(result, null, 2)}\n`;
  parseCheckResult(text, result);
  return text;
};
