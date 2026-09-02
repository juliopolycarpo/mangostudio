/**
 * Fitting what this hub knows into what the wire contract accepts.
 *
 * Everything the machine document reports about itself comes from something
 * with no length of its own: a doctor detail, a probe's error message, a
 * supervisor's stderr, the number of MCP rows an account owns. The schema in
 * `@mangostudio/shared/machine` caps all of them, and a response that overruns
 * its own schema is not a validation error the caller can act on — the error
 * handler answers it as a 500. The page would lose the whole document over one
 * long line. Cut it here instead, visibly.
 */

import type { MachineCheck } from '@mangostudio/shared/machine';
import {
  MACHINE_CHECK_DETAIL_MAX,
  MACHINE_CHECK_LABEL_MAX,
  MACHINE_DOCTOR_CHECK_LIMIT,
} from '@mangostudio/shared/machine';

const CUT_MARK = '…';

/**
 * `value` at most `max` characters, marked where it was cut. Null passes
 * through, so an optional error field keeps meaning "nothing to report".
 * // Usage: fitToLimit(probe.error, MACHINE_ERROR_MAX)
 */
export function fitToLimit<T extends string | null | undefined>(value: T, max: number): T {
  if (typeof value !== 'string' || value.length <= max) return value;
  return `${value.slice(0, max - CUT_MARK.length)}${CUT_MARK}` as T;
}

/**
 * Doctor rows the report schema accepts: each row cut to its own caps, and no
 * more rows than the array holds. An install with hundreds of MCP servers is
 * still a report, not a 500.
 * // Usage: fitDoctorChecks(await collectDoctorChecks())
 */
export function fitDoctorChecks(checks: readonly MachineCheck[]): MachineCheck[] {
  return checks.slice(0, MACHINE_DOCTOR_CHECK_LIMIT).map((check) => ({
    ...check,
    label: fitToLimit(check.label, MACHINE_CHECK_LABEL_MAX),
    detail: fitToLimit(check.detail, MACHINE_CHECK_DETAIL_MAX),
  }));
}
