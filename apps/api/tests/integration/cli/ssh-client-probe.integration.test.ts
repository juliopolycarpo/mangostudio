import { describe, expect, it } from 'bun:test';

import { probeSshClient } from '../../../src/cli/ssh-client-probe';

describe('probeSshClient with the installed OpenSSH client', () => {
  // Real host startup belongs in the integration lane, after the concurrent
  // unit/root fanout. Keep the production five-second probe deadline intact.
  it.skipIf(!Bun.which('ssh'))(
    'accepts a real OpenSSH banner',
    async () => {
      const probe = await probeSshClient();
      expect(probe.error).toBeNull();
      expect(probe.version).toMatch(/OpenSSH/i);
    },
    15_000
  );
});

class HangingSshClient {
  readonly child = Bun.spawn(
    [
      process.execPath,
      '-e',
      "process.stderr.write('OpenSSH_fixture\\n'); setInterval(() => {}, 1000)",
    ],
    { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe', windowsHide: true }
  );

  spawn = () => this.child;

  async dispose(): Promise<void> {
    this.child.kill('SIGKILL');
    await this.child.exited;
  }
}

it('kills and reaps a real unresponsive version process at the probe deadline', async () => {
  const fixture = new HangingSshClient();
  try {
    const probe = await probeSshClient(process.execPath, fixture.spawn);
    expect(probe.version).toBeNull();
    expect(probe.error).toBe('ssh -V timed out after 5000 ms');
    expect(fixture.child.exitCode !== null || fixture.child.signalCode !== null).toBe(true);
    expect(await fixture.child.exited).not.toBe(0);
    expect(fixture.child.stderr.locked).toBe(false);
  } finally {
    await fixture.dispose();
  }
}, 15_000);
