import { type CiCheckIdentity, parseCiCheckEvidence } from '../../lib/ci-check-evidence';
import { readCheckReport } from './tooling';
import type { ToolingCheckStats } from './types';

/**
 * Read canonical CI evidence once; missing evidence never reruns validation.
 * @example const collectors = deliveredCheckCollectors(path, identity, roots);
 */
export function deliveredCheckCollectors(
  path: string,
  identity: CiCheckIdentity,
  roots: readonly string[],
  read: (path: string) => Promise<string> = readCheckReport
): {
  countTsErrors(root: string): Promise<number>;
  collectToolingStats(): Promise<ToolingCheckStats>;
} {
  let loaded: ReturnType<typeof load> | null = null;
  const load = async () => parseCiCheckEvidence(await read(path), identity, roots);
  const evidence = () => (loaded ??= load());
  return {
    async countTsErrors(root) {
      const report = await evidence();
      const diagnostic = report.diagnostics.find((entry) => entry.root === root);
      if (!diagnostic || diagnostic.state === 'unavailable')
        throw new Error(
          `CI Check ${root}: ${diagnostic?.state === 'unavailable' ? diagnostic.reason : 'missing TypeScript diagnostic evidence'}`
        );
      return diagnostic.errors;
    },
    async collectToolingStats() {
      const { result } = await evidence();
      if (result.state === 'unavailable')
        throw new Error(
          `CI Check unavailable: ${
            result.error ??
            result.tasks
              .filter((task) => task.state === 'unavailable')
              .map((task) => task.label)
              .join(', ')
          }`
        );
      return {
        checkExitCode: result.exitCode,
        failedTasks: result.tasks
          .filter((task) => task.state === 'executed' && task.exitCode !== 0)
          .map((task) => task.label),
      };
    },
  };
}
