import { describe, expect, it } from 'bun:test';
import {
  pushRuntimeBinary,
  type RuntimeCommandOptions,
  type RuntimeCommandResult,
  type RuntimeCommandRunner,
  RuntimePushError,
  runtimePushArchiveScript,
  runtimePushBinaryScript,
  runtimeSlotBytesScript,
  runtimeSlotShellPath,
  runtimeVersionScript,
} from '../../../../src/modules/environments/domain/runtime-push';

function ok(stdout = ''): RuntimeCommandResult {
  return { stdout, stderr: '', exitCode: 0 };
}

describe('runtimeSlotShellPath', () => {
  it('quotes a slot path for the target shell with $HOME expanded there', () => {
    expect(runtimeSlotShellPath('wsl')).toBe('"$HOME/.mango/runtime/wsl"');
    expect(runtimeSlotShellPath('remote', '$1', 'mangostudio-runtime')).toBe(
      '"$HOME/.mango/runtime/remote/$1/mangostudio-runtime"'
    );
  });
});

describe('runtime push scripts', () => {
  it('stages, publishes, and prunes for both binary and archive installs', () => {
    for (const script of [runtimePushBinaryScript('wsl'), runtimePushArchiveScript('remote')]) {
      expect(script).toContain('mv -f ');
      expect(script).toContain('ln -sfn "$1"');
      expect(script).toContain('rm -rf "$d"');
      expect(script).toContain('readlink');
    }
    expect(runtimePushBinaryScript('wsl')).toContain('cat > ');
    expect(runtimePushArchiveScript('wsl')).toContain('tar -xzf - -O mangostudio-runtime');
    expect(runtimeVersionScript('remote')).toContain(
      '"$HOME/.mango/runtime/remote/current/mangostudio-runtime"'
    );
  });

  it('falls back from GNU du -sb to du -sk when -b is unavailable', () => {
    const script = runtimeSlotBytesScript('remote');
    expect(script).toContain('if out=$(du -sb');
    expect(script).toContain('elif out=$(du -sk');
    expect(script).toContain("awk '{print $1*1024}'");
    expect(script).toContain('else echo 0; fi');
    // Pipeline-only fallback would never run: awk exits 0 on empty stdin.
    expect(script).not.toMatch(/du -sb[^|]*\|[^|]*awk[^|]*\|\|\s*du -sk/);
  });
});

describe('pushRuntimeBinary', () => {
  it('pushes bytes, verifies version, and refuses a version mismatch', async () => {
    const calls: Array<{ script: string; options?: RuntimeCommandOptions }> = [];
    const runner: RuntimeCommandRunner = (script, options) => {
      calls.push({ script, options });
      if (script.includes('cat > ')) return Promise.resolve(ok());
      if (script.includes('--version')) return Promise.resolve(ok('1.2.3\n'));
      return Promise.resolve(ok());
    };

    await pushRuntimeBinary({
      runner,
      slot: 'wsl',
      version: '1.2.3',
      bytes: new TextEncoder().encode('runtime'),
    });

    expect(calls[0]?.options?.args).toEqual(['1.2.3']);
    expect(calls[0]?.options?.stdin?.byteLength).toBe(7);
    expect(calls[1]?.script).toContain('--version');
  });

  it('throws when the installed binary reports the wrong version', async () => {
    const runner: RuntimeCommandRunner = (script) => {
      if (script.includes('cat > ')) return Promise.resolve(ok());
      return Promise.resolve(ok('9.9.9\n'));
    };

    await expect(
      pushRuntimeBinary({
        runner,
        slot: 'remote',
        version: '1.2.3',
        bytes: new Uint8Array([1, 2, 3]),
      })
    ).rejects.toBeInstanceOf(RuntimePushError);
  });
});
