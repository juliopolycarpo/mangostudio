import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/** Install a named monitor fake in a child CLI while retaining its real child scope.
 * Example: const preload = await fakeBenchmarkResources(directory, 'remaining');
 */
export async function fakeBenchmarkResources(
  directory: string,
  mode: 'remaining' | 'late-sample'
): Promise<{ preload: string; env: Record<string, string> }> {
  const preload = join(directory, 'resource-monitor-preload.ts');
  await writeFile(
    preload,
    `import { mock } from 'bun:test';
import { join } from 'node:path';
class FakeBenchmarkResourceMonitor {
  constructor(pid) { this.pid = pid; }
  async markReady() {}
  async stop() {
    const remaining = process.env.BENCHMARK_RESOURCE_MODE === 'remaining';
    const root = { pid: this.pid, parentPid: process.pid, group: this.pid, command: 'fixture root', startTicks: 1, userTicks: 0, systemTicks: 0, rssBytes: 4096 };
    const child = { ...root, pid: 900001, parentPid: this.pid, startTicks: 100, command: 'resource-only child' };
    const frames = [{ atMs: 1, processes: [root, child] }, { atMs: 2, processes: remaining ? [{ ...child, parentPid: 1, group: child.pid }] : [] }];
    return {
      intervalMs: 10, clockOriginMs: 0, readinessAtMs: remaining ? 1 : 0, measurementEndMs: remaining ? 1 : 0,
      errors: [], frames,
      summary: {
        sampleCount: remaining ? 1 : 0, observedProcessCount: remaining ? 2 : 0,
        peakSampledRssBytes: remaining ? 8192 : null,
        sampledUserCpuMs: remaining ? 0 : null, sampledSystemCpuMs: remaining ? 0 : null,
        cpuResolutionMs: 10, remainingIdentities: remaining ? ['900001:100'] : [], frames,
      },
    };
  }
}
mock.module(join(process.env.BENCHMARK_SOURCE_ROOT, 'scripts/lib/process-resource-monitor.ts'), () => ({
  startProcessResourceMonitor: async (pid) => new FakeBenchmarkResourceMonitor(pid),
}));
`
  );
  return {
    preload,
    env: {
      BENCHMARK_SOURCE_ROOT: resolve(import.meta.dir, '../../..'),
      BENCHMARK_RESOURCE_MODE: mode,
    },
  };
}
