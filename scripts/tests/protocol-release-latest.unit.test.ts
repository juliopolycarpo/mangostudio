import { describe, expect, test } from 'bun:test';

import { readText } from './support/read-text';
import { extractJobBlock, extractStepBlocks } from './support/workflow-blocks';

class FakeReleaseCommands {
  run(script: string, prerelease: boolean) {
    return Bun.spawnSync(
      [
        'bash',
        '-c',
        `
        cp() { :; }
        gh() {
          if [ "$2" = view ]; then return 1; fi
          printf '%s\\n' "$@"
        }
        ${script}
        `,
      ],
      {
        env: { ...process.env, VERSION: '0.2.1', PRERELEASE: String(prerelease) },
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );
  }
}

describe('protocol release latest selection', () => {
  test.each([false, true])('never replaces the application latest, prerelease=%s', (prerelease) => {
    const job = extractJobBlock(
      readText('.github/workflows/protocol-release.yml'),
      'github-release'
    );
    const step = extractStepBlocks(job).find((block) => block.includes('name: Create the release'));
    expect(step).toBeDefined();
    const script = step?.split('        run: |\n')[1]?.replace(/^ {10}/gm, '');
    expect(script).toBeDefined();
    const result = new FakeReleaseCommands().run(script ?? '', prerelease);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const args = result.stdout.toString().trim().split('\n');
    expect(args.slice(0, 3)).toEqual(['release', 'create', 'protocol-v0.2.1']);
    expect(args).toContain('--latest=false');
    expect(args.includes('--prerelease')).toBe(prerelease);
  });
});
