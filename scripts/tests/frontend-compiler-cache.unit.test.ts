import { describe, expect, test } from 'bun:test';
import { delimiter, join } from 'node:path';

import { ROOT_DIR } from '../lib/config';
import { readText } from './support/read-text';
import { hermeticTurboEnv } from './support/turbo-run';

class TurboFrontendHashProbe {
  async hash(revision: string, wrapper = false): Promise<string> {
    const child = Bun.spawn(
      wrapper
        ? [
            'bun',
            join(ROOT_DIR, 'scripts/build-turbo.ts'),
            '--filter=@mangostudio/frontend',
            '--dry=json',
          ]
        : [
            join(ROOT_DIR, 'node_modules/.bin/turbo'),
            'run',
            'build',
            '--filter=@mangostudio/frontend',
            '--dry=json',
          ],
      {
        cwd: ROOT_DIR,
        env: hermeticTurboEnv({
          PATH: `${join(ROOT_DIR, 'node_modules/.bin')}${delimiter}${process.env.PATH ?? ''}`,
          MANGOSTUDIO_FRONTEND_BUN_REVISION: revision,
        }),
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code, `expected successful real Turbo hash probe; received ${stderr}`).toBe(0);
    const result = JSON.parse(stdout) as { tasks: { taskId: string; hash: string }[] };
    const task = result.tasks.find((entry) => entry.taskId === '@mangostudio/frontend#build');
    expect(task, 'expected frontend build task in real Turbo graph').toBeDefined();
    return task?.hash ?? '';
  }
}

describe('frontend compiler cache identity', () => {
  test('real Turbo separates full Bun revisions with otherwise identical inputs', async () => {
    const probe = new TurboFrontendHashProbe();
    const first = await probe.hash('a'.repeat(40));
    const second = await probe.hash('b'.repeat(40));
    expect(
      second,
      'expected distinct frontend task hashes for distinct producer Bun commits'
    ).not.toBe(first);
    expect(await probe.hash('a'.repeat(40))).toBe(first);
  });
  test('maintained Turbo wrapper uses its executing Bun commit rather than inherited values', async () => {
    const probe = new TurboFrontendHashProbe();
    const expected = await probe.hash(Bun.revision);
    expect(await probe.hash('a'.repeat(40), true)).toBe(expected);
    expect(await probe.hash('b'.repeat(40), true)).toBe(expected);
  });

  test('both build entrypoints override inherited compiler identity before Turbo lookup', () => {
    expect(
      readText('scripts/build.ts').match(/MANGOSTUDIO_FRONTEND_BUN_REVISION: Bun\.revision/g)
    ).toHaveLength(2);
    expect(readText('scripts/build-turbo.ts')).toContain(
      'MANGOSTUDIO_FRONTEND_BUN_REVISION: Bun.revision'
    );
  });
});
