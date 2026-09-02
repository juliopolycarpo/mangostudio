/**
 * Machine API calls: the hub's own status, doctor rows, log tail, and the two
 * mutating actions.
 *
 * An action can come back refused (403 from the guard, 409 because it does not
 * apply to how the hub is running). Both carry the CLI command to run instead,
 * so they are surfaced as a typed result the page renders, not as a thrown
 * error the page would only be able to toast.
 */

import type { InstallGuardReason } from '@mangostudio/shared/environments';
import type {
  MachineActionReason,
  MachineActionResponse,
  MachineDoctorReport,
  MachineDoctorSection,
  MachineLogTail,
  MachineServiceAction,
  MachineStatus,
} from '@mangostudio/shared/machine';
import { client } from '@/lib/api-client';
import { ApiError } from '@/lib/utils';

interface MachineActionRefusal {
  readonly outcome: 'refused';
  readonly reasons: readonly InstallGuardReason[];
  readonly reason: MachineActionReason | null;
  readonly command: string | null;
}

export type MachineActionResult =
  | { readonly outcome: 'accepted'; readonly response: MachineActionResponse }
  | MachineActionRefusal;

interface EdenErrorLike {
  readonly status?: number;
  readonly value?: unknown;
}

/**
 * Reads a refusal out of an Eden error; anything else stays a real failure.
 *
 * The body is read through `ApiError` rather than by hand: the client asks for
 * `application/problem+json`, so a refusal arrives as a problem document, and
 * `normalizeApiErrorBody` behind `ApiError` is the one place that reads both
 * that and the legacy shape. Parsing `details` here again would be a second
 * path that happens to work only while the two shapes agree on the key.
 */
function toRefusal(error: EdenErrorLike): MachineActionRefusal | null {
  if (error.status !== 403 && error.status !== 409) return null;
  const { details } = new ApiError(error.value);
  const reasons = details?.reasons;
  return {
    outcome: 'refused',
    reasons: reasons ? (reasons.split(',') as InstallGuardReason[]) : [],
    reason: (details?.reason as MachineActionReason | undefined) || null,
    command: details?.command || null,
  };
}

/** A guard refusal is a result the page renders; anything else is a failure. */
function refusalOrThrow(error: EdenErrorLike): MachineActionRefusal {
  const refusal = toRefusal(error);
  if (refusal) return refusal;
  throw new ApiError(error.value);
}

export async function fetchMachineStatus(): Promise<MachineStatus> {
  const { data, error } = await client.api.machine.status.get();
  if (error) throw new ApiError(error.value);
  return data as MachineStatus;
}

export async function fetchMachineDoctor(
  sections: readonly MachineDoctorSection[]
): Promise<MachineDoctorReport> {
  const { data, error } = await client.api.machine.doctor.get({
    query: sections.length > 0 ? { sections: sections.join(',') } : {},
  });
  if (error) throw new ApiError(error.value);
  return data as MachineDoctorReport;
}

export type MachineLogsResult =
  | { readonly outcome: 'tail'; readonly tail: MachineLogTail }
  | MachineActionRefusal;

/** The tail, or the guard's refusal — the log is loopback-only like the actions. */
export async function fetchMachineLogs(tail: number): Promise<MachineLogsResult> {
  const { data, error } = await client.api.machine.logs.get({ query: { tail } });
  if (error) return refusalOrThrow(error);
  return { outcome: 'tail', tail: data as MachineLogTail };
}

export async function restartMachine(): Promise<MachineActionResult> {
  const { data, error } = await client.api.machine.restart.post();
  if (error) return refusalOrThrow(error);
  return { outcome: 'accepted', response: data as MachineActionResponse };
}

export async function changeMachineService(
  action: MachineServiceAction
): Promise<MachineActionResult> {
  const { data, error } = await client.api.machine.service.post({ action });
  if (error) return refusalOrThrow(error);
  return { outcome: 'accepted', response: data as MachineActionResponse };
}
