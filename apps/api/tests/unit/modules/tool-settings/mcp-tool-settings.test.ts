import { afterEach, describe, expect, it } from 'bun:test';
import { getDb } from '../../../../src/db/database';
import {
  listToolSettingsDescriptors,
  ToolSettingsError,
  updateToolSettingsDescriptor,
} from '../../../../src/modules/tool-settings/application/tool-settings-service';
import { getSavedToolSettings } from '../../../../src/modules/tool-settings/infrastructure/tool-settings-repository';
import {
  closeAllMcpClients,
  setMcpClientConnectorForTest,
} from '../../../../src/services/mcp/connection-manager';
import type { McpClientHandle } from '../../../../src/services/mcp/types';
import { makeFakeMcpHandle } from '../../../support/fixtures/mcp/fake-handle';

let seq = 0;
function nextUserId(): string {
  seq += 1;
  return `user-mcp-tool-settings-${seq}`;
}

async function insertServer(userId: string, slug: string, name: string): Promise<void> {
  seq += 1;
  const now = Date.now();
  await getDb()
    .insertInto('mcp_servers')
    .values({
      id: `${userId}-server-${slug}-${seq}`,
      userId,
      name,
      slug,
      transport: 'stdio',
      command: 'bun',
      argsJson: '[]',
      envJson: '{}',
      url: null,
      enabled: 1,
      timeoutMs: null,
      createdAt: now,
      updatedAt: now,
    })
    .execute();
}

function fakeServerWithTools(...toolNames: string[]): McpClientHandle {
  return makeFakeMcpHandle({
    listTools: () =>
      Promise.resolve(
        toolNames.map((name) => ({
          name,
          description: `${name} does things`,
          inputSchema: { type: 'object' },
        }))
      ),
  });
}

afterEach(async () => {
  setMcpClientConnectorForTest(null);
  await closeAllMcpClients();
});

describe('tool settings with MCP tools', () => {
  it('lists MCP descriptors under the mcp category with server-prefixed titles', async () => {
    const userId = nextUserId();
    await insertServer(userId, 'github', 'GitHub');
    setMcpClientConnectorForTest(() => Promise.resolve(fakeServerWithTools('create_issue')));

    const { tools } = await listToolSettingsDescriptors(getDb(), userId);

    const descriptor = tools.find((tool) => tool.name === 'mcp__github__create_issue');
    expect(descriptor).toMatchObject({
      title: 'GitHub: create_issue',
      category: 'mcp',
      enabled: true,
      canDisable: true,
      parameters: {},
      parameterDescriptors: [],
    });
  });

  it('persists an enabled toggle keyed by the namespaced name', async () => {
    const userId = nextUserId();
    await insertServer(userId, 'github', 'GitHub');
    setMcpClientConnectorForTest(() => Promise.resolve(fakeServerWithTools('create_issue')));

    const updated = await updateToolSettingsDescriptor(
      getDb(),
      userId,
      'mcp__github__create_issue',
      { enabled: false }
    );
    expect(updated).toMatchObject({
      name: 'mcp__github__create_issue',
      category: 'mcp',
      enabled: false,
    });

    const saved = await getSavedToolSettings(getDb(), userId, 'mcp__github__create_issue');
    expect(saved?.enabled).toBe(false);

    const { tools } = await listToolSettingsDescriptors(getDb(), userId);
    expect(tools.find((tool) => tool.name === 'mcp__github__create_issue')?.enabled).toBe(false);
  });

  it('rejects updates against unowned or unknown servers', async () => {
    const owner = nextUserId();
    const intruder = nextUserId();
    await insertServer(owner, 'github', 'GitHub');

    expect(
      updateToolSettingsDescriptor(getDb(), intruder, 'mcp__github__create_issue', {
        enabled: false,
      })
    ).rejects.toThrow(ToolSettingsError);
    expect(
      updateToolSettingsDescriptor(getDb(), owner, 'mcp____broken', { enabled: false })
    ).rejects.toThrow('Unknown tool');
  });

  it('rejects parameter updates for MCP tools', async () => {
    const userId = nextUserId();
    await insertServer(userId, 'github', 'GitHub');

    expect(
      updateToolSettingsDescriptor(getDb(), userId, 'mcp__github__create_issue', {
        parameters: { quality: 5 },
      })
    ).rejects.toThrow('no configurable parameters');
  });
});
