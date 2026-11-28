import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

import { ROOT_DIR } from '../lib/config';
import { readText } from './support/read-text';
import { extractJobBlock } from './support/workflow-blocks';

const LABELER_WORKFLOW = '.github/workflows/labeler.yml';

interface WorkflowStep {
  id?: string;
  name?: string;
  if?: string;
  uses?: string;
  run?: string;
  'continue-on-error'?: boolean;
  with?: { script?: string };
}

/** Owner routing shares the required labeling job (#2700), so its steps are read from labeler.yml. */
function labelJobSteps(): WorkflowStep[] {
  const workflow = Bun.YAML.parse(readText(LABELER_WORKFLOW)) as {
    jobs: { label: { steps: WorkflowStep[] } };
  };
  return workflow.jobs.label.steps;
}

function routingStep(): WorkflowStep {
  const step = labelJobSteps().find((candidate) => candidate.id === 'route');
  if (!step) throw new Error(`expected a step with id route in ${LABELER_WORKFLOW}`);
  return step;
}

describe('owner routing inside the labeler job', () => {
  test('runs safely on pull request metadata without checking out PR code', () => {
    const workflow = readText(LABELER_WORKFLOW);
    const job = extractJobBlock(workflow, 'label');

    expect(workflow).toContain('pull_request_target:');
    expect(workflow).toContain('ready_for_review');
    expect(job).toContain('contents: read');
    expect(job).toContain('issues: write');
    expect(job).toContain('pull-requests: write');
    expect(workflow).not.toContain('actions/checkout');
  });

  test('skips drafts on the step, never the job, so the required check still reports', () => {
    const job = extractJobBlock(readText(LABELER_WORKFLOW), 'label');

    // A job-level `if` on a draft would leave `Apply path-based labels` skipped (and the
    // required check satisfied by nothing) on every draft push.
    expect(job).not.toMatch(/^ {4}if:/m);
    expect(routingStep().if).toContain('!github.event.pull_request.draft');
  });

  test('never lets a routing failure fail the required check', () => {
    const steps = labelJobSteps();
    const route = routingStep();
    const warn = steps.find((step) => step.name === 'Warn that owner routing failed');

    expect(route['continue-on-error']).toBe(true);
    // Routing still runs after a failed classification, and a cancel still stops it.
    expect(route.if).toContain('!cancelled()');
    expect(warn?.run, 'expected a visible warning step for a failed routing step').toContain(
      '::warning'
    );
    expect(warn?.if).toContain("steps.route.outcome == 'failure'");
    // Classification stays fatal: only the routing step may be continue-on-error.
    expect(
      steps.filter((step) => step['continue-on-error'] === true).map((step) => step.id)
    ).toEqual(['route']);
  });

  test('derives reviewers from changed-file history with no static owner config', () => {
    const workflow = readText(LABELER_WORKFLOW);

    expect(workflow).toContain('listFiles');
    expect(workflow).toContain('listCommits');
    expect(workflow).toContain('sha: pr.base.ref');
    // No hand-maintained per-label routing config or hardcoded owner.
    expect(workflow).not.toContain('getContent');
    expect(workflow).not.toContain('juliopolycarpo');
  });

  test.each([
    { failures: [500, 500], calls: 3, delays: [1000, 2000], error: undefined },
    { failures: [500, 500, 500], calls: 3, delays: [1000, 2000], error: 'GitHub HTTP 500' },
    { failures: [404], calls: 1, delays: [], error: 'GitHub HTTP 404' },
  ])('retries only a bounded transient PR-files read ($failures)', async (scenario) => {
    const script = routingStep().with?.script;
    expect(script).toBeString();
    const delays: number[] = [];
    let calls = 0;
    function fakeListFiles() {
      const status = scenario.failures[calls++];
      if (status)
        return Promise.reject(Object.assign(new Error(`GitHub HTTP ${status}`), { status }));
      return Promise.resolve({ data: [] });
    }
    function fakeGetPull() {
      return Promise.resolve({ data: {} });
    }
    function fakeListReviews() {
      return Promise.resolve([]);
    }
    function fakeDelay(callback: () => void, milliseconds: number) {
      delays.push(milliseconds);
      callback();
    }
    const github = {
      rest: { pulls: { listFiles: fakeListFiles, get: fakeGetPull } },
      paginate: fakeListReviews,
    };
    const context = {
      repo: { owner: 'mango', repo: 'studio' },
      payload: { pull_request: { number: 42 } },
    };
    function discardLog() {}
    // Execute only the trusted repository's workflow text against named API fakes.
    const execution = runInNewContext(`(async () => {${script}})()`, {
      github,
      context,
      core: { info: discardLog },
      setTimeout: fakeDelay,
    }) as Promise<void>;
    const result = await execution.catch((error: unknown) =>
      error instanceof Error ? error.message : String(error)
    );
    expect({ calls, delays, error: result }).toEqual({
      calls: scenario.calls,
      delays: [...scenario.delays],
      error: scenario.error,
    });
  });

  test('assigns the author and requests reviewers without the author or bots', () => {
    const workflow = readText(LABELER_WORKFLOW);

    expect(workflow).toContain('addAssignees');
    expect(workflow).toContain('assignees: [authorLogin]');
    expect(workflow).toContain('requestReviewers');
    expect(workflow).toContain('login === authorLogin');
    expect(workflow).toContain('isBot');
  });

  test('does not re-ping reviewers who already reviewed or are pending', () => {
    const workflow = readText(LABELER_WORKFLOW);

    expect(workflow).toContain('listReviews');
    expect(workflow).toContain('requested_reviewers');
    expect(workflow).toContain('handledReviewers');
  });

  test('classifies the workflow as CI work', () => {
    const labeler = readText('.github/labeler.yml');

    expect(labeler).toContain('".github/workflows/**"');
  });

  test('runs once per push: no separate auto-assign workflow remains', () => {
    // Two pull_request_target workflows meant two runner waits per push under the 20-job cap.
    expect(existsSync(join(ROOT_DIR, '.github/workflows/auto-assign.yml'))).toBe(false);
  });
});
