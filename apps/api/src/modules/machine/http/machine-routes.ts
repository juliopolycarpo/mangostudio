import {
  type ApiErrorResponse,
  ApiErrorResponseSchema,
  ERROR_CODES,
} from '@mangostudio/shared/errors';
import {
  MACHINE_LOG_TAIL_MAX,
  MachineActionResponseSchema,
  MachineDoctorReportSchema,
  type MachineDoctorSection,
  MachineDoctorSectionSchema,
  MachineLogTailSchema,
  MachineServiceBodySchema,
  MachineStatusSchema,
} from '@mangostudio/shared/machine';
import { Elysia, t } from 'elysia';
import Value from 'typebox/value';
import type { GuardIpPolicy } from '../../../lib/client-ip';
import { getConfig } from '../../../lib/config';
import { requireAuth } from '../../../plugins/auth-middleware';
import { guardClientIp } from '../../../plugins/guard-client-ip';
import {
  MachineActionBlockedError,
  MachineActionUnavailableError,
  type MachineService,
  machineService,
} from '../application/machine-service';

function mapMachineError(error: unknown, set: { status?: number | string }): ApiErrorResponse {
  if (error instanceof MachineActionBlockedError) {
    set.status = 403;
    return {
      error: error.message,
      code: ERROR_CODES.PERMISSION_DENIED,
      details: { reasons: error.guard.reasons.join(',') },
    };
  }
  if (error instanceof MachineActionUnavailableError) {
    set.status = 409;
    return {
      error: error.message,
      code: ERROR_CODES.UNSUPPORTED,
      details: { reason: error.reason, command: error.command },
    };
  }
  throw error;
}

/** Comma-separated section names, each one the schema knows; null when any is not. */
export function parseDoctorSections(raw: string | undefined): MachineDoctorSection[] | null {
  if (!raw?.trim()) return [];
  const sections: MachineDoctorSection[] = [];
  for (const entry of raw.split(',')) {
    const name = entry.trim();
    if (!name) continue;
    if (!Value.Check(MachineDoctorSectionSchema, name)) return null;
    sections.push(name);
  }
  return sections;
}

export function createMachineRoutes(
  service: MachineService = machineService,
  policy: () => GuardIpPolicy = () => getConfig().security
) {
  return new Elysia()
    .use(requireAuth)
    .use(guardClientIp(policy))
    .get('/machine/status', { response: { 200: MachineStatusSchema } }, ({ guardClientIp }) =>
      service.status({ clientIp: guardClientIp })
    )
    .get(
      '/machine/doctor',
      {
        query: t.Object({ sections: t.Optional(t.String({ maxLength: 256 })) }),
        response: { 200: MachineDoctorReportSchema, 422: ApiErrorResponseSchema },
      },
      async ({ query, set, user }) => {
        const sections = parseDoctorSections(query.sections);
        if (sections === null) {
          set.status = 422;
          return {
            error: `Unknown doctor section in "${query.sections}". Expected environments or library.`,
            code: ERROR_CODES.VALIDATION,
          };
        }
        // Scoped to the signed-in account: the rows name MCP servers and
        // connectors, which are per-user rather than per-machine.
        return await service.doctor(sections, user?.id);
      }
    )
    .get(
      '/machine/logs',
      {
        query: t.Object({
          tail: t.Optional(t.Numeric({ minimum: 1, maximum: MACHINE_LOG_TAIL_MAX })),
        }),
        response: { 200: MachineLogTailSchema, 403: ApiErrorResponseSchema },
      },
      async ({ query, guardClientIp, set }) => {
        try {
          return await service.logs(query.tail ?? 0, { clientIp: guardClientIp });
        } catch (error) {
          return mapMachineError(error, set);
        }
      }
    )
    .post(
      '/machine/restart',
      {
        response: {
          202: MachineActionResponseSchema,
          403: ApiErrorResponseSchema,
          409: ApiErrorResponseSchema,
        },
      },
      async ({ guardClientIp, set }) => {
        try {
          const response = await service.restart({ clientIp: guardClientIp });
          set.status = 202;
          return response;
        } catch (error) {
          return mapMachineError(error, set);
        }
      }
    )
    .post(
      '/machine/service',
      {
        body: MachineServiceBodySchema,
        response: {
          202: MachineActionResponseSchema,
          403: ApiErrorResponseSchema,
          409: ApiErrorResponseSchema,
        },
      },
      async ({ body, guardClientIp, set }) => {
        try {
          const response = await service.service(body.action, { clientIp: guardClientIp });
          set.status = 202;
          return response;
        } catch (error) {
          return mapMachineError(error, set);
        }
      }
    );
}

export const machineRoutes = createMachineRoutes();
