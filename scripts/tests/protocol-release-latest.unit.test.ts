import { describe, expect, test } from 'bun:test';

import { readText } from './support/read-text';
import { extractJobBlock, extractStepBlocks } from './support/workflow-blocks';

class FakeReleaseCommands {
  run(script: string, prerelease: boolean | string, version: string) {
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
        env: { ...process.env, VERSION: version, PRERELEASE: String(prerelease) },
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );
  }
}

function releaseScript(): string {
  const job = extractJobBlock(readText('.github/workflows/protocol-release.yml'), 'github-release');
  const step = extractStepBlocks(job).find((block) => block.includes('name: Create the release'));
  const script = step?.split('        run: |\n')[1]?.replace(/^ {10}/gm, '');
  if (script === undefined)
    throw new Error('expected the Create the release step to have a run script');
  return script;
}

describe('protocol release latest selection', () => {
  test.each([
    [false, '0.2.1'],
    [true, '0.2.1-rc.1'],
  ] as const)(
    'never replaces the application latest, prerelease=%s version=%s',
    (prerelease, version) => {
      const job = extractJobBlock(
        readText('.github/workflows/protocol-release.yml'),
        'github-release'
      );
      const step = extractStepBlocks(job).find((block) =>
        block.includes('name: Create the release')
      );
      expect(step).toBeDefined();
      const script = step?.split('        run: |\n')[1]?.replace(/^ {10}/gm, '');
      expect(script).toBeDefined();
      const result = new FakeReleaseCommands().run(script ?? '', prerelease, version);
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      const args = result.stdout.toString().trim().split('\n');
      // An optional flag contributes zero arguments on a stable release, rather
      // than an empty argument or an unbound array under macOS Bash 3.2 nounset.
      expect(args).toEqual([
        'release',
        'create',
        `protocol-v${version}`,
        '--verify-tag',
        '--latest=false',
        '--title',
        `Mango Protocol v${version}`,
        '--notes-file',
        'release-notes.md',
        ...(prerelease ? ['--prerelease'] : []),
        'mango-protocol-schema-1-protocol.json',
        'mango-protocol-schema-1-catalog.json',
      ]);
    }
  );

  test.each(['', 'True', 'yes', 'tru'])(
    'refuses to publish when the prerelease classification is %p',
    (classification) => {
      const result = new FakeReleaseCommands().run(releaseScript(), classification, '0.2.1');
      // A stable release is immutable, so anything but exact true/false must stop before gh runs.
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain(
        `Invalid prerelease classification '${classification}'; expected exactly true or false`
      );
      expect(result.stdout.toString()).toBe('');
    }
  );
});
