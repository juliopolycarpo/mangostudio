import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import {
  classifyMcpElicitationCancelReason,
  executeStandardToolCallsWithProgress,
} from '../../../../src/modules/generation/application/standard-tool-execution';
import { isShellAvailable } from '../../../../src/services/tools/builtin/_shell-exec';
import { buildShellTool } from '../../../../src/services/tools/builtin/_shell-tool';
import { TODO_WRITE_TOOL_NAME } from '../../../../src/services/tools/builtin/todo';
import { clearRegistry, getAllTools, registerTool } from '../../../../src/services/tools/registry';
import type { RegisteredTool } from '../../../../src/services/tools/types';

const hasBash = isShellAvailable('bash');

describe('classifyMcpElicitationCancelReason', () => {
  it('distinguishes timeouts, closed sessions, and other tool failures', () => {
    expect(
      classifyMcpElicitationCancelReason(new McpError(ErrorCode.RequestTimeout, 'timed out'))
    ).toBe('tool_timeout');
    expect(
      classifyMcpElicitationCancelReason(new McpError(ErrorCode.ConnectionClosed, 'closed'))
    ).toBe('server_closed');
    expect(classifyMcpElicitationCancelReason(new Error('tool failed'))).toBe('tool_failed');
  });

  it('prefers turn abort over MCP timeout classification', () => {
    const abortError = new Error('aborted');
    abortError.name = 'AbortError';
    expect(classifyMcpElicitationCancelReason(abortError)).toBe('turn_aborted');

    const parent = new AbortController();
    parent.abort();
    expect(
      classifyMcpElicitationCancelReason(
        new McpError(ErrorCode.RequestTimeout, 'timed out'),
        parent.signal
      )
    ).toBe('turn_aborted');

    expect(
      classifyMcpElicitationCancelReason(new McpError(ErrorCode.RequestTimeout, 'timed out'))
    ).toBe('tool_timeout');
  });
});

function snapshotRegistry(): RegisteredTool[] {
  return getAllTools().map((tool) => ({
    definition: { ...tool.definition },
    settings: { ...tool.settings, parameterDescriptors: [...tool.settings.parameterDescriptors] },
    execute: tool.execute,
    buildDefinition: tool.buildDefinition,
  }));
}

function restoreRegistry(snapshot: RegisteredTool[]): void {
  clearRegistry();
  for (const tool of snapshot) {
    registerTool(tool);
  }
}

describe('executeStandardToolCallsWithProgress timeouts', () => {
  let snapshot: RegisteredTool[];
  let tempDir: string;

  beforeEach(() => {
    snapshot = snapshotRegistry();
    tempDir = mkdtempSync(join(tmpdir(), 'tool-timeout-test-'));
    clearRegistry();
    registerTool(buildShellTool('bash'));
  });

  afterEach(() => {
    restoreRegistry(snapshot);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it.skipIf(!hasBash)(
    'returns a typed timeout error and kills the shell child process',
    async () => {
      const pidFile = join(tempDir, 'pid.txt');
      const settingsByToolName = new Map([
        [
          'bash',
          {
            enabled: true,
            parameters: {
              timeoutSeconds: 5,
              maxOutputBytes: 10_000,
              allowedEnvVars: [],
              deniedEnvVars: [],
            },
          },
        ],
      ]);

      const items = [];
      for await (const item of executeStandardToolCallsWithProgress(
        [
          [
            'call-1',
            {
              name: 'bash',
              argsStr: JSON.stringify({
                command: `echo $$ > ${pidFile}; sleep 10`,
              }),
            },
          ],
        ],
        {
          userId: 'user-1',
          chatId: 'chat-1',
          settingsByToolName,
          allowedToolNames: new Set(['bash']),
        }
      )) {
        items.push(item);
      }

      const execution = items.find((item) => item.kind === 'execution');
      expect(execution?.kind).toBe('execution');
      if (execution?.kind !== 'execution') return;

      expect(execution.execution.isError).toBe(true);
      expect(execution.execution.resultStr.toLowerCase()).toContain('timed out');

      const pid = Number(readFileSync(pidFile, 'utf8').trim());
      expect(Number.isFinite(pid)).toBe(true);
      expect(() => process.kill(pid, 0)).toThrow();
    },
    15_000
  );

  it.skipIf(!hasBash)(
    'returns an abort error without a timeout message when cancelled early',
    async () => {
      const controller = new AbortController();
      const pidFile = join(tempDir, 'pid-abort.txt');
      const settingsByToolName = new Map([
        [
          'bash',
          {
            enabled: true,
            parameters: {
              timeoutSeconds: 30,
              maxOutputBytes: 10_000,
              allowedEnvVars: [],
              deniedEnvVars: [],
            },
          },
        ],
      ]);

      const run = executeStandardToolCallsWithProgress(
        [
          [
            'call-abort',
            {
              name: 'bash',
              argsStr: JSON.stringify({
                command: `echo $$ > ${pidFile}; sleep 10`,
              }),
            },
          ],
        ],
        {
          userId: 'user-1',
          chatId: 'chat-1',
          settingsByToolName,
          allowedToolNames: new Set(['bash']),
          signal: controller.signal,
        }
      );
      setTimeout(() => controller.abort(), 300);

      const items = [];
      for await (const item of run) {
        items.push(item);
      }

      const execution = items.find((item) => item.kind === 'execution');
      expect(execution?.kind).toBe('execution');
      if (execution?.kind !== 'execution') return;

      expect(execution.execution.isError).toBe(true);
      expect(execution.execution.resultStr.toLowerCase()).not.toContain('timed out');

      const pid = Number(readFileSync(pidFile, 'utf8').trim());
      expect(Number.isFinite(pid)).toBe(true);
      expect(() => process.kill(pid, 0)).toThrow();
    },
    15_000
  );
});

describe('executeStandardToolCallsWithProgress result shaping', () => {
  let snapshot: RegisteredTool[];

  beforeEach(() => {
    snapshot = snapshotRegistry();
    clearRegistry();
    registerTool({
      definition: {
        name: TODO_WRITE_TOOL_NAME,
        description: 'Return a malformed todo result',
        parameters: {},
      },
      settings: {
        title: 'Todo',
        description: 'Return a malformed todo result',
        category: 'system',
        enabledByDefault: true,
        canDisable: true,
        defaultParameters: {},
        parameterDescriptors: [],
      },
      execute: () => Promise.resolve(null),
    });
  });

  afterEach(() => {
    restoreRegistry(snapshot);
  });

  it('fails the lifecycle when a successful tool result cannot be shaped', async () => {
    const items = [];
    for await (const item of executeStandardToolCallsWithProgress(
      [['todo-1', { name: TODO_WRITE_TOOL_NAME, argsStr: '{}' }]],
      {
        userId: 'user-1',
        chatId: 'chat-1',
        settingsByToolName: new Map(),
        allowedToolNames: new Set([TODO_WRITE_TOOL_NAME]),
      }
    )) {
      items.push(item);
    }

    const statuses = items.flatMap((item) =>
      item.kind === 'event' && item.event.type === 'tool_execution'
        ? [item.event.execution.status]
        : []
    );
    expect(statuses).toEqual(['queued', 'running', 'failed']);

    const execution = items.find((item) => item.kind === 'execution');
    expect(execution?.kind).toBe('execution');
    if (execution?.kind !== 'execution') return;
    expect(execution.execution).toMatchObject({
      isError: true,
      result: { error: expect.any(String) },
      execution: { status: 'failed', reasonCode: 'execution_error' },
    });
  });
});
