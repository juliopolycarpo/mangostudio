import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Named fake preserves the two GitHub API request shapes, including pagination.
const fakeGitHubApi = `#!/bin/bash
set -euo pipefail
case "$*" in
  "api repos/owner/repo/actions/workflows/ci.yml") cat "$FAKE_WORKFLOW_FILE" ;;
  "api --paginate --slurp repos/owner/repo/actions/workflows/42/runs?branch=main&event=push&status=success&per_page=100") cat "$FAKE_RUNS_FILE" ;;
  *) echo "Unexpected GitHub API request: $*" >&2; exit 2 ;;
esac
`;

test.each([true, false])('source CLI freezes API metadata; eligible=%s', (eligible) => {
  const directory = mkdtempSync(join(tmpdir(), 'canary-source-cli-'));
  try {
    writeFileSync(join(directory, 'gh'), fakeGitHubApi);
    chmodSync(join(directory, 'gh'), 0o755);
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
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
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
