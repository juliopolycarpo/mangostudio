import { expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { probeIsolatedRuntime } from '../lib/binary-runtime-smoke';
import { fakeIsolatedRuntime } from './support/fake-isolated-runtime';

interface RuntimeObservation {
  pid: number;
  cwd: string;
  executable: string;
  home: string;
  profile: string;
  runtime?: string;
  developerSetting?: string;
  path: string;
}

test.skipIf(process.platform === 'win32').each([false, true])(
  'runtime probes use a copied artifact and allowlisted home/environment with temp alias=%s',
  async (alias) => {
    const originalTmp = process.env.TMPDIR;
    const aliasRoot = mkdtempSync(join(tmpdir(), 'runtime-temp-alias-'));
    if (alias) {
      symlinkSync(tmpdir(), join(aliasRoot, 'tmp'));
      process.env.TMPDIR = join(aliasRoot, 'tmp');
    }
    const checkout = mkdtempSync(join(tmpdir(), 'test-native-artifact-coverage-runtime-'));
    const binary = join(checkout, 'fake-runtime');
    writeFileSync(binary, `#!${process.execPath}\n(${fakeIsolatedRuntime.toString()})();`);
    chmodSync(binary, 0o755);
    try {
      const result = await probeIsolatedRuntime(binary, checkout, {
        HOME: checkout,
        USERPROFILE: checkout,
        MANGO_PROBE_PRIVATE_SETTING: 'developer-only',
        MANGOSTUDIO_RUNTIME_BINARY: binary,
        PATH: join(checkout, 'node_modules/.bin'),
      });
      expect(result.versionExit).toBe(0);
      const version = JSON.parse(result.version) as RuntimeObservation;
      const hello = JSON.parse(result.probe.hello ?? 'null') as {
        type: string;
        observation: RuntimeObservation;
      };
      expect(hello.type).toBe('hello');
      expect(result.probe.stderr).toContain('runtime shutdown completed');
      for (const observation of [version, hello.observation]) {
        const physicalHome = join(
          realpathSync(dirname(observation.home)),
          basename(observation.home)
        );
        const physicalExecutableDir = join(
          realpathSync(dirname(dirname(observation.executable))),
          basename(dirname(observation.executable))
        );
        expect(observation.cwd).not.toBe(realpathSync(checkout));
        expect(observation.cwd).toBe(physicalExecutableDir);
        expect(observation.cwd).toBe(physicalHome);
        expect(observation.profile).toBe(observation.home);
        expect(observation.runtime).toBeUndefined();
        expect(observation.developerSetting).toBeUndefined();
        expect(observation.path).toBe('');
        expect(existsSync(observation.cwd)).toBe(false);
        expect(() => process.kill(observation.pid, 0)).toThrow();
      }
      expect(hello.observation.cwd).toBe(version.cwd);
    } finally {
      rmSync(checkout, { recursive: true, force: true });
      if (originalTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = originalTmp;
      rmSync(aliasRoot, { recursive: true, force: true });
    }
  }
);

test.skipIf(process.platform === 'win32')(
  'runtime shutdown settles descendants retaining inherited pipes within its budget',
  async () => {
    const checkout = mkdtempSync(join(tmpdir(), 'test-native-artifact-coverage-pipes-'));
    const binary = join(checkout, 'fake-runtime');
    const report = join(checkout, 'report.json');
    writeFileSync(
      binary,
      `#!${process.execPath}\n(${fakeIsolatedRuntime.toString()})(${JSON.stringify(report)});`
    );
    chmodSync(binary, 0o755);
    const pending = probeIsolatedRuntime(binary, checkout, {}, { budgetMs: 100 });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          deadline = setTimeout(
            () =>
              reject(new Error('runtime inherited pipes: expected bounded cleanup within 1000ms')),
            1000
          );
        }),
      ]);
      const observed = JSON.parse(readFileSync(report, 'utf8')) as RuntimeObservation & {
        descendant: number;
      };
      expect(() => process.kill(observed.pid, 0)).toThrow();
      expect(() => process.kill(observed.descendant, 0)).toThrow();
      expect(existsSync(observed.home)).toBe(false);
    } finally {
      clearTimeout(deadline);
      if (existsSync(report)) {
        const observed = JSON.parse(readFileSync(report, 'utf8')) as RuntimeObservation & {
          descendant: number;
        };
        for (const pid of [observed.descendant, observed.pid]) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            /* Already settled. */
          }
        }
      }
      await pending.catch(() => undefined);
      rmSync(checkout, { recursive: true, force: true });
    }
  }
);
