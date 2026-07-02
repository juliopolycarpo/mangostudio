import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type NodeSidecarStreamOutput,
  streamNodeSidecarEvents,
} from '../../../../../../src/services/providers/core/node-sidecar/spawn-sidecar';

const FAKE_SIDECAR_SOURCE = `
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin });

function write(event) {
  process.stdout.write(JSON.stringify(event) + '\\n');
}

write({ type: 'ready', protocolVersion: 2 });

rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.type === 'tool_response') {
    write({ type: 'text', text: String(message.result) });
    write({ type: 'done' });
    rl.close();
    return;
  }

  write({
    type: 'tool_request',
    id: 'fake-tool-1',
    name: 'lookup',
    args: { input: message.input },
  });
});
`;

let tempDirs: string[] = [];

function makeFakeSidecar(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mango-node-sidecar-test-'));
  tempDirs.push(dir);
  const sidecarPath = join(dir, 'fake-sidecar.mjs');
  writeFileSync(sidecarPath, FAKE_SIDECAR_SOURCE);
  return sidecarPath;
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe('streamNodeSidecarEvents', () => {
  it('drives a fake provider sidecar with provider-specific protocol and tool RPC', async () => {
    const outputs: Array<NodeSidecarStreamOutput<{ type: 'text'; text: string }>> = [];
    const sidecarScriptPath = makeFakeSidecar();

    for await (const output of streamNodeSidecarEvents<{ type: 'text'; text: string }>({
      nodePath: 'node',
      sidecarScriptPath,
      request: { input: 'from-request' },
      protocolVersion: 2,
      sidecarLabel: 'Fake',
      readyTimeoutMs: 1_000,
      idleTimeoutMs: 1_000,
      turnTimeoutMs: 5_000,
      killGraceMs: 10,
      executeTool: (name, args) => {
        expect(name).toBe('lookup');
        expect(args).toEqual({ input: 'from-request' });
        return Promise.resolve({ result: 'from-api' });
      },
    })) {
      outputs.push(output);
    }

    expect(outputs).toEqual([
      {
        kind: 'tool_request',
        id: 'fake-tool-1',
        name: 'lookup',
        args: { input: 'from-request' },
      },
      { kind: 'event', event: { type: 'text', text: 'from-api' } },
    ]);
  });
});
