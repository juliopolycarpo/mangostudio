import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { createProfileSetupInspector } from '../../../../src/modules/environments/infrastructure/profile-setup';

const HOME = '/home/tester';

describe('profile setup inspection', () => {
  it('reports only profiles containing every expected line', async () => {
    const lines = ['export BUN_INSTALL="$HOME/.bun"', 'export PATH="$BUN_INSTALL/bin:$PATH"'];
    const inspect = createProfileSetupInspector({
      homeDirectory: HOME,
      readFile(path) {
        if (path.endsWith('.zshrc')) return Promise.resolve(lines.join('\n'));
        if (path.endsWith('.bashrc')) return Promise.resolve(lines[0] ?? '');
        return Promise.reject(new Error('Profile does not exist.'));
      },
    });

    await expect(inspect(lines)).resolves.toEqual({
      lines,
      present: true,
      detectedIn: [join(HOME, '.zshrc')],
    });
  });
});
