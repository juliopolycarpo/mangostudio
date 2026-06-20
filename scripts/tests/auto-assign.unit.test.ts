import { describe, expect, test } from 'bun:test';

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
});
