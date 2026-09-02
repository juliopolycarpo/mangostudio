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
import { extractClientIp } from '../../../lib/client-ip';
import { getConfig } from '../../../lib/config';
import { requireAuth } from '../../../plugins/auth-middleware';
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
  trustProxy: () => boolean = () => getConfig().security.trustProxy
) {
  return new Elysia()
    .use(requireAuth)
    .derive(({ request, server }) => {
      // The socket peer is not header-controlled, so it is the default. It is
      // not enough on its own: behind the documented nginx and Caddy setups the
      // peer is always the loopback proxy, and every remote browser would pass
      // a check that is supposed to mean "at this machine's keyboard". Where
      // the operator has trusted the proxy, its forwarded client is the
      // stricter answer; where they have not, a forged header changes nothing.
      return {
        machinePeerIp: extractClientIp(
          request.headers,
          server?.requestIP(request)?.address,
          trustProxy()
        ),
      };
    })
    .get('/machine/status', { response: { 200: MachineStatusSchema } }, ({ machinePeerIp }) =>
      service.status({ clientIp: machinePeerIp })
    )
    .get(
      '/machine/doctor',
      {
        query: t.Object({ sections: t.Optional(t.String({ maxLength: 256 })) }),
        response: { 200: MachineDoctorReportSchema, 422: ApiErrorResponseSchema },
      },
      async ({ query, set }) => {
        const sections = parseDoctorSections(query.sections);
        if (sections === null) {
          set.status = 422;
          return {
            error: `Unknown doctor section in "${query.sections}". Expected environments or library.`,
            code: ERROR_CODES.VALIDATION,
          };
        }
        return await service.doctor(sections);
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
      async ({ query, machinePeerIp, set }) => {
        try {
          return await service.logs(query.tail ?? 0, { clientIp: machinePeerIp });
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
      async ({ machinePeerIp, set }) => {
        try {
          const response = await service.restart({ clientIp: machinePeerIp });
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
      async ({ body, machinePeerIp, set }) => {
        try {
          const response = await service.service(body.action, { clientIp: machinePeerIp });
          set.status = 202;
          return response;
        } catch (error) {
          return mapMachineError(error, set);
        }
      }
    );
}

export const machineRoutes = createMachineRoutes();
