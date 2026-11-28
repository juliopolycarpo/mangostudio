import { afterEach, describe, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ROOT_DIR } from '../lib/config';
import { hermeticTurboEnv } from './support/turbo-run';

/** What one real `turbo run build --dry=json` says about the frontend build task. */
interface FrontendBuildPlan {
  readonly hash: string;
  /** Hashed file path to content hash, as Turbo reports it. */
  readonly inputs: Readonly<Record<string, string>>;
}

/**
 * A throwaway git checkout holding the repository's real root `turbo.jsonc` and
 * the real `apps/frontend/turbo.json`, so Turbo hashes the shipped input list
 * over a real `.git` directory. A linked worktree cannot stand in: its `.git` is
 * a pointer file, which hides the bug this fixture exists for. The fixture never
 * touches ROOT_DIR's own `.git`.
 */
class GitCheckoutFixture {
  readonly root = realpathSync(mkdtempSync(join(tmpdir(), 'mango-frontend-git-metadata-')));

  constructor() {
    mkdirSync(join(this.root, 'apps/frontend/src'), { recursive: true });
    writeFileSync(
      join(this.root, 'package.json'),
      JSON.stringify({
        name: 'frontend-git-metadata-fixture',
        private: true,
        packageManager: 'bun@1.4.2',
        workspaces: ['apps/*'],
      })
    );
    writeFileSync(
      join(this.root, 'apps/frontend/package.json'),
      JSON.stringify({
        name: '@mangostudio/frontend',
        version: '0.0.0',
        private: true,
        scripts: { build: 'echo build' },
      })
    );
    // Turbo writes `.turbo/` logs into a workspace; unignored they would change the next hash.
    writeFileSync(join(this.root, '.gitignore'), '.turbo\n');
    writeFileSync(join(this.root, 'apps/frontend/src/main.ts'), 'export const value = 1;\n');
    copyFileSync(join(ROOT_DIR, 'turbo.jsonc'), join(this.root, 'turbo.jsonc'));
    copyFileSync(
      join(ROOT_DIR, 'apps/frontend/turbo.json'),
      join(this.root, 'apps/frontend/turbo.json')
    );
    this.git('init', '--quiet');
    this.git('add', '--all');
    this.git(
      '-c',
      'user.name=fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '--message',
      'fixture'
    );
  }

  /** Run git in the fixture; `GIT_*` from an enclosing hook must not redirect it to ROOT_DIR. */
  git(...args: string[]): void {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
    ) as Record<string, string>;
    const result = Bun.spawnSync(['git', ...args], {
      cwd: this.root,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(
      result.exitCode,
      `expected git ${args.join(' ')} to exit 0 in the fixture | received ${result.exitCode}: ${result.stderr}`
    ).toBe(0);
  }

  plan(): FrontendBuildPlan {
    const result = Bun.spawnSync(
      [
        join(ROOT_DIR, 'node_modules/.bin/turbo'),
        'run',
        'build',
        '--filter=@mangostudio/frontend',
        '--dry=json',
      ],
      {
        cwd: this.root,
        env: hermeticTurboEnv({ MANGOSTUDIO_FRONTEND_BUN_REVISION: 'fixture-revision' }),
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );
    expect(
      result.exitCode,
      `expected a successful Turbo dry run in the fixture | received ${result.exitCode}: ${result.stderr}`
    ).toBe(0);
    const summary = JSON.parse(result.stdout.toString()) as {
      tasks: { taskId: string; hash: string; inputs: Record<string, string> }[];
    };
    const task = summary.tasks.find((entry) => entry.taskId === '@mangostudio/frontend#build');
    expect(task, 'expected @mangostudio/frontend#build in the fixture Turbo graph').toBeDefined();
    return { hash: task?.hash ?? '', inputs: task?.inputs ?? {} };
  }

  dispose(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}

/** The hashed paths whose content differs between two plans, for a mismatch message. */
function differingInputs(before: FrontendBuildPlan, after: FrontendBuildPlan): string[] {
  return [...new Set([...Object.keys(before.inputs), ...Object.keys(after.inputs)])]
    .filter((path) => before.inputs[path] !== after.inputs[path])
    .sort();
}

const fixtures: GitCheckoutFixture[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.dispose();
});
function checkout(): GitCheckoutFixture {
  const fixture = new GitCheckoutFixture();
  fixtures.push(fixture);
  return fixture;
}

describe('frontend build task hash and git metadata', () => {
  test('ignores git index, ref and log churn that is not a source change', () => {
    const fixture = checkout();
    const before = fixture.plan();
    // Touching a tracked file makes the next `git status` rewrite `.git/index`,
    // which is what a test running git in the checkout does mid-lane.
    writeFileSync(join(fixture.root, 'apps/frontend/src/main.ts'), 'export const value = 1;\n');
    fixture.git('status', '--short');
    fixture.git('branch', 'unrelated-branch');
    const after = fixture.plan();
    expect(
      after.hash,
      `expected an unchanged frontend task hash after git status and git branch | differing inputs: ${JSON.stringify(differingInputs(before, after))}`
    ).toBe(before.hash);
    expect(
      Object.keys(before.inputs).filter((path) => /(^|\/)\.git\//.test(path)),
      'expected the .git exclude file as the only hashed path under .git'
    ).toEqual(['../../.git/info/exclude']);
  });

  test('still hashes .git/info/exclude, which changes what the Tailwind scanner may read', () => {
    const fixture = checkout();
    const before = fixture.plan();
    writeFileSync(join(fixture.root, '.git/info/exclude'), 'apps/frontend/src/generated\n');
    const after = fixture.plan();
    expect(
      after.hash,
      `expected a changed frontend task hash after editing .git/info/exclude | received the same ${before.hash}`
    ).not.toBe(before.hash);
  });
});
