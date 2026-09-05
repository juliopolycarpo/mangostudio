import { describe, expect, it } from 'bun:test';
import type {
  UpgradeReport,
  UpgradeRestart,
  UpgradeStreamEvent,
} from '@mangostudio/shared/updates';
import type { UpgradeArgs } from '../../../../src/cli/args';
import { runUpgrade, type UpgradeCliDeps } from '../../../../src/cli/commands/upgrade';
import type { ServerState } from '../../../../src/lib/server-state';
import type {
  RollbackOptions,
  UpgradeRunRequest,
  UpgradeService,
} from '../../../../src/modules/updates/application/upgrade-service';

const INSTALLED_VIA = {
  manager: 'self-managed' as const,
  channel: 'stable' as const,
  executable: '/x',
};

function baseArgs(overrides: Partial<UpgradeArgs> = {}): UpgradeArgs {
  return { check: false, yes: false, rollback: false, noRestart: false, json: false, ...overrides };
}

function availableReport(overrides: Partial<UpgradeReport> = {}): UpgradeReport {
  return {
    outcome: 'available',
    installedVia: INSTALLED_VIA,
    currentVersion: '0.1.1',
    target: {
      channel: 'stable',
      version: '0.1.2',
      assetName: 'mangostudio-0.1.2-linux-x64.tar.gz',
      url: 'https://example.test/x.tar.gz',
      kind: 'archive',
      verification: 'sha256-sums',
    },
    exitCode: 0,
    ...overrides,
  };
}

function upgradedReport(
  restart: UpgradeRestart,
  overrides: Partial<UpgradeReport> = {}
): UpgradeReport {
  return {
    outcome: 'upgraded',
    installedVia: INSTALLED_VIA,
    currentVersion: '0.1.1',
    target: availableReport().target,
    restart,
    exitCode: 0,
    ...overrides,
  };
}

/** Returns each queued report in order for successive run()/rollback() calls, recording every call it saw. */
class QueueUpgradeService implements UpgradeService {
  readonly runCalls: UpgradeRunRequest[] = [];
  readonly rollbackCalls: (RollbackOptions | undefined)[] = [];
  private index = 0;

  constructor(private readonly reports: readonly UpgradeReport[]) {}

  run(
    request: UpgradeRunRequest,
    emit: (event: UpgradeStreamEvent) => void
  ): Promise<UpgradeReport> {
    this.runCalls.push(request);
    emit({ type: 'stage', stage: 'resolve', done: false });
    emit({ type: 'output', stream: 'stdout', line: 'a script line', done: false });
    const report = this.reports[this.index] ?? this.reports.at(-1);
    this.index += 1;
    if (!report) throw new Error('QueueUpgradeService ran out of queued reports');
    return Promise.resolve(report);
  }

  rollback(
    _emit: (event: UpgradeStreamEvent) => void,
    options?: RollbackOptions
  ): Promise<UpgradeReport> {
    this.rollbackCalls.push(options);
    const report = this.reports[this.index] ?? this.reports.at(-1);
    this.index += 1;
    if (!report) throw new Error('QueueUpgradeService ran out of queued reports');
    return Promise.resolve(report);
  }
}

function baseDeps(
  service: UpgradeService,
  overrides: Partial<UpgradeCliDeps> = {}
): { deps: Partial<UpgradeCliDeps>; lines: string[] } {
  const lines: string[] = [];
  return {
    deps: {
      service,
      readState: () => Promise.resolve(null),
      controller: { isAlive: () => false, terminate: () => undefined, kill: () => undefined },
      isInteractive: () => false,
      confirm: () => Promise.resolve(false),
      log: (msg) => lines.push(msg),
      ...overrides,
    },
    lines,
  };
}

describe('runUpgrade --check', () => {
  it('previews without ever confirming, printing the available target', async () => {
    const service = new QueueUpgradeService([availableReport()]);
    const { deps, lines } = baseDeps(service);

    const exitCode = await runUpgrade(baseArgs({ check: true }), deps);

    expect(exitCode).toBe(0);
    expect(service.runCalls).toHaveLength(1);
    expect(service.runCalls[0]?.checkOnly).toBe(true);
    expect(lines).toEqual([
      'A newer build is available: 0.1.2 (stable). Re-run with --yes to install it.',
    ]);
  });

  it('prints the report only, and nothing else, in --json mode', async () => {
    const report = availableReport();
    const service = new QueueUpgradeService([report]);
    const { deps, lines } = baseDeps(service);

    await runUpgrade(baseArgs({ check: true, json: true }), deps);

    expect(lines).toEqual([JSON.stringify(report, null, 2)]);
  });

  it('still only previews when --yes is passed alongside it', async () => {
    // --check is a preview and nothing else; combining it with --yes must not
    // install, however emphatic the pair reads.
    const service = new QueueUpgradeService([availableReport()]);
    const { deps } = baseDeps(service);

    const exitCode = await runUpgrade(baseArgs({ check: true, yes: true }), deps);

    expect(exitCode).toBe(0);
    expect(service.runCalls).toHaveLength(1);
    expect(service.runCalls[0]?.checkOnly).toBe(true);
  });
});

describe('runUpgrade --yes', () => {
  it('skips the preview and runs once with restart true by default', async () => {
    const service = new QueueUpgradeService([upgradedReport('scheduled')]);
    const { deps, lines } = baseDeps(service);

    const exitCode = await runUpgrade(baseArgs({ yes: true }), deps);

    expect(exitCode).toBe(0);
    expect(service.runCalls).toHaveLength(1);
    expect(service.runCalls[0]).toMatchObject({ restart: true, checkOnly: false });
    expect(lines).toEqual(['→ resolve', 'a script line', 'Upgraded to 0.1.2. Restarting.']);
  });

  it('honors --no-restart', async () => {
    const service = new QueueUpgradeService([upgradedReport('skipped')]);
    const { deps } = baseDeps(service, {});

    await runUpgrade(baseArgs({ yes: true, noRestart: true }), deps);

    expect(service.runCalls[0]).toMatchObject({ restart: false });
  });
});

describe('runUpgrade unconfirmed', () => {
  it('reports the preview and exits 0 without running anything when non-interactive', async () => {
    const service = new QueueUpgradeService([availableReport()]);
    const { deps, lines } = baseDeps(service, { isInteractive: () => false });

    const exitCode = await runUpgrade(baseArgs(), deps);

    expect(exitCode).toBe(0);
    expect(service.runCalls).toHaveLength(1);
    expect(service.runCalls[0]?.checkOnly).toBe(true);
    expect(lines[0]).toContain('A newer build is available');
  });

  it('does not prompt at all when the preview is already terminal (already-current)', async () => {
    const confirmCalls: string[] = [];
    const service = new QueueUpgradeService([
      {
        outcome: 'already-current',
        installedVia: INSTALLED_VIA,
        currentVersion: '0.1.1',
        exitCode: 0,
      },
    ]);
    const { deps, lines } = baseDeps(service, {
      isInteractive: () => true,
      confirm: (q) => {
        confirmCalls.push(q);
        return Promise.resolve(true);
      },
    });

    await runUpgrade(baseArgs(), deps);

    expect(confirmCalls).toEqual([]);
    expect(lines).toEqual(['MangoStudio is already up to date (0.1.1).']);
  });

  it('runs for real when the interactive prompt is accepted, with no live hub to restart', async () => {
    const service = new QueueUpgradeService([availableReport(), upgradedReport('not-running')]);
    const confirmCalls: string[] = [];
    const { deps } = baseDeps(service, {
      isInteractive: () => true,
      readState: () => Promise.resolve(null),
      confirm: (q) => {
        confirmCalls.push(q);
        return Promise.resolve(true);
      },
    });

    const exitCode = await runUpgrade(baseArgs(), deps);

    expect(exitCode).toBe(0);
    expect(service.runCalls).toHaveLength(2);
    expect(service.runCalls[0]?.checkOnly).toBe(true);
    expect(service.runCalls[1]).toMatchObject({ checkOnly: false, restart: true });
    // No live hub: only the upgrade confirmation was asked, not a restart one.
    expect(confirmCalls).toHaveLength(1);
    expect(confirmCalls[0]).toContain('Upgrade 0.1.1 → 0.1.2 on stable?');
  });

  it('asks a second, separate question before restarting a live hub', async () => {
    const service = new QueueUpgradeService([availableReport(), upgradedReport('scheduled')]);
    const confirmCalls: string[] = [];
    const liveState: ServerState = {
      pid: 123,
      port: 3001,
      host: 'localhost',
      startedAt: 0,
      logFile: '/x.log',
      version: '0.1.1',
    };
    const { deps } = baseDeps(service, {
      isInteractive: () => true,
      readState: () => Promise.resolve(liveState),
      controller: { isAlive: () => true, terminate: () => undefined, kill: () => undefined },
      confirm: (q) => {
        confirmCalls.push(q);
        return Promise.resolve(true);
      },
    });

    await runUpgrade(baseArgs(), deps);

    expect(confirmCalls).toHaveLength(2);
    expect(confirmCalls[1]).toContain('Restart the running hub');
    expect(service.runCalls[1]).toMatchObject({ restart: true });
  });

  it('declines the restart when the second prompt is answered no', async () => {
    const service = new QueueUpgradeService([availableReport(), upgradedReport('skipped')]);
    const liveState: ServerState = {
      pid: 123,
      port: 3001,
      host: 'localhost',
      startedAt: 0,
      logFile: '/x.log',
      version: '0.1.1',
    };
    let calls = 0;
    const { deps } = baseDeps(service, {
      isInteractive: () => true,
      readState: () => Promise.resolve(liveState),
      controller: { isAlive: () => true, terminate: () => undefined, kill: () => undefined },
      confirm: () => {
        calls += 1;
        // Yes to the upgrade, no to the restart.
        return Promise.resolve(calls === 1);
      },
    });

    await runUpgrade(baseArgs(), deps);

    expect(service.runCalls[1]).toMatchObject({ restart: false });
  });

  it('declines the download and never calls run a second time', async () => {
    const service = new QueueUpgradeService([availableReport()]);
    const { deps, lines } = baseDeps(service, {
      isInteractive: () => true,
      confirm: () => Promise.resolve(false),
    });

    const exitCode = await runUpgrade(baseArgs(), deps);

    expect(exitCode).toBe(0);
    expect(service.runCalls).toHaveLength(1);
    expect(lines[0]).toContain('A newer build is available');
  });

  it('prints a delegate refusal with the command to run instead', async () => {
    const service = new QueueUpgradeService([
      {
        outcome: 'refused',
        installedVia: { manager: 'bun', channel: 'stable', executable: '/x' },
        currentVersion: '0.1.1',
        reason: 'package-manager',
        command: 'bun add -g mangostudio@latest',
        exitCode: 1,
      },
    ]);
    const { deps, lines } = baseDeps(service);

    const exitCode = await runUpgrade(baseArgs(), deps);

    expect(exitCode).toBe(1);
    expect(lines).toEqual([
      'MangoStudio will not upgrade itself here. Run: bun add -g mangostudio@latest',
    ]);
  });
});

describe('runUpgrade --rollback', () => {
  it('needs --yes or a confirmed prompt to run', async () => {
    const service = new QueueUpgradeService([upgradedReport('not-running')]);
    const { deps, lines } = baseDeps(service, { isInteractive: () => false });

    const exitCode = await runUpgrade(baseArgs({ rollback: true }), deps);

    expect(exitCode).toBe(0);
    expect(service.rollbackCalls).toHaveLength(0);
    expect(lines[0]).toContain('needs --yes');
  });

  it('rolls back with --yes, honoring --no-restart, and says so rather than "upgraded"', async () => {
    const service = new QueueUpgradeService([{ ...upgradedReport('skipped'), target: undefined }]);
    const { deps, lines } = baseDeps(service);

    await runUpgrade(baseArgs({ rollback: true, yes: true, noRestart: true }), deps);

    expect(service.rollbackCalls).toEqual([{ restart: false }]);
    expect(lines.at(-1)).toBe('Rolled back to the previous version.');
  });
});
