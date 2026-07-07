import type { ApiErrorResponse } from '@mangostudio/shared/errors';
import type {
  DeleteMcpServerResponse,
  McpServer,
  McpServerListResponse,
  McpServerToolsResponse,
  TestMcpServerResponse,
} from '@mangostudio/shared/mcp';
import { AddMcpServerBodySchema, UpdateMcpServerBodySchema } from '@mangostudio/shared/mcp';
import { Elysia, t } from 'elysia';
import { getDb } from '../../../db/database';
import { requireAuth } from '../../../plugins/auth-middleware';
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

export const mcpServerRoutes = new Elysia()
  .use(requireAuth)

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
  );
