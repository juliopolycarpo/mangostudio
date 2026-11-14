#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';

import { canarySourceRunsQuery, selectCanarySource } from '../lib/canary-source';
import { requiredEnv } from '../lib/runner';

const repository = requiredEnv('REPO');
const workflowResult = Bun.spawnSync(['gh', 'api', `repos/${repository}/actions/workflows/ci.yml`]);
if (workflowResult.exitCode !== 0)
  throw new Error(`CI workflow lookup failed: ${workflowResult.stderr}`);
const workflow = JSON.parse(workflowResult.stdout.toString());
if (workflow.path !== '.github/workflows/ci.yml' || workflow.state !== 'active') {
  throw new Error(
    `Expected active .github/workflows/ci.yml, received: ${JSON.stringify(workflow)}`
  );
}
// The clock is read once, here at the entrypoint; the shared query derives the window from it.
const query = canarySourceRunsQuery(`repos/${repository}`, workflow.id, new Date());
const runsResult = Bun.spawnSync(['gh', 'api', '--paginate', '--slurp', query.path]);
if (runsResult.exitCode !== 0) throw new Error(`CI run lookup failed: ${runsResult.stderr}`);
const pages = JSON.parse(runsResult.stdout.toString());
const source = selectCanarySource(
  pages.flatMap((page: { workflow_runs: unknown[] }) => page.workflow_runs),
  repository,
  workflow.id,
  { since: query.since }
);
appendFileSync(
  requiredEnv('GITHUB_OUTPUT'),
  [
    `sha=${source.sourceSha}`,
    `run_id=${source.runId}`,
    `run_attempt=${source.runAttempt}`,
    `run_number=${source.runNumber}`,
    `run_url=${source.runUrl}`,
    `workflow_id=${source.workflowId}`,
    `repository=${source.repository}`,
    `workflow_path=${source.workflowPath}`,
    '',
  ].join('\n')
);
console.log(JSON.stringify(source, null, 2));
