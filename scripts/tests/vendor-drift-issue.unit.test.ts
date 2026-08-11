/**
 * The scheduled drift job's issue-opening path, exercised against a fake
 * GitHub client.
 *
 * Worth a test rather than a manual run: this code path fires once a week at
 * 08:00 UTC on somebody else's release schedule, so the first time anyone sees
 * it is the first time a vendor moves. The two failures that would matter then
 * are a body that renders nothing useful and labels the classification gate
 * rejects, and both are checkable here.
 */

import { describe, expect, it } from 'bun:test';
import {
  DRIFT_LABELS,
  DRIFT_MARKER,
  DRIFT_TITLE,
  driftedOutcomes,
  hasDrift,
  publishDriftIssue,
  renderIssueBody,
} from '../vendor/drift-issue.mjs';

interface IssueCall {
  readonly kind: 'create' | 'update' | 'comment';
  readonly payload: Record<string, unknown>;
}

/** Just enough Octokit to record what the module would have done. */
function fakeGitHub(open: ReadonlyArray<{ number: number; body: string }> = []) {
  const calls: IssueCall[] = [];
  const github = {
    rest: {
      issues: {
        listForRepo: () => Promise.resolve({ data: [...open] }),
        create: (payload: Record<string, unknown>) => {
          calls.push({ kind: 'create', payload });
          return Promise.resolve({ data: { number: 42 } });
        },
        update: (payload: Record<string, unknown>) => {
          calls.push({ kind: 'update', payload });
          return Promise.resolve({ data: {} });
        },
        createComment: (payload: Record<string, unknown>) => {
          calls.push({ kind: 'comment', payload });
          return Promise.resolve({ data: {} });
        },
      },
    },
  };
  const context = { repo: { owner: 'mangostudio', repo: 'mangostudio' } };
  const core = { info: () => undefined };
  return { github, context, core, calls };
}

const BROKEN_REPORT = {
  against: 'latest',
  outcomes: [
    {
      id: 'cursor-acp',
      status: 'broken',
      observedVersion: '2026.09.01-abc1234',
      changes: ['  removed initialize.json: agentCapabilities.loadSession: <boolean>'],
    },
    {
      id: 'codex-protocol',
      status: 'matched',
      observedVersion: '@openai/codex@latest',
      changes: [],
    },
    {
      id: 'claude-cli',
      status: 'skipped',
      observedVersion: null,
      changes: [],
    },
  ],
};

describe('deciding whether a run is worth an issue', () => {
  it('counts removed and added fields, and never a skip', () => {
    expect(driftedOutcomes(BROKEN_REPORT).map((outcome) => outcome.id)).toEqual(['cursor-acp']);
    expect(hasDrift(BROKEN_REPORT)).toBe(true);
  });

  /**
   * A runner without vendor credentials is the ordinary case. Filing an issue
   * about it weekly would bury the one this job exists to surface.
   */
  it('does not open an issue for a run that only skipped things', () => {
    expect(hasDrift({ outcomes: [{ id: 'cursor-acp', status: 'skipped', changes: [] }] })).toBe(
      false
    );
    expect(hasDrift({ outcomes: [] })).toBe(false);
  });

  it('treats an additive-only run as worth reporting but not urgent', () => {
    const additive = {
      outcomes: [{ id: 'claude-cli', status: 'additive', changes: ['  added x'] }],
    };
    expect(hasDrift(additive)).toBe(true);
  });
});

describe('the issue body', () => {
  const body = renderIssueBody(BROKEN_REPORT, 'https://example.invalid/run/1');

  it('carries the marker the next run finds it by', () => {
    expect(body.startsWith(DRIFT_MARKER)).toBe(true);
  });

  it('names the drifted set, its version and the field that moved', () => {
    expect(body).toContain('cursor-acp');
    expect(body).toContain('2026.09.01-abc1234');
    expect(body).toContain('agentCapabilities.loadSession');
  });

  it('names the command that fixes it', () => {
    expect(body).toContain('bun run vendor-contracts:regen');
  });

  /** Otherwise a green issue reads as "everything was checked", which it was not. */
  it('says what the run could not verify', () => {
    expect(body).toContain('Not verified by this run');
    expect(body).toContain('claude-cli');
  });

  it('links the run that produced it', () => {
    expect(body).toContain('https://example.invalid/run/1');
  });
});

describe('publishing', () => {
  it('opens one issue with the labels the classification gate requires', async () => {
    const { calls, ...clients } = fakeGitHub();
    const result = await publishDriftIssue(clients, BROKEN_REPORT, 'https://example.invalid/run/1');

    expect(result).toMatchObject({ action: 'opened', number: 42 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.kind).toBe('create');
    expect(calls[0]?.payload.title).toBe(DRIFT_TITLE);
    // The gate reads `.github/labeler.yml`, where both carry the space.
    expect(calls[0]?.payload.labels).toEqual(DRIFT_LABELS);
    expect(DRIFT_LABELS.every((label) => label.includes(': '))).toBe(true);
  });

  /**
   * A vendor stays moved until somebody re-records, so a weekly job that opened
   * a fresh issue each Wednesday would produce a backlog of identical reports.
   */
  it('updates its own issue instead of opening a second one', async () => {
    const { calls, ...clients } = fakeGitHub([{ number: 7, body: `${DRIFT_MARKER}\nolder` }]);
    const result = await publishDriftIssue(clients, BROKEN_REPORT, undefined);

    expect(result).toMatchObject({ action: 'updated', number: 7 });
    expect(calls.map((call) => call.kind)).toEqual(['update']);
    expect(calls[0]?.payload.issue_number).toBe(7);
  });

  it('ignores an unrelated open issue that happens to share the label', async () => {
    const { calls, ...clients } = fakeGitHub([{ number: 9, body: 'bump some dependency' }]);
    const result = await publishDriftIssue(clients, BROKEN_REPORT, undefined);

    expect(result).toMatchObject({ action: 'opened' });
    expect(calls.map((call) => call.kind)).toEqual(['create']);
  });

  /** The issue's existence is the signal, so it has to stop existing. */
  it('closes the issue once the vendors match again', async () => {
    const { calls, ...clients } = fakeGitHub([{ number: 7, body: `${DRIFT_MARKER}\nolder` }]);
    const result = await publishDriftIssue(clients, { outcomes: [] }, undefined);

    expect(result).toMatchObject({ action: 'closed', number: 7 });
    expect(calls.map((call) => call.kind)).toEqual(['comment', 'update']);
    expect(calls[1]?.payload.state).toBe('closed');
  });

  it('does nothing at all when there is no drift and no open issue', async () => {
    const { calls, ...clients } = fakeGitHub();
    const result = await publishDriftIssue(clients, { outcomes: [] }, undefined);

    expect(result).toMatchObject({ action: 'none' });
    expect(calls).toEqual([]);
  });
});
