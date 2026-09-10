import { describe, expect, it } from 'bun:test';
import { realpath } from 'node:fs/promises';
import { RUNTIME_CONSENT_PRESETS } from '@mangostudio/shared/runtime-home';
import { createLocalRuntimeHost, RUNTIME_EXTERNAL_AGENT_TOPIC } from '../../../src';
import { FakeExternalAgentAdapter } from '../../support/fake-external-agent-adapter';
import { connectRuntimeDefinition } from '../../support/hub-connection';

describe('external-agent runtime protocol wiring', () => {
  it('drives a fake adapter through the real framed host and reaps it before close resolves', async () => {
    const adapter = new FakeExternalAgentAdapter({
      events: [{ type: 'text_delta', text: 'from fixture' }, { type: 'completed' }],
    });
    const workspacePath = await realpath(import.meta.dir);
    const connection = await connectRuntimeDefinition(
      createLocalRuntimeHost({
        runtimeVersion: 'runtime-test',
        allow: RUNTIME_CONSENT_PRESETS.full,
        externalAgents: {
          adapters: [adapter],
          authorizeWorkspace: () => true,
          resolveExecutable: async () => ({ path: process.execPath }),
        },
      })
    );
    const events: unknown[] = [];
    connection.onEvent((frame) => {
      if (frame.topic === RUNTIME_EXTERNAL_AGENT_TOPIC) events.push(frame.payload);
    });

    expect(connection.manifest.externalAgents).toEqual(['codex']);
    await expect(
      connection.request('external-agent.discover', {
        targetIds: ['codex'],
        timeoutMs: 1_000,
      })
    ).resolves.toMatchObject({ descriptors: [{ targetId: 'codex', installed: true }] });
    await connection.request('external-agent.open', {
      sessionId: 'session-1',
      targetId: 'codex',
      workspacePath,
      configuration: { level: 'default', routing: 'user', workspaceRoots: [] },
      resumeMode: 'fallback',
      timeoutMs: 1_000,
    });
    await connection.request('external-agent.turn', {
      sessionId: 'session-1',
      clientMessageId: 'message-1',
      input: 'hello',
      configuration: { level: 'default', routing: 'user', workspaceRoots: [] },
    });

    await waitFor(() => events.length === 2);
    expect(events).toMatchObject([
      { sessionId: 'session-1', sequence: 1, event: { type: 'text_delta' } },
      { sessionId: 'session-1', sequence: 2, event: { type: 'completed' } },
    ]);

    await connection.close();
    expect(adapter.closes).toMatchObject([{ sessionId: 'session-1', reason: 'shutdown' }]);
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for runtime event.');
    await Bun.sleep(5);
  }
}
