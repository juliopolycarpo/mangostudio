import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { hostReleasePlatform } from '../lib/bun-cross-runtime';
import { FakeNativeBuildInputs } from './support/fake-native-build-inputs';

const platform = hostReleasePlatform();

// This fixture uses POSIX command wrappers and a Bun-backed fake runtime.
// Windows and static-musl runtimes need their real artifact smoke gates.
test.skipIf(!platform || platform.startsWith('windows') || platform.endsWith('-musl'))(
  'native packaging uses the running compiler and root tsconfig for its emitted hub',
  async () => {
    if (!platform) throw new Error('expected supported native fixture host');
    const fake = new FakeNativeBuildInputs(platform);
    try {
      await fake.prepare();
      const built = fake.run();
      expect(built.exitCode, `${built.stdout.toString()}\n${built.stderr.toString()}`).toBe(0);
      const hub = join(fake.root, '.mango/out', platform, 'mangostudio');
      const result = Bun.spawnSync([hub], { stdout: 'pipe', stderr: 'pipe', timeout: 5000 });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(result.stdout.toString().trim()).toBe('root-config');
      const receipt = JSON.parse(
        readFileSync(join(fake.root, '.mango/hub-builds', `${platform}.json`), 'utf8')
      );
      expect(receipt.compilerSha256).toBe(
        createHash('sha256').update(readFileSync(process.execPath)).digest('hex')
      );
      expect(receipt.hubSha256).toBe(createHash('sha256').update(readFileSync(hub)).digest('hex'));
    } finally {
      fake.dispose();
    }
  },
  60000
);
