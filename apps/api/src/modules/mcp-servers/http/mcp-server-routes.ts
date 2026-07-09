import type { ApiErrorResponse } from '@mangostudio/shared/errors';
import type {
  DeleteMcpServerResponse,
  GetMcpPromptResponse,
  ImportMcpServersResponse,
  McpImportPreviewResponse,
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
  GetMcpPromptBodySchema,
  ImportMcpServersBodySchema,
  PreviewMcpImportBodySchema,
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
    ({ body, params, set, user }): RespondMcpElicitationResponse | ApiErrorResponse => {
      const status = respondElicitation(user?.id ?? '', params.id, body);
      if (!status) {
        set.status = 404;
        return { error: 'Elicitation not found or already resolved.', code: 'NOT_FOUND' };
      }
      return { ok: true, status };
    },
    { params: elicitationIdParams, body: RespondMcpElicitationBodySchema }
  )

  .get('/mcp/servers', ({ user }): Promise<McpServerListResponse> => {
    return listMcpServers(getDb(), user?.id ?? '');
  })

  .post(
    '/mcp/servers',
    async ({ body, set, user }): Promise<McpServer | ApiErrorResponse> => {
      try {
        const server = await createMcpServer(getDb(), user?.id ?? '', body);
        set.status = 201;
        return server;
      } catch (error) {
        return handleMcpServerError(error, set);
      }
    },
    { body: AddMcpServerBodySchema }
  )

  .post(
    '/mcp/servers/import/preview',
    async ({ body, set, user }): Promise<McpImportPreviewResponse | ApiErrorResponse> => {
      try {
        return await previewMcpImport(getDb(), user?.id ?? '', body);
      } catch (error) {
        return handleMcpServerError(error, set);
      }
    },
    { body: PreviewMcpImportBodySchema }
  )

  .post(
    '/mcp/servers/import',
    async ({ body, set, user }): Promise<ImportMcpServersResponse | ApiErrorResponse> => {
      try {
        return await importMcpServers(getDb(), user?.id ?? '', body);
      } catch (error) {
        return handleMcpServerError(error, set);
      }
    },
    { body: ImportMcpServersBodySchema }
  )

  .put(
    '/mcp/servers/:id',
    async ({ body, params, set, user }): Promise<McpServer | ApiErrorResponse> => {
      try {
        return await updateMcpServer(getDb(), user?.id ?? '', params.id, body);
      } catch (error) {
        return handleMcpServerError(error, set);
      }
    },
    { params: idParams, body: UpdateMcpServerBodySchema }
  )

  .delete(
    '/mcp/servers/:id',
    async ({ params, set, user }): Promise<DeleteMcpServerResponse | ApiErrorResponse> => {
      try {
        return await removeMcpServer(getDb(), user?.id ?? '', params.id);
      } catch (error) {
        return handleMcpServerError(error, set);
      }
    },
    { params: idParams }
  )

  .post(
    '/mcp/servers/:id/test',
    async ({ params, set, user }): Promise<TestMcpServerResponse | ApiErrorResponse> => {
      try {
        return await testMcpServer(getDb(), user?.id ?? '', params.id);
      } catch (error) {
        return handleMcpServerError(error, set);
      }
    },
    { params: idParams }
  )

  .get(
    '/mcp/servers/:id/tools',
    async ({ params, set, user }): Promise<McpServerToolsResponse | ApiErrorResponse> => {
      try {
        return await listMcpServerTools(getDb(), user?.id ?? '', params.id);
      } catch (error) {
        return handleMcpServerError(error, set);
      }
    },
    { params: idParams }
  )

  .get(
    '/mcp/servers/:id/resources',
    async ({ params, set, user }): Promise<McpServerResourcesResponse | ApiErrorResponse> => {
      try {
        return await listMcpServerResources(getDb(), user?.id ?? '', params.id);
      } catch (error) {
        return handleMcpServerError(error, set);
      }
    },
    { params: idParams }
  )

  .post(
    '/mcp/servers/:id/resources/read',
    async ({ body, params, set, user }): Promise<ReadMcpResourceResponse | ApiErrorResponse> => {
      try {
        return await readMcpServerResource(getDb(), user?.id ?? '', params.id, body);
      } catch (error) {
        return handleMcpServerError(error, set);
      }
    },
    { params: idParams, body: ReadMcpResourceBodySchema }
  )

  .get(
    '/mcp/servers/:id/prompts',
    async ({ params, set, user }): Promise<McpServerPromptsResponse | ApiErrorResponse> => {
      try {
        return await listMcpServerPrompts(getDb(), user?.id ?? '', params.id);
      } catch (error) {
        return handleMcpServerError(error, set);
      }
    },
    { params: idParams }
  )

  // `/prompts/resolve` rather than the spec-ish `/prompts/get`: a `get` path
  // segment collides with Eden Treaty's `.get` HTTP method on the client.
  .post(
    '/mcp/servers/:id/prompts/resolve',
    async ({ body, params, set, user }): Promise<GetMcpPromptResponse | ApiErrorResponse> => {
      try {
        return await getMcpServerPrompt(getDb(), user?.id ?? '', params.id, body);
      } catch (error) {
        return handleMcpServerError(error, set);
      }
    },
    { params: idParams, body: GetMcpPromptBodySchema }
  );
