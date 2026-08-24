import { describe, expect, it } from 'bun:test';
import type { GitSummary } from '@mangostudio/shared/git';
import {
  type GitSummaryChat,
  getBatchGitSummaries,
} from '../../../../src/modules/git/application/git-batch-status-service';

function summaryFor(workdir: string): GitSummary {
  return {
    branch: 'main',
    ahead: 0,
    behind: 0,
    changedFileCount: 0,
    workdir,
  };
}

function chat(id: string, workdir: string | null, environmentId = 'local'): GitSummaryChat {
  return { id, workdir, environmentId };
}

const gitAlwaysAvailable = () => Promise.resolve(true);

describe('getBatchGitSummaries', () => {
  it('computes once per unique workdir and fans the summary out to every chat', async () => {
    const calls: string[] = [];
    const states = await getBatchGitSummaries({
      chatIds: ['a', 'b', 'c', 'd'],
      chats: [
        chat('a', '/repo/one'),
        chat('b', '/repo/one'),
        chat('c', '/repo/one'),
        chat('d', '/repo/two'),
      ],
      userId: 'user-1',
      checkGitAvailable: gitAlwaysAvailable,
      computeSummary: (workdir) => {
        calls.push(workdir);
        return Promise.resolve(summaryFor(workdir));
      },
    });

    expect(calls.sort()).toEqual(['/repo/one', '/repo/two']);
    expect(states.a).toEqual(summaryFor('/repo/one'));
    expect(states.b).toBe(states.a as GitSummary);
    expect(states.c).toBe(states.a as GitSummary);
    expect(states.d).toEqual(summaryFor('/repo/two'));
  });

  it('treats the same path on two environments as two repositories', async () => {
    const calls: Array<{ workdir: string; environmentId: string }> = [];
    await getBatchGitSummaries({
      chatIds: ['a', 'b'],
      chats: [chat('a', '/repo', 'local'), chat('b', '/repo', 'remote-1')],
      userId: 'user-1',
      checkGitAvailable: gitAlwaysAvailable,
      computeSummary: (workdir, selection) => {
        calls.push({ workdir, environmentId: selection.environmentId });
        return Promise.resolve(summaryFor(workdir));
      },
    });

    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((call) => call.environmentId))).toEqual(
      new Set(['local', 'remote-1'])
    );
  });

  it('leaves unknown ids and chats without a workdir unanswered, without running git', async () => {
    let computed = 0;
    const states = await getBatchGitSummaries({
      chatIds: ['missing', 'no-workdir'],
      chats: [chat('no-workdir', null)],
      userId: 'user-1',
      checkGitAvailable: gitAlwaysAvailable,
      computeSummary: () => {
        computed += 1;
        return Promise.resolve(summaryFor('/never'));
      },
    });

    expect(states).toEqual({});
    expect(computed).toBe(0);
  });

  it('ignores chats that were not asked about', async () => {
    const states = await getBatchGitSummaries({
      chatIds: ['a'],
      chats: [chat('a', '/repo'), chat('stray', '/repo')],
      userId: 'user-1',
      checkGitAvailable: gitAlwaysAvailable,
      computeSummary: (workdir) => Promise.resolve(summaryFor(workdir)),
    });

    expect(Object.keys(states)).toEqual(['a']);
  });

  it('probes git availability once per environment and skips unavailable ones', async () => {
    const probes: string[] = [];
    const states = await getBatchGitSummaries({
      chatIds: ['a', 'b', 'c'],
      chats: [
        chat('a', '/repo/one', 'down'),
        chat('b', '/repo/two', 'down'),
        chat('c', '/repo/three', 'local'),
      ],
      userId: 'user-1',
      checkGitAvailable: (selection) => {
        probes.push(selection.environmentId);
        return Promise.resolve(selection.environmentId !== 'down');
      },
      computeSummary: (workdir) => Promise.resolve(summaryFor(workdir)),
    });

    expect(probes.sort()).toEqual(['down', 'local']);
    expect(states.a).toBeUndefined();
    expect(states.b).toBeUndefined();
    expect(states.c).toEqual(summaryFor('/repo/three'));
  });

  it('keeps the batch alive when one workdir fails', async () => {
    const states = await getBatchGitSummaries({
      chatIds: ['broken', 'healthy'],
      chats: [chat('broken', '/repo/broken'), chat('healthy', '/repo/healthy')],
      userId: 'user-1',
      checkGitAvailable: gitAlwaysAvailable,
      computeSummary: (workdir) =>
        workdir === '/repo/broken'
          ? Promise.reject(new Error('dubious ownership'))
          : Promise.resolve(summaryFor(workdir)),
    });

    expect(states.broken).toBeUndefined();
    expect(states.healthy).toEqual(summaryFor('/repo/healthy'));
  });

  it('bounds workdir concurrency', async () => {
    let inFlight = 0;
    let peak = 0;
    const chats = Array.from({ length: 12 }, (_, index) => chat(`c${index}`, `/repo/${index}`));
    await getBatchGitSummaries({
      chatIds: chats.map((entry) => entry.id),
      chats,
      userId: 'user-1',
      checkGitAvailable: gitAlwaysAvailable,
      computeSummary: async (workdir) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        return summaryFor(workdir);
      },
    });

    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });

  it('stops pulling new workdirs once the client hangs up', async () => {
    const controller = new AbortController();
    let computed = 0;
    const chats = Array.from({ length: 12 }, (_, index) => chat(`c${index}`, `/repo/${index}`));
    await getBatchGitSummaries({
      chatIds: chats.map((entry) => entry.id),
      chats,
      userId: 'user-1',
      signal: controller.signal,
      checkGitAvailable: gitAlwaysAvailable,
      computeSummary: (workdir) => {
        computed += 1;
        controller.abort();
        return Promise.resolve(summaryFor(workdir));
      },
    });

    // The reads already in flight finish; nothing after them is spawned for a
    // response nobody will read.
    expect(computed).toBeLessThanOrEqual(4);
    expect(computed).toBeGreaterThan(0);
  });
});
