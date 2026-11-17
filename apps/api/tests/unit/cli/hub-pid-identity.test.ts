/**
 * The state file outlives a crashed hub, and the OS can give the hub's pid to an
 * unrelated process. These cases pin that `stop`, `killserver`, `restart` and
 * `service install` never signal such a process, still stop the real hub, and
 * refuse (rather than guess) when the platform cannot say when a pid started.
 */
import { describe, expect, it } from 'bun:test';

import { runKillServer } from '../../../src/cli/commands/killserver';
import { runRestart } from '../../../src/cli/commands/restart';
import { runService } from '../../../src/cli/commands/service';
import { runStatus } from '../../../src/cli/commands/status';
import { runStop } from '../../../src/cli/commands/stop';
import { CliError } from '../../../src/cli/errors';
import type { ServerState } from '../../../src/lib/server-state';
import { FakeProcessController } from '../../support/mocks/fake-process-controller';
import { FakeServiceManager } from '../../support/mocks/fake-service-manager';

const HUB_STARTED_AT = 1_700_000_000_000;
const HUB_PID = 4242;
const STATE: ServerState = {
  pid: HUB_PID,
  port: 3001,
  host: '127.0.0.1',
  startedAt: HUB_STARTED_AT,
  logFile: '/home/test/.mango/logs/server-1.log',
  version: 't',
};

/** The hub as it really ran: it started a few seconds before it wrote the state file. */
const HUB_PROCESS_START = HUB_STARTED_AT - 4_000;
/** An editor that took the pid after the hub died. */
const RECYCLED_PROCESS_START = HUB_STARTED_AT + 3_600_000;

/** A controller where SIGTERM and SIGKILL end the pid, so a stop completes. */
function stoppable(controller: FakeProcessController): FakeProcessController {
  controller.terminate = (pid) => {
    controller.terminated.push(pid);
    controller.die(pid);
  };
  controller.kill = (pid) => {
    controller.killed.push(pid);
    controller.die(pid);
  };
  return controller;
}

function clock() {
  let now = 0;
  return {
    now: () => now,
    sleep: (ms: number): Promise<void> => {
      now += ms;
      return Promise.resolve();
    },
  };
}

/** A state-file fake that records removal. */
function stateFile(state: ServerState) {
  const file = { removed: 0 };
  return {
    file,
    readState: () => Promise.resolve(file.removed === 0 ? state : null),
    removeState: () => {
      file.removed += 1;
      return Promise.resolve();
    },
  };
}

type Command = 'stop' | 'killserver' | 'restart' | 'service install';

/** Runs the command against `controller`; resolves with the lines it logged. */
async function runCommand(command: Command, controller: FakeProcessController): Promise<string[]> {
  const lines: string[] = [];
  const common = { controller, log: (msg: string) => lines.push(msg), ...clock() };
  const { readState, removeState } = stateFile(STATE);
  const state = { readState, removeState };
  switch (command) {
    case 'stop':
      await runStop({ ...common, ...state });
      break;
    case 'killserver':
      await runKillServer({ ...common, ...state });
      break;
    case 'restart': {
      const manager = new FakeServiceManager();
      await runRestart({
        ...common,
        ...state,
        manager,
        launcherPath: () => undefined,
        confirmsHealthy: () => Promise.resolve(true),
        spawnDetached: () => Promise.resolve({ pid: 43, port: 3001, logFile: '/x.log' }),
      });
      break;
    }
    case 'service install':
      await runService(
        { action: 'install', json: false },
        {
          ...common,
          ...state,
          manager: new FakeServiceManager(),
          ensureAuthSecret: () => Promise.resolve(),
          secretPersisted: () => true,
          envFilePath: () => '/home/test/.mango/.env',
          configuredTarget: () => ({ host: '127.0.0.1', port: 3001 }),
          assertServeConfig: () => undefined,
          ensureDirs: () => Promise.resolve(),
          executable: () => ({
            argv: ['/home/test/.mango/dist/current/mangostudio'],
            pointer: 'current',
          }),
          logFile: () => '/home/test/.mango/logs/service.log',
          platform: 'linux',
          env: { PATH: '/usr/bin' },
        }
      );
      break;
  }
  return lines;
}

const COMMANDS: readonly Command[] = ['stop', 'killserver', 'restart', 'service install'];
const signalsOf = (controller: FakeProcessController) => [
  ...controller.terminated,
  ...controller.killed,
];

describe('a state file whose pid another process now owns', () => {
  it.each(COMMANDS)('%s never signals the unrelated process', async (command) => {
    const controller = stoppable(new FakeProcessController());
    controller.aliveSince(HUB_PID, RECYCLED_PROCESS_START);

    // `restart` and `service install` end by starting something else, or by
    // refusing: either way the recycled pid must have been left alone.
    await runCommand(command, controller).catch((error: unknown) => {
      expect(error).toBeInstanceOf(CliError);
    });

    expect(
      signalsOf(controller),
      `expected no signal to pid ${HUB_PID} (reused by a process that started after the hub) | received: ${signalsOf(controller)}`
    ).toEqual([]);
    expect(controller.isAlive(HUB_PID)).toBe(true);
  });

  it.each(['stop', 'killserver'] as const)(
    '%s treats the file as stale and removes it',
    async (command) => {
      const controller = stoppable(new FakeProcessController());
      controller.aliveSince(HUB_PID, RECYCLED_PROCESS_START);
      const removal = stateFile(STATE);
      const deps = {
        controller,
        log: () => undefined,
        ...clock(),
        readState: removal.readState,
        removeState: removal.removeState,
      };

      await (command === 'stop' ? runStop(deps) : runKillServer(deps));

      expect(removal.file.removed, 'expected the stale state file removed once').toBe(1);
    }
  );

  it('status does not report it as a running hub', async () => {
    const controller = new FakeProcessController();
    controller.aliveSince(HUB_PID, RECYCLED_PROCESS_START);
    const lines: string[] = [];
    const removal = stateFile(STATE);

    await runStatus(
      { json: true },
      {
        controller,
        readState: removal.readState,
        removeState: removal.removeState,
        log: (msg) => lines.push(msg),
        now: () => HUB_STARTED_AT,
      }
    );

    expect(removal.file.removed).toBe(1);
    expect(lines.join('\n')).toContain('"running": false');
  });
});

describe('the hub itself', () => {
  it('stop and killserver still signal a hub that answers nothing', async () => {
    // A hung hub never answers a health probe. Identity comes from the start time, so
    // `killserver` can still stop it.
    for (const command of ['stop', 'killserver'] as const) {
      const controller = stoppable(new FakeProcessController());
      controller.aliveSince(HUB_PID, HUB_PROCESS_START);

      await runCommand(command, controller);

      expect(signalsOf(controller), `${command}: expected one signal to the hub`).toEqual([
        HUB_PID,
      ]);
    }
  });

  it('restart and service install still stop the hub they replace', async () => {
    for (const command of ['restart', 'service install'] as const) {
      const controller = stoppable(new FakeProcessController());
      controller.aliveSince(HUB_PID, HUB_PROCESS_START);

      await runCommand(command, controller).catch(() => undefined);

      expect(controller.terminated, `${command}: expected SIGTERM to the hub`).toEqual([HUB_PID]);
    }
  });
});

describe('a pid whose start time cannot be read', () => {
  it.each(['stop', 'killserver'] as const)('%s refuses instead of signalling', async (command) => {
    const controller = stoppable(new FakeProcessController());
    controller.hideStartTime(HUB_PID);

    const outcome = await runCommand(command, controller).then(
      () => 'resolved',
      (error: unknown) => (error as Error).message
    );

    expect(signalsOf(controller)).toEqual([]);
    expect(outcome).toContain(`Cannot confirm PID ${HUB_PID} is MangoStudio`);
    expect(outcome).toContain('delete');
  });

  it('restart and service install refuse with the same message', async () => {
    for (const command of ['restart', 'service install'] as const) {
      const controller = stoppable(new FakeProcessController());
      controller.hideStartTime(HUB_PID);

      const outcome = await runCommand(command, controller).then(
        () => 'resolved',
        (error: unknown) => (error as Error).message
      );

      expect(signalsOf(controller), `${command}: expected no signal`).toEqual([]);
      expect(outcome, `${command}: expected a refusal`).toContain(
        `Cannot confirm PID ${HUB_PID} is MangoStudio`
      );
    }
  });
});
