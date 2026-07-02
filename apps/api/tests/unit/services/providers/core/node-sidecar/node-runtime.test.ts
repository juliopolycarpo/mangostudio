import { describe, expect, it } from 'bun:test';
import {
  createNodeRuntimeDetector,
  type NodeRuntimeProbeDeps,
} from '../../../../../../src/services/providers/core/node-sidecar/node-runtime';

function fakeDeps(overrides: Partial<NodeRuntimeProbeDeps> = {}): Partial<NodeRuntimeProbeDeps> {
  return {
    platform: 'linux',
    env: { PATH: '' },
    homeDir: '/home/tester',
    configuredNodePath: '',
    pathExists: () => false,
    probeVersion: () => Promise.resolve(null),
    ...overrides,
  };
}

const fakeDetector = createNodeRuntimeDetector({
  minimumVersion: { major: 20, minor: 5 },
  reasonCodes: {
    nodeNotFound: 'fake.node_not_found',
    nodeInvalid: 'fake.node_invalid',
    versionInsufficient: 'fake.version_insufficient',
  },
});

describe('generic node sidecar runtime detector', () => {
  it('uses provider-owned reason codes for configured binary failures', async () => {
    const status = await fakeDetector.probeNodeRuntime(
      fakeDeps({
        configuredNodePath: '/opt/fake/node',
        probeVersion: () => Promise.resolve(null),
      })
    );

    expect(status).toEqual({
      available: false,
      nodePath: '/opt/fake/node',
      reasonCode: 'fake.node_invalid',
      reasonParams: { nodePath: '/opt/fake/node' },
    });
  });

  it('applies the provider minimum version while scanning for a newer install', async () => {
    const status = await fakeDetector.probeNodeRuntime(
      fakeDeps({
        env: { PATH: '/old/bin:/new/bin' },
        pathExists: (path) => path === '/old/bin/node' || path === '/new/bin/node',
        probeVersion: (binary) =>
          Promise.resolve(binary === '/new/bin/node' ? 'v20.5.0' : 'v20.4.9'),
      })
    );

    expect(status).toEqual({
      available: true,
      nodePath: '/new/bin/node',
      version: 'v20.5.0',
    });
  });

  it('returns the provider namespace when no candidate is new enough', async () => {
    const status = await fakeDetector.probeNodeRuntime(
      fakeDeps({
        env: { PATH: '/old/bin' },
        pathExists: (path) => path === '/old/bin/node',
        probeVersion: () => Promise.resolve('v20.4.9'),
      })
    );

    expect(status.available).toBe(false);
    expect(status.reasonCode).toBe('fake.version_insufficient');
    expect(status.reasonParams).toEqual({ foundVersion: 'v20.4.9' });
  });
});
