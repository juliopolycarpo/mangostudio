import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startRustServe } from '../../support/rust-serve-runtime';

class NativeServeStartupFixture {
  directory = '';
  binary = '';
  async compile() {
    this.directory = await mkdtemp(join(tmpdir(), 'mcp-serve-native-control-'));
    this.binary = join(
      this.directory,
      process.platform === 'win32' ? 'serve-fixture.exe' : 'serve-fixture'
    );
    const source = new URL('../../support/fixtures/mcp/serve-startup-runtime.ts', import.meta.url);
    const compiler = Bun.spawn(
      [process.execPath, 'build', '--compile', fileURLToPath(source), '--outfile', this.binary],
      {
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );
    const [stdout, stderr, exit] = await Promise.all([
      new Response(compiler.stdout).text(),
      new Response(compiler.stderr).text(),
      compiler.exited,
    ]);
    if (exit !== 0)
      throw new Error(
        `Expected native fixture compilation exit 0; received ${exit}: ${stdout} ${stderr}`
      );
  }
  async receipt(journal: string) {
    return (await Bun.file(journal).json()) as { pid: number; mangoHome: string; home: string };
  }
  async expectReleased(journal: string) {
    const receipt = await this.receipt(journal);
    expect(
      await access(join(receipt.mangoHome, '..')).then(
        () => true,
        () => false
      )
    ).toBe(false);
    expect(
      await access(join(receipt.home, '..')).then(
        () => true,
        () => false
      )
    ).toBe(false);
    expect(() => process.kill(receipt.pid, 0)).toThrow();
  }
}

const native = new NativeServeStartupFixture();
beforeAll(() => native.compile());
afterAll(async () => {
  await rm(native.directory, { recursive: true, force: true });
});

describe('native serve readiness cleanup', () => {
  it('preserves early exit status and stderr and removes both owned homes', async () => {
    const journal = join(native.directory, 'exit.json');
    const result = await startRustServe(native.binary, {
      label: 'named-early-exit',
      token: JSON.stringify({ mode: 'exit', journal }),
    }).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(Error);
    expect(String(result)).toContain('exit 17: NAMED_SERVE_STARTUP_EXIT');
    await native.expectReleased(journal);
  });

  it('aborts an actual pending health response with the caller deadline and releases the child', async () => {
    const journal = join(native.directory, 'pending.json');
    const deadline = new AbortController();
    const pending = startRustServe(native.binary, {
      label: 'named-pending-health',
      token: JSON.stringify({ mode: 'pending-health', journal }),
      signal: deadline.signal,
    }).catch((error: unknown) => error);
    const expired = new Error('named common startup deadline');
    try {
      const limit = Date.now() + 2000;
      while (!(await Bun.file(journal).exists()) && Date.now() < limit) await Bun.sleep(10);
      expect(await Bun.file(journal).exists()).toBe(true);
    } finally {
      deadline.abort(expired);
      await pending;
    }
    expect(await pending).toBe(expired);
    await native.expectReleased(journal);
  });
});
