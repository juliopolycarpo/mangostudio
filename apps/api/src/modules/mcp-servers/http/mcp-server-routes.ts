import type { ApiErrorResponse } from '@mangostudio/shared/errors';
import type {
  DeleteMcpServerResponse,
  ExportMcpServersResponse,
  GetMcpPromptResponse,
  ImportMcpServersResponse,
  McpImportPreviewResponse,
  McpPortabilityApplyResponse,
  McpPortabilityPreviewResponse,
  McpServer,
  McpServerListResponse,
  McpServerPromptsResponse,
  McpServerResourcesResponse,
  McpServerToolsResponse,
  ReadMcpResourceResponse,
  RespondMcpElicitationResponse,
  TestMcpServerResponse,
} from '@mangostudio/shared/mcp';
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
import { Elysia, t } from 'elysia';
import { getDb } from '../../../db/database';
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

function handleMcpServerError(error: unknown, set: { status?: number | string }): ApiErrorResponse {
  if (error instanceof McpServerError) {
    set.status = error.status;
    return { error: error.message, code: error.code };
  }

  console.error('[mcp-servers] Unexpected error:', error);
  set.status = 500;
  return { error: 'Unexpected MCP server error.', code: 'INTERNAL' };
}

const idParams = t.Object({ id: t.String() });
const elicitationIdParams = t.Object({ id: t.String({ minLength: 1 }) });

export const mcpServerRoutes = new Elysia()
  .use(requireAuth)

  .post(
    '/mcp/elicitations/:id/respond',
    { params: elicitationIdParams, body: RespondMcpElicitationBodySchema },
    ({ body, params, set, user }): RespondMcpElicitationResponse | ApiErrorResponse => {
      const status = respondElicitation(user?.id ?? '', params.id, body);
      if (!status) {
        set.status = 404;
        return { error: 'Elicitation not found or already resolved.', code: 'NOT_FOUND' };
      }
      return { ok: true, status };
    }
  )

  .get('/mcp/servers', ({ user }): Promise<McpServerListResponse> => {
    return listMcpServers(getDb(), user?.id ?? '');
  })

  .post(
    '/mcp/servers',
    { body: AddMcpServerBodySchema },
    async ({ body, set, user }): Promise<McpServer | ApiErrorResponse> => {
      try {
        const server = await createMcpServer(getDb(), user?.id ?? '', body);
        set.status = 201;
        return server;
      } catch (error) {
        return handleMcpServerError(error, set);
      }
    }
  )

  .post(
    '/mcp/servers/import/preview',
    { body: PreviewMcpImportBodySchema },
    async ({ body, set, user }): Promise<McpImportPreviewResponse | ApiErrorResponse> => {
      try {
        return await previewMcpImport(getDb(), user?.id ?? '', body);
      } catch (error) {
        return handleMcpServerError(error, set);
      }
    }
  )

  .post(
    '/mcp/servers/import',
    { body: ImportMcpServersBodySchema },
    async ({ body, set, user }): Promise<ImportMcpServersResponse | ApiErrorResponse> => {
      try {
        return await importMcpServers(getDb(), user?.id ?? '', body);
      } catch (error) {
        return handleMcpServerError(error, set);
      }
    }
  )

  .post(
    '/mcp/servers/portability/export',
    { body: ExportMcpServersBodySchema },
    async ({ body, set, user }): Promise<ExportMcpServersResponse | ApiErrorResponse> => {
      try {
        return await exportMcpServers(getDb(), user?.id ?? '', body);
      } catch (error) {
        return handleMcpServerError(error, set);
      }
    }
  )

  .post(
    '/mcp/servers/portability/import/preview',
    { body: PreviewMcpPortabilityImportBodySchema },
    async ({ body, set, user }): Promise<McpPortabilityPreviewResponse | ApiErrorResponse> => {
      try {
        return await previewMcpPortabilityImport(getDb(), user?.id ?? '', body);
      } catch (error) {
        return handleMcpServerError(error, set);
      }
    }
  )

  .post(
    '/mcp/servers/portability/import/apply',
    { body: ApplyMcpPortabilityImportBodySchema },
    async ({ body, set, user }): Promise<McpPortabilityApplyResponse | ApiErrorResponse> => {
      try {
        return await applyMcpPortabilityImport(getDb(), user?.id ?? '', body);
      } catch (error) {
        return handleMcpServerError(error, set);
      }
    }
  )

  .put(
    '/mcp/servers/:id',
    { params: idParams, body: UpdateMcpServerBodySchema },
    async ({ body, params, set, user }): Promise<McpServer | ApiErrorResponse> => {
      try {
        return await updateMcpServer(getDb(), user?.id ?? '', params.id, body);
      } catch (error) {
        return handleMcpServerError(error, set);
      }
    }
  )

  .delete(
    '/mcp/servers/:id',
    { params: idParams },
    async ({ params, set, user }): Promise<DeleteMcpServerResponse | ApiErrorResponse> => {
      try {
        return await removeMcpServer(getDb(), user?.id ?? '', params.id);
      } catch (error) {
        return handleMcpServerError(error, set);
      }
    }
  )

  .post(
    '/mcp/servers/:id/test',
    { params: idParams },
    async ({ params, set, user }): Promise<TestMcpServerResponse | ApiErrorResponse> => {
      try {
        return await testMcpServer(getDb(), user?.id ?? '', params.id);
      } catch (error) {
        return handleMcpServerError(error, set);
      }
    }
  )

  .get(
    '/mcp/servers/:id/tools',
    { params: idParams },
    async ({ params, set, user }): Promise<McpServerToolsResponse | ApiErrorResponse> => {
      try {
        return await listMcpServerTools(getDb(), user?.id ?? '', params.id);
      } catch (error) {
        return handleMcpServerError(error, set);
      }
    }
  )

  .get(
    '/mcp/servers/:id/resources',
    { params: idParams },
    async ({ params, set, user }): Promise<McpServerResourcesResponse | ApiErrorResponse> => {
      try {
        return await listMcpServerResources(getDb(), user?.id ?? '', params.id);
      } catch (error) {
        return handleMcpServerError(error, set);
      }
    }
  )

  .post(
    '/mcp/servers/:id/resources/read',
    { params: idParams, body: ReadMcpResourceBodySchema },
    async ({ body, params, set, user }): Promise<ReadMcpResourceResponse | ApiErrorResponse> => {
      try {
        return await readMcpServerResource(getDb(), user?.id ?? '', params.id, body);
      } catch (error) {
        return handleMcpServerError(error, set);
      }
    }
  )

  .get(
    '/mcp/servers/:id/prompts',
    { params: idParams },
    async ({ params, set, user }): Promise<McpServerPromptsResponse | ApiErrorResponse> => {
      try {
        return await listMcpServerPrompts(getDb(), user?.id ?? '', params.id);
      } catch (error) {
        return handleMcpServerError(error, set);
      }
    }
  )

  // `/prompts/resolve` rather than the spec-ish `/prompts/get`: a `get` path
  // segment collides with Eden Treaty's `.get` HTTP method on the client.
  .post(
    '/mcp/servers/:id/prompts/resolve',
    { params: idParams, body: GetMcpPromptBodySchema },
    async ({ body, params, set, user }): Promise<GetMcpPromptResponse | ApiErrorResponse> => {
      try {
        return await getMcpServerPrompt(getDb(), user?.id ?? '', params.id, body);
      } catch (error) {
        return handleMcpServerError(error, set);
      }
    }
  );
