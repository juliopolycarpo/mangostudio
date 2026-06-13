import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const fixturePath = join(import.meta.dir, 'support', 'SHA256SUMS.sample');
const installScriptPath = join(import.meta.dir, '..', 'install', 'install.sh');

const findChecksum = (assetName: string): { exitCode: number; stdout: string; stderr: string } => {
  const result = Bun.spawnSync({
    cmd: [
      'bash',
      '-c',
      'source "$1"; find_checksum "$2" "$3"',
      'bash',
      installScriptPath,
      fixturePath,
      assetName,
    ],
  });

  return {
    exitCode: result.exitCode ?? 0,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
};

describe('install.sh find_checksum', () => {
  test('reads the shared sha256sum fixture for each supported line shape', () => {
    expect(findChecksum('mangostudio-0.1.0-linux-x64.tar.gz')).toEqual({
      exitCode: 0,
      stdout: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n',
      stderr: '',
    });
    expect(findChecksum('mangostudio-0.1.0-darwin-arm64.tar.gz')).toEqual({
      exitCode: 0,
      stdout: 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210\n',
      stderr: '',
    });
    expect(findChecksum('mangostudio-0.1.0-windows-x64.zip')).toEqual({
      exitCode: 0,
      stdout: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789\n',
      stderr: '',
    });
  });

  test('fails when the asset is missing from the manifest', () => {
    const result = findChecksum('mangostudio-0.1.0-linux-arm64.tar.gz');

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(
      'SHA256SUMS does not contain mangostudio-0.1.0-linux-arm64.tar.gz'
    );
  });
});
