import { afterEach, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearFileFreshness } from '../../../../../src/services/tools/file-freshness';
import { clearRegistry } from '../../../../../src/services/tools/registry';
import type { ToolContext } from '../../../../../src/services/tools/types';

export interface ToolRegistryHarness {
  /** Temp directory recreated before every test in the enclosing describe. */
  readonly dir: string;
  /** Absolute path inside the temp directory. */
  path(...segments: string[]): string;
  /** Context whose chat workdir is the temp directory. */
  context(parameters?: Record<string, unknown>): ToolContext;
  /** Context with no workdir bound, for the "relative path has no anchor" cases. */
  contextWithoutWorkdir(parameters?: Record<string, unknown>): ToolContext;
}

/**
 * Gives the enclosing describe a registry holding only the given tools plus a
 * fresh temp workdir per test. Registry-contract suites use it to reach tools
 * through `executeTool`, which is where raw argument parsing actually happens.
 *
 * // Usage: const harness = useToolRegistry('grep-registry', registerGrepTool);
 */
export function useToolRegistry(
  prefix: string,
  ...registrars: Array<() => void>
): ToolRegistryHarness {
  let dir = '';

  beforeEach(() => {
    clearFileFreshness();
    clearRegistry();
    for (const register of registrars) register();
    dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  });

  afterEach(() => {
    clearFileFreshness();
    clearRegistry();
    rmSync(dir, { recursive: true, force: true });
  });

  return {
    get dir() {
      return dir;
    },
    path: (...segments) => join(dir, ...segments),
    context: (parameters = {}) => ({ userId: 'u1', chatId: 'c1', parameters, workdir: dir }),
    contextWithoutWorkdir: (parameters = {}) => ({ userId: 'u1', chatId: 'c1', parameters }),
  };
}
