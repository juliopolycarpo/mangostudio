/**
 * The comparison view is the whole point of the umbrella growing an environment
 * dimension, so its cells are tested for the distinction that makes it useful:
 * "not installed here" and "this machine will not say" are different answers,
 * and only one of them is something to act on.
 */

import type { Environment } from '@mangostudio/shared/environments';
import { en } from '@mangostudio/shared/i18n';
import { describe, expect, it } from 'vitest';
import { CapabilityDiff } from '../../../../src/features/environments/components/CapabilityDiff';
import { render, screen, waitFor, within } from '../../../support/harness/render';
import { createFetchScenario } from '../../../support/mocks/create-fetch-scenario';
import { agentCliStatus, installation, runtimeStatus } from './fixtures';

function environment(
  overrides: Partial<Environment> & Pick<Environment, 'id' | 'name'>
): Environment {
  return {
    transportKind: 'wsl',
    config: {},
    enabled: true,
    virtual: false,
    createdAt: 0,
    updatedAt: 0,
    status: {
      state: 'connected',
      manifest: {
        platform: 'linux',
        arch: 'x64',
        pathStyle: 'posix',
        homeDir: '/home/dev',
        shells: ['bash'],
        git: { available: true },
        features: {
          tools: true,
          git: true,
          probing: true,
          mcp: true,
          library: false,
          checkpoints: true,
        },
      },
    },
    ...overrides,
  };
}

const WINDOWS = environment({
  id: 'local',
  name: 'Local',
  transportKind: 'in-process',
  virtual: true,
  status: {
    state: 'connected',
    manifest: {
      platform: 'win32',
      arch: 'x64',
      pathStyle: 'win32',
      homeDir: 'C:\\Users\\dev',
      shells: ['powershell'],
      git: { available: true },
      features: {
        tools: true,
        git: true,
        probing: true,
        mcp: true,
        library: false,
        checkpoints: true,
      },
    },
  },
});

function renderDiff(environments: readonly Environment[]) {
  return render(
    <CapabilityDiff
      environments={environments}
      leftId={environments[0]?.id ?? 'local'}
      rightId={environments[1]?.id ?? 'local'}
      onSelect={() => undefined}
      onClose={() => undefined}
    />
  );
}

/** Cell states of one row, left column first. */
function statesOf(rowKey: string): (string | undefined)[] {
  const row = screen
    .getAllByTestId('capability-diff-row')
    .find((candidate) => candidate.dataset.rowKey === rowKey);
  return within(row as HTMLElement)
    .getAllByTestId('capability-diff-cell')
    .map((cell) => cell.dataset.state);
}

describe('CapabilityDiff', () => {
  it('shows a toolchain present on one machine and absent on the other', async () => {
    const scenario = createFetchScenario();
    scenario.install();
    scenario.respondWithJson('GET', '/api/environments/runtimes', {
      body: [runtimeStatus({ id: 'node', installations: [], findings: [] })],
    });
    scenario.respondWithJson('GET', '/api/environments/agents', { body: [] });
    scenario.respondWithJson('GET', '/api/environments/runtimes?environmentId=ubuntu', {
      body: [
        runtimeStatus({
          id: 'node',
          installations: [
            installation({ path: '/usr/bin/node', version: '22.13.0', effective: true }),
          ],
          effective: installation({ path: '/usr/bin/node', version: '22.13.0', effective: true }),
        }),
      ],
    });
    scenario.respondWithJson('GET', '/api/environments/agents?environmentId=ubuntu', { body: [] });

    renderDiff([WINDOWS, environment({ id: 'ubuntu', name: 'Ubuntu' })]);

    await waitFor(() => {
      expect(screen.getAllByTestId('capability-diff-cell').length).toBeGreaterThan(0);
    });
    expect(statesOf('runtime:node')).toEqual(['absent', 'present']);
    scenario.restore();
  });

  it('reports a machine that does not answer as not-reported rather than empty', async () => {
    const scenario = createFetchScenario();
    scenario.install();
    scenario.respondWithJson('GET', '/api/environments/runtimes', {
      body: [
        runtimeStatus({
          id: 'bun',
          installations: [installation({ path: 'C:\\bun\\bun.exe', version: '1.3.0' })],
          effective: installation({ path: 'C:\\bun\\bun.exe', version: '1.3.0' }),
        }),
      ],
    });
    scenario.respondWithJson('GET', '/api/environments/agents', { body: [agentCliStatus()] });

    const silent = environment({ id: 'locked', name: 'Locked box' });
    renderDiff([
      WINDOWS,
      {
        ...silent,
        status: {
          ...silent.status,
          manifest: {
            ...(silent.status.manifest as NonNullable<Environment['status']['manifest']>),
            features: {
              tools: true,
              git: true,
              probing: false,
              mcp: true,
              library: false,
              checkpoints: true,
            },
          },
        },
      },
    ]);

    await waitFor(() => {
      expect(screen.getAllByTestId('capability-diff-cell').length).toBeGreaterThan(0);
    });
    expect(statesOf('runtime:bun')).toEqual(['present', 'not-permitted']);
    expect(screen.getAllByText(en.environments.scope.cellNotPermitted).length).toBeGreaterThan(0);
    scenario.restore();
  });

  it('compares shells from the handshake, not from a probe', async () => {
    const scenario = createFetchScenario();
    scenario.install();
    scenario.respondWithJson('GET', '/api/environments/runtimes', { body: [] });
    scenario.respondWithJson('GET', '/api/environments/agents', { body: [] });
    scenario.respondWithJson('GET', '/api/environments/runtimes?environmentId=ubuntu', {
      body: [],
    });
    scenario.respondWithJson('GET', '/api/environments/agents?environmentId=ubuntu', { body: [] });

    renderDiff([WINDOWS, environment({ id: 'ubuntu', name: 'Ubuntu' })]);

    await waitFor(() => {
      expect(screen.getAllByTestId('capability-diff-row').length).toBeGreaterThan(0);
    });
    expect(statesOf('shell:powershell')).toEqual(['present', 'absent']);
    expect(statesOf('shell:bash')).toEqual(['absent', 'present']);
    scenario.restore();
  });
});
