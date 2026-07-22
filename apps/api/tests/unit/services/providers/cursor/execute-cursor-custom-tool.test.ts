import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeCursorCustomTool } from '../../../../../src/services/providers/cursor/index';
import * as toolRegistry from '../../../../../src/services/tools/registry';
import type { ToolContext } from '../../../../../src/services/tools/types';

let capturedContext: ToolContext | undefined;

afterEach(() => {
  capturedContext = undefined;
});

describe('executeCursorCustomTool', () => {
  it('forwards workdir and workdirPolicy into executeTool context', async () => {
    const spy = spyOn(toolRegistry, 'executeTool').mockImplementation((_name, _args, context) => {
      capturedContext = context;
      return Promise.resolve({ ok: true });
    });
    const workdir = mkdtempSync(join(tmpdir(), 'cursor-workdir-'));
    try {
      const policy = { root: workdir, restricted: true as const };
      await executeCursorCustomTool(
        {
          userId: 'user-1',
          chatId: 'chat-1',
          workdir,
          workdirPolicy: policy,
        },
        new Set(['read_file']),
        'read_file',
        { path: join(workdir, 'inside.txt') }
      );

      expect(capturedContext?.workdir).toBe(workdir);
      expect(capturedContext?.workdirPolicy).toEqual(policy);
    } finally {
      spy.mockRestore();
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  it('rejects paths outside the workdir when restriction is enabled', async () => {
    const workdir = mkdtempSync(join(tmpdir(), 'cursor-restrict-'));
    const outsidePath = join(tmpdir(), `outside-cursor-${Date.now()}.txt`);
    await Bun.write(outsidePath, 'secret');
    try {
      const result = await executeCursorCustomTool(
        {
          userId: 'user-1',
          chatId: 'chat-1',
          workdir,
          workdirPolicy: { root: workdir, restricted: true },
        },
        new Set(['read_file']),
        'read_file',
        { path: outsidePath }
      );

      expect(result.isError).toBe(true);
      expect(result.error).toContain('outside the chat working directory');
    } finally {
      rmSync(workdir, { recursive: true, force: true });
      rmSync(outsidePath, { force: true });
    }
  });
});
