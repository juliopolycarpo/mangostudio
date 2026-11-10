import { describe, expect, test } from 'bun:test';
import { runInNewContext } from 'node:vm';

import { readText } from './support/read-text';

describe('auto-assignment workflow', () => {
  test('runs safely on pull request metadata without checking out PR code', () => {
    const workflow = readText('.github/workflows/auto-assign.yml');

    expect(workflow).toContain('pull_request_target:');
    expect(workflow).toContain('ready_for_review');
    expect(workflow).toContain('if: $' + '{{ !github.event.pull_request.draft }}');
    expect(workflow).toContain('contents: read');
    expect(workflow).toContain('issues: write');
    expect(workflow).toContain('pull-requests: write');
    expect(workflow).not.toContain('actions/checkout');
  });

  test('derives reviewers from changed-file history with no static owner config', () => {
    const workflow = readText('.github/workflows/auto-assign.yml');

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
    const workflow = Bun.YAML.parse(readText('.github/workflows/auto-assign.yml')) as {
      jobs: { assign: { steps: { with: { script: string } }[] } };
    };
    const script = workflow.jobs.assign.steps[0]?.with.script;
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
    const workflow = readText('.github/workflows/auto-assign.yml');

    expect(workflow).toContain('addAssignees');
    expect(workflow).toContain('assignees: [authorLogin]');
    expect(workflow).toContain('requestReviewers');
    expect(workflow).toContain('login === authorLogin');
    expect(workflow).toContain('isBot');
  });

  test('does not re-ping reviewers who already reviewed or are pending', () => {
    const workflow = readText('.github/workflows/auto-assign.yml');

    expect(workflow).toContain('listReviews');
    expect(workflow).toContain('requested_reviewers');
    expect(workflow).toContain('handledReviewers');
  });

  test('classifies the workflow as CI work', () => {
    const labeler = readText('.github/labeler.yml');

    expect(labeler).toContain('".github/workflows/**"');
  });

  test('documents that classification belongs in labeler, not here', () => {
    const workflow = readText('.github/workflows/auto-assign.yml');

    expect(workflow).toContain('labeler.yml');
    expect(workflow).not.toContain('actions/labeler');
  });
});
