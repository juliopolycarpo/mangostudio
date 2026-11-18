import type { McpServerListResponse } from '@mangostudio/shared/mcp';
import {
  AddMcpServerBodySchema,
  ApplyMcpPortabilityImportBodySchema,
  ExportMcpServersBodySchema,
  GetMcpPromptBodySchema,
  ImportMcpServersBodySchema,
  PreviewMcpImportBodySchema,
  PreviewMcpPortabilityImportBodySchema,
  ReadMcpResourceBodySchema,
  RespondMcpElicitationBodySchema,
  UpdateMcpServerBodySchema,
} from '@mangostudio/shared/mcp';
import { Elysia, status, t } from 'elysia';

import { getDb } from '../../../db/database';
import { apiErrorStatus } from '../../../lib/api-error-status';
import { requireAuth } from '../../../plugins/auth-middleware';
import { respondElicitation } from '../../../services/mcp/elicitation-registry';
import { importMcpServers, previewMcpImport } from '../application/mcp-import-service';
import {
  applyMcpPortabilityImport,
  exportMcpServers,
  previewMcpPortabilityImport,
} from '../application/mcp-portability-service';
import {
  getMcpServerPrompt,
  listMcpServerPrompts,
  listMcpServerResources,
  readMcpServerResource,
} from '../application/mcp-resource-prompt-service';
import {
  createMcpServer,
  listMcpServers,
  listMcpServerTools,
  removeMcpServer,
  testMcpServer,
  updateMcpServer,
} from '../application/mcp-server-service';
import { McpServerError } from '../domain/mcp-server';

function handleMcpServerError(error: unknown) {
  if (error instanceof McpServerError) {
    return apiErrorStatus(error.status, { error: error.message, code: error.code });
  }

  console.error('[mcp-servers] Unexpected error:', error);
  return status(500, { error: 'Unexpected MCP server error.', code: 'INTERNAL' });
}

const idParams = t.Object({ id: t.String() });
const elicitationIdParams = t.Object({ id: t.String({ minLength: 1 }) });

export const mcpServerRoutes = new Elysia()
  .use(requireAuth)

  .post(
    '/mcp/elicitations/:id/respond',
    { params: elicitationIdParams, body: RespondMcpElicitationBodySchema },
    ({ body, params, user }) => {
      const outcome = respondElicitation(user?.id ?? '', params.id, body);
      if (!outcome) {
        return status(404, {
          error: 'Elicitation not found or already resolved.',
          code: 'NOT_FOUND',
        });
      }
      return { ok: true as const, status: outcome };
    }
  )

  .get('/mcp/servers', ({ user }): Promise<McpServerListResponse> => {
    return listMcpServers(getDb(), user?.id ?? '');
  })

  .post('/mcp/servers', { body: AddMcpServerBodySchema }, async ({ body, set, user }) => {
    try {
      const server = await createMcpServer(getDb(), user?.id ?? '', body);
      set.status = 201;
      return server;
    } catch (error) {
      return handleMcpServerError(error);
    }
  })

  .post(
    '/mcp/servers/import/preview',
    { body: PreviewMcpImportBodySchema },
    async ({ body, user }) => {
      try {
        return await previewMcpImport(getDb(), user?.id ?? '', body);
      } catch (error) {
        return handleMcpServerError(error);
      }
    }
  )

  .post('/mcp/servers/import', { body: ImportMcpServersBodySchema }, async ({ body, user }) => {
    try {
      return await importMcpServers(getDb(), user?.id ?? '', body);
    } catch (error) {
      return handleMcpServerError(error);
    }
  })

  .post(
    '/mcp/servers/portability/export',
    { body: ExportMcpServersBodySchema },
    async ({ body, user }) => {
      try {
        return await exportMcpServers(getDb(), user?.id ?? '', body);
      } catch (error) {
        return handleMcpServerError(error);
      }
    }
  )

  .post(
    '/mcp/servers/portability/import/preview',
    { body: PreviewMcpPortabilityImportBodySchema },
    async ({ body, user }) => {
      try {
        return await previewMcpPortabilityImport(getDb(), user?.id ?? '', body);
      } catch (error) {
        return handleMcpServerError(error);
      }
    }
  )

  .post(
    '/mcp/servers/portability/import/apply',
    { body: ApplyMcpPortabilityImportBodySchema },
    async ({ body, user }) => {
      try {
        return await applyMcpPortabilityImport(getDb(), user?.id ?? '', body);
      } catch (error) {
        return handleMcpServerError(error);
      }
    }
  )

  .put(
    '/mcp/servers/:id',
    { params: idParams, body: UpdateMcpServerBodySchema },
    async ({ body, params, user }) => {
      try {
        return await updateMcpServer(getDb(), user?.id ?? '', params.id, body);
      } catch (error) {
        return handleMcpServerError(error);
      }
    }
  )

  .delete('/mcp/servers/:id', { params: idParams }, async ({ params, user }) => {
    try {
      return await removeMcpServer(getDb(), user?.id ?? '', params.id);
    } catch (error) {
      return handleMcpServerError(error);
    }
  })

  .post('/mcp/servers/:id/test', { params: idParams }, async ({ params, user }) => {
    try {
      return await testMcpServer(getDb(), user?.id ?? '', params.id);
    } catch (error) {
      return handleMcpServerError(error);
    }
  })

  .get('/mcp/servers/:id/tools', { params: idParams }, async ({ params, user }) => {
    try {
      return await listMcpServerTools(getDb(), user?.id ?? '', params.id);
    } catch (error) {
      return handleMcpServerError(error);
    }
  })

  .get('/mcp/servers/:id/resources', { params: idParams }, async ({ params, user }) => {
    try {
      return await listMcpServerResources(getDb(), user?.id ?? '', params.id);
    } catch (error) {
      return handleMcpServerError(error);
    }
  })

  .post(
    '/mcp/servers/:id/resources/read',
    { params: idParams, body: ReadMcpResourceBodySchema },
    async ({ body, params, user }) => {
      try {
        return await readMcpServerResource(getDb(), user?.id ?? '', params.id, body);
      } catch (error) {
        return handleMcpServerError(error);
      }
    }
  )

  .get('/mcp/servers/:id/prompts', { params: idParams }, async ({ params, user }) => {
    try {
      return await listMcpServerPrompts(getDb(), user?.id ?? '', params.id);
    } catch (error) {
      return handleMcpServerError(error);
    }
  })

  // `/prompts/resolve` rather than the spec-ish `/prompts/get`: a `get` path
  // segment collides with Eden Treaty's `.get` HTTP method on the client.
  .post(
    '/mcp/servers/:id/prompts/resolve',
    { params: idParams, body: GetMcpPromptBodySchema },
    async ({ body, params, user }) => {
      try {
        return await getMcpServerPrompt(getDb(), user?.id ?? '', params.id, body);
      } catch (error) {
        return handleMcpServerError(error);
      }
    }
  );
