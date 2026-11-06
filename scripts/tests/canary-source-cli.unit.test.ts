import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fakeCliEnvironment, installFakeCli } from './support/fake-cli';

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

test.each([true, false])('source CLI freezes API metadata; eligible=%s', (eligible) => {
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
    rmSync(directory, { recursive: true, force: true });
  }
});
