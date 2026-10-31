import { describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';

describe('Rust baseline execution boundary', () => {
  it('prints a complete frozen schedule without starting compilation by default', async () => {
    const child = Bun.spawn([process.execPath, 'scripts/bench/rust-costs.ts'], {
      cwd: resolve(import.meta.dir, '../..'),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stderr).toBe('');
    expect(exit).toBe(0);
    const schedule = JSON.parse(stdout) as {
      jobs: number;
      workloads: Array<{ label: string }>;
      startup: { warmups: number; measured: number };
      comparison: string;
    };
    expect(schedule.jobs).toBe(8);
    expect(schedule.workloads).toHaveLength(26);
    expect(schedule.startup).toMatchObject({ warmups: 2, measured: 20 });
    expect(schedule.comparison).toContain('no optimization candidate');
  });
});
