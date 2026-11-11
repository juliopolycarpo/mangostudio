import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, type RmOptions, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fakeCliEnvironment, installFakeCli } from './support/fake-cli';

async function removeCanarySourceFixture(
  directory: string,
  remove: (path: string, options: RmOptions) => Promise<void> = rm
): Promise<void> {
  const options = { recursive: true, force: true };
  // Bun accepts rm's retry options but its native removal does not apply them.
  // Retry only the busy error seen after the fake Windows CLI had exited.
  for (const delayMs of [50, 100, 200, 400, 800]) {
    try {
      await remove(directory, options);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EBUSY') throw error;
      await Bun.sleep(delayMs);
    }
  }
  await remove(directory, options);
}

function fixtureRemoverFailingOnce(code: string) {
  let attempts = 0;
  return {
    get attempts() {
      return attempts;
    },
    remove(directory: string): Promise<void> {
      if (++attempts === 1) {
        return Promise.reject(
          Object.assign(new Error(`${code} removing ${directory}`), { code, path: directory })
        );
      }
      return Promise.resolve();
    },
  };
}

test('canary source cleanup retries a transient EBUSY after the CLI exits', async () => {
  const remover = fixtureRemoverFailingOnce('EBUSY');
  await removeCanarySourceFixture('canary-source-cli-fixture', remover.remove);
  expect(remover.attempts).toBe(2);
});

test('canary source cleanup preserves unexpected removal errors', async () => {
  const remover = fixtureRemoverFailingOnce('EACCES');
  await expect(
    removeCanarySourceFixture('canary-source-cli-fixture', remover.remove)
  ).rejects.toMatchObject({
    code: 'EACCES',
    path: 'canary-source-cli-fixture',
  });
  expect(remover.attempts).toBe(1);
});

// Named fake preserves the two GitHub API request shapes, including pagination.
const fakeGitHubApi = `
import { readFileSync } from 'node:fs';
const request = process.argv.slice(2).join(' ');
const files = {
  'api repos/owner/repo/actions/workflows/ci.yml': process.env.FAKE_WORKFLOW_FILE,
  'api --paginate --slurp repos/owner/repo/actions/workflows/42/runs?branch=main&event=push&status=success&per_page=100': process.env.FAKE_RUNS_FILE,
};
const file = files[request];
if (!file) throw new Error('Unexpected GitHub API request: ' + request);
process.stdout.write(readFileSync(file));
`;

test.each([true, false])('source CLI freezes API metadata; eligible=%s', async (eligible) => {
  const directory = mkdtempSync(join(tmpdir(), 'canary-source-cli-'));
  try {
    installFakeCli(directory, 'gh', fakeGitHubApi);
    const workflowFile = join(directory, 'workflow.json');
    const runsFile = join(directory, 'runs.json');
    const outputFile = join(directory, 'output');
    writeFileSync(
      workflowFile,
      JSON.stringify({ id: 42, path: '.github/workflows/ci.yml', state: 'active' })
    );
    writeFileSync(
      runsFile,
      JSON.stringify([
        {
          workflow_runs: eligible
            ? [
                {
                  id: 100,
                  run_attempt: 2,
                  run_number: 9,
                  repository: { full_name: 'owner/repo' },
                  head_repository: { full_name: 'owner/repo' },
                  workflow_id: 42,
                  path: '.github/workflows/ci.yml',
                  event: 'push',
                  head_branch: 'main',
                  status: 'completed',
                  conclusion: 'success',
                  head_sha: 'a'.repeat(40),
                  html_url: 'https://github.com/owner/repo/actions/runs/100',
                },
              ]
            : [],
        },
      ])
    );
    const result = Bun.spawnSync(['bun', './scripts/ci/select-canary-source.ts'], {
      env: {
        ...fakeCliEnvironment(directory),
        REPO: 'owner/repo',
        FAKE_WORKFLOW_FILE: workflowFile,
        FAKE_RUNS_FILE: runsFile,
        GITHUB_OUTPUT: outputFile,
      },
    });
    expect(result.exitCode).toBe(eligible ? 0 : 1);
    if (eligible) {
      expect(readFileSync(outputFile, 'utf8')).toBe(
        [
          `sha=${'a'.repeat(40)}`,
          'run_id=100',
          'run_attempt=2',
          'run_number=9',
          'run_url=https://github.com/owner/repo/actions/runs/100',
          'workflow_id=42',
          'repository=owner/repo',
          'workflow_path=.github/workflows/ci.yml',
          '',
        ].join('\n')
      );
    } else {
      expect(result.stderr.toString()).toContain(
        'No eligible completed successful main push CI run'
      );
    }
  } finally {
    await removeCanarySourceFixture(directory);
  }
});
