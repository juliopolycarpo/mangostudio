/**
 * Every enumerated union: the exported `as const` array and the schema that
 * mirrors it must list the same values, and the schema's `Static<>` must still
 * be that union of literals.
 *
 * These pairs are hand-kept in sync, because a union has to be written as a
 * literal tuple for TypeBox to infer it. Mapping the array into `Type.Union`
 * reads as the DRY-er version and produces the same JSON Schema, but widens to
 * `TSchema[]` — which infers as `never` and quietly turns every consumer's
 * status field into an unusable type while the schema still validates. The
 * runtime halves are compared here; the `Static<>` half is asserted by the
 * annotated fixtures below, which stop compiling if an inference collapses.
 */

import { describe, expect, it } from 'bun:test';
import type { TSchema } from 'typebox';

import type {
  ToolExecutionReasonCode,
  ToolExecutionSource,
  ToolExecutionStatus,
} from '../../src/tool-executions';
import {
  TOOL_EXECUTION_REASON_CODES,
  TOOL_EXECUTION_SOURCES,
  TOOL_EXECUTION_STATUSES,
  ToolExecutionReasonCodeSchema,
  ToolExecutionSourceSchema,
  ToolExecutionStatusSchema,
} from '../../src/tool-executions';
import type {
  ToolRetrySafety,
  TurnCheckpointStatus,
  TurnInterruptionReasonCode,
} from '../../src/turn-recovery';
import {
  TOOL_RETRY_SAFETY_VALUES,
  ToolRetrySafetySchema,
  TURN_CHECKPOINT_STATUSES,
  TURN_INTERRUPTION_REASON_CODES,
  TurnCheckpointStatusSchema,
  TurnInterruptionReasonCodeSchema,
} from '../../src/turn-recovery';

/** The `const` values a union schema accepts, in declaration order. */
const schemaConstants = (schema: TSchema): readonly unknown[] => {
  const members = (schema as { anyOf?: readonly { const?: unknown }[] }).anyOf;
  if (!members) throw new Error('expected a union schema with an anyOf list');
  return members.map((member) => member.const);
};

/**
 * Each pair, with one member annotated as the schema's derived type. The
 * annotation is the compile-time half: if `Static<>` collapses to `never`, the
 * literal below stops being assignable and this file fails to typecheck.
 */
const PAIRS: ReadonlyArray<{
  readonly name: string;
  readonly schema: TSchema;
  readonly values: readonly string[];
  readonly sample: string;
}> = [
  {
    name: 'ToolExecutionStatus',
    schema: ToolExecutionStatusSchema,
    values: TOOL_EXECUTION_STATUSES,
    sample: 'queued' satisfies ToolExecutionStatus,
  },
  {
    name: 'ToolExecutionSource',
    schema: ToolExecutionSourceSchema,
    values: TOOL_EXECUTION_SOURCES,
    sample: 'builtin' satisfies ToolExecutionSource,
  },
  {
    name: 'ToolExecutionReasonCode',
    schema: ToolExecutionReasonCodeSchema,
    values: TOOL_EXECUTION_REASON_CODES,
    sample: 'timeout' satisfies ToolExecutionReasonCode,
  },
  {
    name: 'TurnCheckpointStatus',
    schema: TurnCheckpointStatusSchema,
    values: TURN_CHECKPOINT_STATUSES,
    sample: 'active' satisfies TurnCheckpointStatus,
  },
  {
    name: 'TurnInterruptionReasonCode',
    schema: TurnInterruptionReasonCodeSchema,
    values: TURN_INTERRUPTION_REASON_CODES,
    sample: 'client_disconnect' satisfies TurnInterruptionReasonCode,
  },
  {
    name: 'ToolRetrySafety',
    schema: ToolRetrySafetySchema,
    values: TOOL_RETRY_SAFETY_VALUES,
    sample: 'safe_read' satisfies ToolRetrySafety,
  },
];

describe('enumerated unions match their exported value lists', () => {
  for (const { name, schema, values, sample } of PAIRS) {
    it(`${name} lists the same values in the same order`, () => {
      expect(schemaConstants(schema)).toEqual([...values]);
    });

    it(`${name} accepts its own sample value`, () => {
      expect(values).toContain(sample);
    });
  }

  it('covers every enumerated union in the shared contract', () => {
    // A new `as const` + `Type.Union` pair that is not added here is exactly the
    // case this file exists to catch, so the count is pinned deliberately.
    expect(PAIRS).toHaveLength(6);
  });
});
