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
  readonly message: string;
}

export type MachineActionResult =
  | { readonly outcome: 'accepted'; readonly response: MachineActionResponse }
  | MachineActionRefusal;

interface EdenErrorLike {
  readonly status?: number;
  readonly value?: unknown;
}

function detailString(details: unknown, key: string): string | null {
  if (!details || typeof details !== 'object') return null;
  const value = (details as Record<string, unknown>)[key];
  return typeof value === 'string' && value ? value : null;
}

/** Reads a refusal out of an Eden error; anything else stays a real failure. */
function toRefusal(error: EdenErrorLike): MachineActionRefusal | null {
  if (error.status !== 403 && error.status !== 409) return null;
  const value = error.value;
  if (!value || typeof value !== 'object') return null;
  const body = value as { error?: unknown; details?: unknown };
  const reasons = detailString(body.details, 'reasons');
  return {
    outcome: 'refused',
    reasons: reasons ? (reasons.split(',') as InstallGuardReason[]) : [],
    reason: detailString(body.details, 'reason') as MachineActionReason | null,
    command: detailString(body.details, 'command'),
    message: typeof body.error === 'string' ? body.error : '',
  };
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

export async function fetchMachineLogs(tail: number): Promise<MachineLogTail> {
  const { data, error } = await client.api.machine.logs.get({ query: { tail } });
  if (error) throw new ApiError(error.value);
  return data as MachineLogTail;
}

export async function restartMachine(): Promise<MachineActionResult> {
  const { data, error } = await client.api.machine.restart.post();
  if (error) {
    const refusal = toRefusal(error);
    if (refusal) return refusal;
    throw new ApiError(error.value);
  }
  return { outcome: 'accepted', response: data as MachineActionResponse };
}

export async function changeMachineService(
  action: MachineServiceAction
): Promise<MachineActionResult> {
  const { data, error } = await client.api.machine.service.post({ action });
  if (error) {
    const refusal = toRefusal(error);
    if (refusal) return refusal;
    throw new ApiError(error.value);
  }
  return { outcome: 'accepted', response: data as MachineActionResponse };
}
