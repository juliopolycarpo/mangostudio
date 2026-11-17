/**
 * The state file outlives a crashed hub, and the OS can give the hub's pid to an
 * unrelated process. These cases pin that `stop`, `killserver`, `restart` and
 * `service install` never signal such a process (the hub's start token differs),
 * still stop the real hub through a wall-clock step, refuse rather than guess when
 * identity cannot be read, and that `killserver --force` is the way out.
 */
import { describe, expect, it } from 'bun:test';

import { runKillServer } from '../../../src/cli/commands/killserver';
import { runRestart } from '../../../src/cli/commands/restart';
import { runService } from '../../../src/cli/commands/service';
import { runStatus } from '../../../src/cli/commands/status';
import { runStop } from '../../../src/cli/commands/stop';
import { CliError } from '../../../src/cli/errors';
import { manualStopCommand } from '../../../src/cli/process-control';
import { classifyStateProcess, type ServerState } from '../../../src/lib/server-state';
import { FakeProcessController } from '../../support/mocks/fake-process-controller';
import { FakeServiceManager } from '../../support/mocks/fake-service-manager';

const HUB_STARTED_AT = 1_700_000_000_000;
const HUB_PID = 4242;
const HUB_TOKEN = 'boot-1:777';
const HOUR = 3_600_000;
const STATE: ServerState = {
  pid: HUB_PID,
  port: 3001,
  host: '127.0.0.1',
  startedAt: HUB_STARTED_AT,
  logFile: '/home/test/.mango/logs/server-1.log',
  version: 't',
  startToken: HUB_TOKEN,
};
/** What an older hub, or a Windows hub whose token query has not returned, wrote. */
const STATE_WITHOUT_TOKEN: ServerState = { ...STATE, startToken: undefined };

/** The hub as it really ran: it started a few seconds before it wrote the state file. */
const HUB_PROCESS_START = HUB_STARTED_AT - 4_000;
/** The wall clock stepped forward an hour after the hub started (NTP, a resumed VM). */
const STEPPED_CLOCK_START = HUB_STARTED_AT + HOUR;

/** A controller whose pid is the real hub: same token, started when the hub did. */
function hubController(): FakeProcessController {
  const controller = new FakeProcessController();
  controller.aliveSince(HUB_PID, HUB_PROCESS_START);
  controller.startTokenOf(HUB_PID, HUB_TOKEN);
  return controller;
}

/** A controller whose pid now belongs to an editor that took it after the hub died. */
function recycledController(): FakeProcessController {
  const controller = new FakeProcessController();
  controller.aliveSince(HUB_PID, HUB_STARTED_AT + HOUR);
  controller.startTokenOf(HUB_PID, 'boot-1:99999');
  return controller;
}

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

/** Named fake platforms, so the wording of each is asserted on every host. */
const POSIX_PLATFORM: NodeJS.Platform = 'linux';
const WINDOWS_PLATFORM: NodeJS.Platform = 'win32';
const MANUAL_STOP_BY_PLATFORM = [
  [POSIX_PLATFORM, `kill ${HUB_PID}`],
  [WINDOWS_PLATFORM, `taskkill /PID ${HUB_PID} /F`],
] as const;

type Command = 'stop' | 'killserver' | 'restart' | 'service install';

/** Runs the command against `controller`; resolves with the lines it logged. */
async function runCommand(
  command: Command,
  controller: FakeProcessController,
  fileState: ServerState = STATE,
  platform: NodeJS.Platform = POSIX_PLATFORM
): Promise<string[]> {
  const lines: string[] = [];
  const common = { controller, platform, log: (msg: string) => lines.push(msg), ...clock() };
  const { readState, removeState } = stateFile(fileState);
  const state = { readState, removeState };
  switch (command) {
    case 'stop':
      await runStop({ ...common, ...state });
      break;
    case 'killserver':
      await runKillServer(undefined, { ...common, ...state });
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
const outcomeOf = (run: Promise<unknown>) =>
  run.then(
    () => 'resolved',
    (error: unknown) => (error as Error).message
  );

describe('a pid another process now owns (token mismatch)', () => {
  it.each(COMMANDS)('%s never signals the unrelated process', async (command) => {
    const controller = stoppable(recycledController());

    // `restart` and `service install` end by starting something else, or by refusing:
    // either way the recycled pid must have been left alone.
    await runCommand(command, controller).catch((error: unknown) => {
      expect(error).toBeInstanceOf(CliError);
    });

    expect(
      signalsOf(controller),
      `expected no signal to pid ${HUB_PID} (token boot-1:99999 differs from the hub's ${HUB_TOKEN}) | received: ${signalsOf(controller)}`
    ).toEqual([]);
    expect(controller.isAlive(HUB_PID)).toBe(true);
  });

  it.each(['stop', 'killserver'] as const)(
    '%s treats the file as stale and removes it',
    async (command) => {
      const controller = stoppable(recycledController());
      const removal = stateFile(STATE);
      const deps = {
        controller,
        log: () => undefined,
        ...clock(),
        readState: removal.readState,
        removeState: removal.removeState,
      };

      await (command === 'stop' ? runStop(deps) : runKillServer(undefined, deps));

      expect(removal.file.removed, 'expected the stale state file removed once').toBe(1);
    }
  );
});

describe('a wall clock that stepped forward an hour', () => {
  it.each(['stop', 'killserver'] as const)(
    '%s still signals the hub when the file carries its token',
    async (command) => {
      const controller = stoppable(new FakeProcessController());
      controller.aliveSince(HUB_PID, STEPPED_CLOCK_START);
      controller.startTokenOf(HUB_PID, HUB_TOKEN);

      await runCommand(command, controller);

      expect(signalsOf(controller), `${command}: expected one signal to the hub`).toEqual([
        HUB_PID,
      ]);
    }
  );

  it.each(['stop', 'killserver'] as const)(
    '%s on a file without a token (older hub) is unconfirmed: nothing signalled, file kept',
    async (command) => {
      const controller = stoppable(new FakeProcessController());
      controller.aliveSince(HUB_PID, STEPPED_CLOCK_START);
      const removal = stateFile(STATE_WITHOUT_TOKEN);
      const deps = {
        controller,
        log: () => undefined,
        ...clock(),
        readState: removal.readState,
        removeState: removal.removeState,
      };

      const outcome = await outcomeOf(
        command === 'stop' ? runStop(deps) : runKillServer(undefined, deps)
      );

      expect(signalsOf(controller)).toEqual([]);
      expect(removal.file.removed, 'an unconfirmed pid must not delete the file').toBe(0);
      expect(outcome).toContain(`Cannot confirm PID ${HUB_PID} is MangoStudio`);
    }
  );
});

describe('the hub itself', () => {
  it('stop and killserver still signal a hub that answers nothing', async () => {
    // A hung hub never answers a health probe. Identity comes from the start token, so
    // `killserver` can still stop it.
    for (const command of ['stop', 'killserver'] as const) {
      const controller = stoppable(hubController());

      await runCommand(command, controller);

      expect(signalsOf(controller), `${command}: expected one signal to the hub`).toEqual([
        HUB_PID,
      ]);
    }
  });

  it('restart and service install still stop the hub they replace', async () => {
    for (const command of ['restart', 'service install'] as const) {
      const controller = stoppable(hubController());

      await runCommand(command, controller).catch(() => undefined);

      expect(controller.terminated, `${command}: expected SIGTERM to the hub`).toEqual([HUB_PID]);
    }
  });

  it('an older hub whose start time agrees with the file is still stopped', async () => {
    const controller = stoppable(new FakeProcessController());
    controller.aliveSince(HUB_PID, HUB_PROCESS_START);

    await runCommand('stop', controller, STATE_WITHOUT_TOKEN);

    expect(controller.terminated).toEqual([HUB_PID]);
  });
});

describe('a pid whose identity cannot be read', () => {
  it.each(
    (['stop', 'killserver'] as const).flatMap((command) =>
      MANUAL_STOP_BY_PLATFORM.map(([platform, manual]) => [command, platform, manual] as const)
    )
  )('%s on %s refuses, naming the pid and the way out', async (command, platform, manual) => {
    const controller = stoppable(new FakeProcessController());
    controller.hideStartTime(HUB_PID);

    const outcome = await outcomeOf(runCommand(command, controller, STATE, platform));

    expect(signalsOf(controller)).toEqual([]);
    expect(outcome).toContain(`Cannot confirm PID ${HUB_PID} is MangoStudio`);
    expect(outcome).toContain(`"${manual}"`);
    expect(outcome).toContain('killserver --force');
    expect(outcome, 'deleting the state file must not be the first suggestion').not.toContain(
      'delete'
    );
  });

  it.each(
    (['restart', 'service install'] as const).flatMap((command) =>
      MANUAL_STOP_BY_PLATFORM.map(([platform, manual]) => [command, platform, manual] as const)
    )
  )('%s on %s refuses with the same message', async (command, platform, manual) => {
    const controller = stoppable(new FakeProcessController());
    controller.hideStartTime(HUB_PID);

    const outcome = await outcomeOf(runCommand(command, controller, STATE, platform));

    expect(signalsOf(controller), `${command}: expected no signal`).toEqual([]);
    expect(outcome, `${command}: expected a refusal`).toContain(
      `Cannot confirm PID ${HUB_PID} is MangoStudio`
    );
    expect(outcome).toContain(`"${manual}"`);
  });

  it('names the Windows command on Windows', () => {
    expect(manualStopCommand(HUB_PID, 'win32')).toBe(`taskkill /PID ${HUB_PID} /F`);
    expect(manualStopCommand(HUB_PID, 'darwin')).toBe(`kill ${HUB_PID}`);
  });
});

describe('killserver --force', () => {
  it('signals a pid whose identity cannot be confirmed', async () => {
    const controller = stoppable(new FakeProcessController());
    controller.hideStartTime(HUB_PID);
    const removal = stateFile(STATE_WITHOUT_TOKEN);

    await runKillServer(
      { force: true },
      {
        controller,
        log: () => undefined,
        ...clock(),
        readState: removal.readState,
        removeState: removal.removeState,
      }
    );

    expect(controller.killed).toEqual([HUB_PID]);
    expect(controller.tokenReads + controller.timeReads, 'force must skip the identity query').toBe(
      0
    );
  });

  it.each([0, 1, -1, 1.5])('still refuses pid %p', async (pid) => {
    const controller = stoppable(new FakeProcessController([pid]));
    const removal = stateFile({ ...STATE, pid });

    const outcome = await outcomeOf(
      runKillServer(
        { force: true },
        {
          controller,
          log: () => undefined,
          ...clock(),
          readState: removal.readState,
          removeState: removal.removeState,
        }
      )
    );

    expect(signalsOf(controller)).toEqual([]);
    expect(outcome).toContain(`PID ${pid}`);
  });
});

describe('cost', () => {
  it('a state file naming this very process makes no identity query', async () => {
    const controller = stoppable(new FakeProcessController([process.pid]));
    const own = { ...STATE, pid: process.pid };

    expect(await classifyStateProcess(own, controller)).toBe('hub');
    expect(controller.tokenReads + controller.timeReads).toBe(0);
  });

  it('status, which only reads, never queries identity', async () => {
    const controller = recycledController();
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

    expect(controller.tokenReads + controller.timeReads).toBe(0);
    expect(removal.file.removed, 'a read-only command must not delete on an identity verdict').toBe(
      0
    );
  });
});
