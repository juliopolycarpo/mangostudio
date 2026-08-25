/**
 * Every kind of activity event has to turn into a sentence in both locales —
 * the switch has no `default`, so a kind missing a case is a typecheck
 * failure, not a test failure. What is worth asserting here is the branching
 * *inside* each case: which template a kind picks, and what it fills in.
 */

import { describe, expect, it } from 'bun:test';
import type { ActivityEvent } from '@mangostudio/shared/activity';
import { en, ptBR } from '@mangostudio/shared/i18n';
import { describeActivity } from '@/features/activity/lib/describe-activity';

const BASE = {
  id: 'evt-1',
  createdAt: Date.UTC(2026, 7, 24, 10, 0, 0),
  chatId: null,
  workdir: null,
  environmentId: null,
  targetId: null,
} as const;

describe('describeActivity', () => {
  it('names the chat for chat_created', () => {
    const event: ActivityEvent = {
      ...BASE,
      kind: 'chat_created',
      payload: { title: 'Refactor the git panel' },
    };
    expect(describeActivity(event, en, 'en').text).toBe('Started Refactor the git panel');
    expect(describeActivity(event, ptBR, 'pt-BR').text).toBe('Iniciou Refactor the git panel');
  });

  // Spelled out, not the sidebar's lowercase mono chip label: this is prose.
  it('names the harness that answered for turn_completed, in sentence register', () => {
    const mango: ActivityEvent = {
      ...BASE,
      kind: 'turn_completed',
      payload: { title: 'Fix the flaky test', runner: { kind: 'mangostudio', agentId: 'default' } },
    };
    const codex: ActivityEvent = {
      ...BASE,
      kind: 'turn_completed',
      payload: { title: 'Fix the flaky test', runner: { kind: 'external', targetId: 'codex' } },
    };
    expect(describeActivity(mango, en, 'en').text).toBe(
      'MangoStudio answered in Fix the flaky test'
    );
    expect(describeActivity(codex, en, 'en').text).toBe('Codex answered in Fix the flaky test');
  });

  it('names the branch for commit_created only when one is known', () => {
    const onBranch: ActivityEvent = {
      ...BASE,
      kind: 'commit_created',
      payload: { subject: 'Add activity feed', branch: 'feat/activity-feed' },
    };
    const noBranch: ActivityEvent = {
      ...BASE,
      kind: 'commit_created',
      payload: { subject: 'Add activity feed', branch: null },
    };
    expect(describeActivity(onBranch, en, 'en').text).toBe(
      'Committed "Add activity feed" on feat/activity-feed'
    );
    expect(describeActivity(noBranch, en, 'en').text).toBe('Committed "Add activity feed"');
  });

  it('names the branch and remote for branch_pushed', () => {
    const event: ActivityEvent = {
      ...BASE,
      kind: 'branch_pushed',
      payload: { branch: 'feat/activity-feed', remote: 'origin' },
    };
    expect(describeActivity(event, en, 'en').text).toBe('Pushed feat/activity-feed to origin');
  });

  it('lists the propagation targets by name and drops the sentence when there are none', () => {
    const withTargets: ActivityEvent = {
      ...BASE,
      kind: 'propagation_applied',
      payload: {
        resourceKind: 'skill',
        resourceName: 'frontend-design',
        targets: ['claude', 'codex'],
      },
    };
    const noTargets: ActivityEvent = {
      ...BASE,
      kind: 'propagation_applied',
      payload: { resourceKind: 'skill', resourceName: 'frontend-design', targets: [] },
    };
    // The slug, not the kind label: the kind rides on the icon instead.
    expect(describeActivity(withTargets, en, 'en').text).toBe(
      'Propagated frontend-design to Claude Code and Codex'
    );
    expect(describeActivity(noTargets, en, 'en').text).toBe('Propagated frontend-design');
  });

  it('picks the row icon from the resource kind', () => {
    const kinds = ['skill', 'subagent', 'instruction', 'setting', 'hook'] as const;
    const icons = kinds.map(
      (resourceKind) =>
        describeActivity(
          {
            ...BASE,
            kind: 'propagation_applied',
            payload: { resourceKind, resourceName: 'x', targets: [] },
          },
          en,
          'en'
        ).icon
    );
    expect(new Set(icons).size).toBe(kinds.length);
  });

  it('reports both endpoints of a quota move and warns once it is high', () => {
    const low: ActivityEvent = {
      ...BASE,
      kind: 'quota_refreshed',
      payload: { target: 'codex', previousUsedPercent: 62, usedPercent: 71 },
    };
    const high: ActivityEvent = {
      ...BASE,
      kind: 'quota_refreshed',
      payload: { target: 'codex', previousUsedPercent: 85, usedPercent: 92 },
    };
    expect(describeActivity(low, en, 'en').text).toBe('Codex quota at 71%, was 62%');
    expect(describeActivity(low, en, 'en').tone).toBe('neutral');
    expect(describeActivity(high, en, 'en').tone).toBe('warning');
  });

  it('describes each settled environment health transition', () => {
    const connected: ActivityEvent = {
      ...BASE,
      kind: 'environment_health_changed',
      payload: { environmentName: 'WSL', previousState: 'connecting', state: 'connected' },
    };
    const disconnected: ActivityEvent = {
      ...BASE,
      kind: 'environment_health_changed',
      payload: { environmentName: 'WSL', previousState: 'connected', state: 'disconnected' },
    };
    const errored: ActivityEvent = {
      ...BASE,
      kind: 'environment_health_changed',
      payload: { environmentName: 'WSL', previousState: 'connecting', state: 'error' },
    };
    expect(describeActivity(connected, en, 'en').text).toBe('WSL reconnected');
    expect(describeActivity(connected, en, 'en').tone).toBe('success');
    expect(describeActivity(disconnected, en, 'en').text).toBe('WSL disconnected');
    expect(describeActivity(errored, en, 'en').text).toBe('WSL could not connect');
    expect(describeActivity(errored, en, 'en').tone).toBe('error');
  });
});
