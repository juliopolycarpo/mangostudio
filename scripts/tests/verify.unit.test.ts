import { describe, expect, test } from 'bun:test';
import { ROOT_DIR } from '../lib/config';

describe('verify usage', () => {
  test('names its local phases and the protocol TypeScript complement', () => {
    const result = Bun.spawnSync([process.execPath, './scripts/verify.ts', '--help'], {
      cwd: ROOT_DIR,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stderr = new TextDecoder().decode(result.stderr);
    expect(result.exitCode, `verify --help must exit 0; received stderr: ${stderr}`).toBe(0);
    const output = new TextDecoder().decode(result.stdout);
    expect(output).toContain('check → test --coverage → build --all');
    expect(output).toContain('bun run protocol:test --ts-only');
    expect(output).toContain('full Rust and protocol contributor gates');
  });
});
