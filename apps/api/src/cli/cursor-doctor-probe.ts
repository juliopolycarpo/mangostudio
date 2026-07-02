/**
 * Opt-in live probe for `mango doctor --cursor-probe`. Spawns the Cursor
 * sidecar validate_api_key RPC with an obviously invalid key; an auth rejection
 * proves the Node → sidecar → SDK chain can reach the Cursor SDK.
 */

import { CursorApiError, validateCursorApiKey } from '../services/providers/cursor/client';
import type { CursorDoctorProbeResult } from './doctor-checks';

const CURSOR_DOCTOR_PROBE_API_KEY = 'mango-doctor-probe-invalid';

export interface CursorDoctorProbeDeps {
  validateApiKey: (apiKey: string) => Promise<void>;
}

function isCursorAuthRejection(error: unknown): boolean {
  if (!(error instanceof CursorApiError)) return false;
  const cause = error.cause;
  if (!cause || typeof cause !== 'object') return false;
  const status =
    (cause as { status?: number; statusCode?: number }).status ??
    (cause as { status?: number; statusCode?: number }).statusCode;
  return status === 401 || status === 403;
}

/** Run the live sidecar probe; auth errors count as a healthy chain. */
export async function probeCursorDoctorRuntime(
  deps: Partial<CursorDoctorProbeDeps> = {}
): Promise<CursorDoctorProbeResult> {
  const validateApiKey = deps.validateApiKey ?? validateCursorApiKey;

  try {
    await validateApiKey(CURSOR_DOCTOR_PROBE_API_KEY);
    return {
      ok: true,
      detail: 'validate_api_key accepted (unexpected for probe key)',
    };
  } catch (error) {
    if (isCursorAuthRejection(error)) {
      return {
        ok: true,
        detail: 'validate_api_key reached SDK (auth rejected probe key)',
      };
    }
    if (error instanceof CursorApiError) {
      return { ok: false, detail: error.message };
    }
    if (error instanceof Error && error.message) {
      return { ok: false, detail: error.message };
    }
    return { ok: false, detail: 'Cursor sidecar probe failed.' };
  }
}
