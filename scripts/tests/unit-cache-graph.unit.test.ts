import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ROOT_DIR } from '../lib/config';
import { createTurboTestCommand } from '../lib/test';
import { executableTaskIds, runTurbo, turboDryRun } from './support/turbo-run';
import { createTypecheckFixture, type TypecheckFixture } from './support/typecheck-fixture';

const PROTOCOL = '@mangostudio/protocol';
const SHARED = '@mangostudio/shared';
const API = '@mangostudio/api';
const FRONTEND = '@mangostudio/frontend';

const unitTaskId = (packageName: string) => `${packageName}#test:unit`;

describe('test:unit task graph', () => {
  test('a full run and a filtered run execute the same unit lanes as before', async () => {
    const all = executableTaskIds(await turboDryRun(ROOT_DIR, ['run', 'test:unit']));
    const frontend = executableTaskIds(
      await turboDryRun(ROOT_DIR, createTurboTestCommand('test:unit', ['frontend']).slice(1))
    );

    expect(
      all,
      `expected the unit lanes: ${[API, FRONTEND, SHARED].map(unitTaskId).join(', ')} | received: ${all.join(', ')}`
    ).toEqual([API, FRONTEND, SHARED].map(unitTaskId));
    expect(
      frontend,
      `expected a frontend run to execute only its own lane, not its upstream lanes | received: ${frontend.join(', ')}`
    ).toEqual([unitTaskId(FRONTEND)]);
  });

  test('each unit lane hashes its own workspace transit and waits for no executable task', async () => {
    const tasks = await turboDryRun(ROOT_DIR, ['run', 'test:unit']);

    const lanes = tasks.filter(
      (entry) => entry.task === 'test:unit' && entry.command !== '<NONEXISTENT>'
    );
    expect(
      lanes.length,
      'expected the unit lanes in the full run | received: none'
    ).toBeGreaterThan(0);
    for (const task of lanes) {
      const own = `${task.package}#transit`;
      expect(
        task.dependencies,
        `expected ${task.taskId} to depend on exactly [${own}], so an upstream edit changes its hash while the lanes still start together | received: [${task.dependencies.join(', ')}]`
      ).toEqual([own]);
    }
  });

  test('tasks without an upstream workspace keep their graph', async () => {
    const tasks = await turboDryRun(ROOT_DIR, [
      'run',
      'test:unit',
      'test:integration',
      'test:coverage',
    ]);
    const rootScripts = await turboDryRun(ROOT_DIR, ['run', '//#test:scripts']);

    const protocolUnit = tasks.find((task) => task.taskId === unitTaskId(PROTOCOL));
    expect(
      protocolUnit?.command ?? '<NONEXISTENT>',
      `expected ${PROTOCOL} to have no unit lane, so nothing upstream of it is hashed in | received command: ${protocolUnit?.command}`
    ).toBe('<NONEXISTENT>');
    for (const task of tasks.filter((entry) =>
      ['test:integration', 'test:coverage'].includes(entry.task)
    )) {
      expect(
        task.dependencies,
        `expected the uncached ${task.taskId} to keep no dependency | received: [${task.dependencies.join(', ')}]`
      ).toEqual([]);
    }
    const scripts = rootScripts.find((task) => task.taskId === '//#test:scripts');
    expect(
      scripts?.dependencies,
      `expected //#test:scripts to keep no dependency | received: [${scripts?.dependencies.join(', ')}]`
    ).toEqual([]);
  });
});

describe('test:unit cache across workspaces', () => {
  let fixture: TypecheckFixture;
  const unit = (extra: string[] = []) =>
    runTurbo(fixture.root, ['run', 'test:unit', ...fixture.turboArgs, ...extra]);

  const unitHashes = async (): Promise<Map<string, string>> => {
    const tasks = await turboDryRun(fixture.root, ['run', 'test:unit', ...fixture.turboArgs]);
    return new Map(
      tasks.filter((task) => task.task === 'test:unit').map((task) => [task.taskId, task.hash])
    );
  };

  // A unit test imports its own workspace and every workspace it depends on.
  // The protocol has no unit lane, but its edits reach the lanes above it.
  const RERUN_AFTER_EDIT: Record<string, string[]> = {
    [PROTOCOL]: [SHARED, API, FRONTEND],
    [SHARED]: [SHARED, API, FRONTEND],
    [API]: [API, FRONTEND],
    [FRONTEND]: [FRONTEND],
  };
  const LANES = [SHARED, API, FRONTEND];

  beforeAll(() => {
    fixture = createTypecheckFixture();
  });
  afterAll(() => fixture.dispose());

  for (const [edited, rerun] of Object.entries(RERUN_AFTER_EDIT)) {
    test(`editing ${edited} changes exactly the unit hashes of the lanes that import it`, async () => {
      const before = await unitHashes();
      fixture.writeSource(edited, '// an unrelated edit\n');
      const after = await unitHashes();
      fixture.writeSource(edited);

      for (const lane of LANES) {
        const id = unitTaskId(lane);
        const changed = after.get(id) !== before.get(id);
        if (rerun.includes(lane)) {
          expect(
            changed,
            `expected test:unit hash to change | received: unchanged | ${id} after an edit in ${edited}`
          ).toBe(true);
          continue;
        }
        expect(
          changed,
          `expected test:unit hash to stay | received: changed | ${id} after an edit in ${edited}, which it does not import`
        ).toBe(false);
      }
    });
  }

  test('an upstream edit misses downstream, a downstream edit leaves upstream hit, and a replay never hides a failure', async () => {
    const hits = (output: string) =>
      new Set(
        [...output.matchAll(/^(\S+?):test:unit: cache hit/gm)].map((match) => match[1] as string)
      );
    const expectHits = (output: string, expected: string[], when: string) => {
      const received = [...hits(output)].sort();
      expect(
        received,
        `expected cache hits for [${[...expected].sort().join(', ')}] ${when} | received: [${received.join(', ')}]`
      ).toEqual([...expected].sort());
    };

    const cold = await unit();
    expect(
      cold.exitCode,
      `expected a cold unit run to exit: 0 | received: ${cold.exitCode} | output: ${cold.stdout}${cold.stderr}`
    ).toBe(0);
    expectHits((await unit()).stdout, LANES, 'on a rerun with nothing changed');

    fixture.writeSource(API, '// an edit upstream of the frontend\n');
    expectHits((await unit()).stdout, [SHARED], `after an edit in ${API}`);

    fixture.writeSource(FRONTEND, '// an edit that nothing imports\n');
    expectHits((await unit()).stdout, [SHARED, API], `after an edit in ${FRONTEND}`);

    // The API now breaks. The frontend lane imports it, so replaying the
    // frontend's earlier pass would hide the failure.
    fixture.breakSource(API);
    const broken = await unit(['--continue=always']);
    expect(
      broken.exitCode,
      `expected a type error in ${API} to fail the unit run | received exit: ${broken.exitCode}`
    ).not.toBe(0);
    expectHits(broken.stdout, [SHARED], `after a failure in ${API}`);
    expect(
      broken.stdout,
      `expected ${unitTaskId(FRONTEND)} to rerun and fail on the ${API} error it imports | received no failure from the frontend lane`
    ).toMatch(/^@mangostudio\/frontend:test:unit: .*error TS2322/m);
  });
});
