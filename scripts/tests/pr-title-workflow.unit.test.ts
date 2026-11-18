import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT_DIR } from '../lib/config';
import { readText } from './support/read-text';

const WORKFLOW = '.github/workflows/pr-title.yml';
const EXPRESSION_OPEN = '$' + '{{';

interface Step {
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string | boolean>;
}
interface Workflow {
  on: { pull_request: { branches: string[]; types: string[] } };
  permissions: Record<string, string>;
  jobs: Record<string, { name: string; permissions: Record<string, string>; steps: Step[] }>;
}

const workflow = Bun.YAML.parse(readText(WORKFLOW)) as Workflow;
const job = workflow.jobs.title;
const steps = job?.steps ?? [];

describe('PR title workflow', () => {
  test('runs on the pull_request events that can change a title or its base', () => {
    expect(Object.keys(workflow.on)).toEqual(['pull_request']);
    expect(workflow.on.pull_request.types).toEqual(['opened', 'edited', 'synchronize', 'reopened']);
    expect(workflow.on.pull_request.branches).toEqual(['main']);
  });

  test('holds read-only contents and nothing else, and reads no secret', () => {
    expect(workflow.permissions).toEqual({});
    expect(job?.permissions).toEqual({ contents: 'read' });
    expect(readText(WORKFLOW)).not.toMatch(/secrets\.|GITHUB_TOKEN|github\.token/);
  });

  test("checks out the base branch, never the pull request's head", () => {
    const checkout = steps.find((step) => step.uses?.startsWith('actions/checkout@'));
    expect(checkout?.with?.ref, 'checkout ref').toBe(
      `${EXPRESSION_OPEN} github.event.pull_request.base.ref }}`
    );
    expect(checkout?.with?.['persist-credentials']).toBe(false);
    expect(readText(WORKFLOW)).not.toMatch(/pull_request\.head|merge_commit|github\.sha/);
  });

  test('loads Bun from that same checkout, so the head cannot supply the tool setup', () => {
    const uses = steps.map((step) => step.uses ?? '');
    expect(uses.some((value) => value.startsWith('./.github/actions/setup-bun'))).toBe(true);
    expect(uses.some((value) => value.startsWith('$/'))).toBe(false);
  });

  test('passes the title through the environment and runs the script it checked out', () => {
    const check = steps.find((step) => step.run?.includes('check-pr-title'));
    expect(check?.env?.PR_TITLE).toBe(`${EXPRESSION_OPEN} github.event.pull_request.title }}`);
    expect(check?.run).not.toContain(EXPRESSION_OPEN);
    expect(check?.run).toContain('bun scripts/ci/check-pr-title.ts "$PR_TITLE"');
    expect(existsSync(join(ROOT_DIR, 'scripts', 'ci', 'check-pr-title.ts'))).toBe(true);
  });
});
