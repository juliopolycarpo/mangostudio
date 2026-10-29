import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

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

test.skipIf(process.platform === 'win32')(
  'runtime probes use a copied artifact and allowlisted home/environment, settling before removal',
  async () => {
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
        expect(observation.cwd).not.toBe(checkout);
        expect(observation.cwd).toBe(dirname(observation.executable));
        expect(observation.home).toBe(observation.cwd);
        expect(observation.profile).toBe(observation.cwd);
        expect(observation.runtime).toBeUndefined();
        expect(observation.developerSetting).toBeUndefined();
        expect(observation.path).toBe('');
        expect(existsSync(observation.cwd)).toBe(false);
        expect(() => process.kill(observation.pid, 0)).toThrow();
      }
      expect(hello.observation.cwd).toBe(version.cwd);
    } finally {
      rmSync(checkout, { recursive: true, force: true });
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
