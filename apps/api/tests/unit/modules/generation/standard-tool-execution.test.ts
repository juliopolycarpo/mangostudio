import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeStandardToolCallsWithProgress } from '../../../../src/modules/generation/application/standard-tool-execution';
import { isShellAvailable } from '../../../../src/services/tools/builtin/_shell-exec';
import { buildShellTool } from '../../../../src/services/tools/builtin/_shell-tool';
import { clearRegistry, getAllTools, registerTool } from '../../../../src/services/tools/registry';
import type { RegisteredTool } from '../../../../src/services/tools/types';

const hasBash = isShellAvailable('bash');

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
