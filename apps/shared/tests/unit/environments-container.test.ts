import { describe, expect, it } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import {
  CONTAINER_MAX_MOUNTS,
  CONTAINER_RUNTIME_MOUNT_PATH,
  type ContainerEnvironmentConfig,
  ContainerEnvironmentConfigSchema,
  containerConfigRefusal,
  containerEngineOf,
  containerEngineVersionCommand,
  containerImageInspectCommand,
  containerKillCommand,
  containerLaunchCommand,
  containerName,
  containerProbeCommand,
  containerPullCommand,
  describeContainerMountRefusal,
} from '../../src/environments';
import { PLATFORM_PROBE_SCRIPT } from '../../src/runtime-home';

const RUNTIME_BINARY = '/home/j/.mango/runtime-cache/0.1.1/mangostudio-runtime-0.1.1-linux-x64';

function config(overrides: Partial<ContainerEnvironmentConfig> = {}): ContainerEnvironmentConfig {
  return { image: 'node:22', ...overrides };
}

function launchArgs(overrides: Partial<ContainerEnvironmentConfig> = {}): readonly string[] {
  return containerLaunchCommand({
    config: config(overrides),
    name: 'mango-rt-sandbox-abc123',
    runtimeBinaryPath: RUNTIME_BINARY,
  }).args;
}

/** The index of a flag's value, so assertions read positionally like the CLI does. */
function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

/** The English sentence a refusal renders as, or null when the config is fine. */
function refusalText(overrides: Partial<ContainerEnvironmentConfig>): string | null {
  const refusal = containerConfigRefusal(config(overrides));
  return refusal ? describeContainerMountRefusal(refusal) : null;
}

describe('container config schema', () => {
  it('accepts a bare image and every optional knob', () => {
    expect(Value.Check(ContainerEnvironmentConfigSchema, config())).toBe(true);
    expect(
      Value.Check(
        ContainerEnvironmentConfigSchema,
        config({
          engine: 'podman',
          network: false,
          cpus: 1.5,
          memoryMib: 2_048,
          mounts: [{ hostPath: '/home/j/project', containerPath: '/work', readonly: true }],
        })
      )
    ).toBe(true);
  });

  it('refuses an image that would reach the engine as an option', () => {
    expect(Value.Check(ContainerEnvironmentConfigSchema, config({ image: '--privileged' }))).toBe(
      false
    );
  });

  it('refuses whitespace in an image reference', () => {
    expect(
      Value.Check(ContainerEnvironmentConfigSchema, config({ image: 'node:22 --privileged' }))
    ).toBe(false);
  });

  it('accepts a registry, tag and digest together', () => {
    const image = 'ghcr.io/acme/tools:2024-06@sha256:abc123';
    expect(Value.Check(ContainerEnvironmentConfigSchema, config({ image }))).toBe(true);
  });

  it('refuses a relative container path', () => {
    expect(
      Value.Check(
        ContainerEnvironmentConfigSchema,
        config({ mounts: [{ hostPath: '/home/j', containerPath: 'work' }] })
      )
    ).toBe(false);
  });

  it('refuses more mounts than the bound allows', () => {
    const mounts = Array.from({ length: CONTAINER_MAX_MOUNTS + 1 }, (_, index) => ({
      hostPath: `/home/j/p${index}`,
      containerPath: `/work${index}`,
    }));
    expect(Value.Check(ContainerEnvironmentConfigSchema, config({ mounts }))).toBe(false);
  });

  it('refuses unknown fields rather than dropping them', () => {
    expect(
      Value.Check(ContainerEnvironmentConfigSchema, { image: 'node:22', privileged: true })
    ).toBe(false);
  });
});

describe('containerConfigRefusal', () => {
  it('passes a config with no mounts', () => {
    expect(containerConfigRefusal(config())).toBeNull();
  });

  it('passes an ordinary project mount in either path style', () => {
    expect(
      containerConfigRefusal(
        config({ mounts: [{ hostPath: '/home/j/project', containerPath: '/work' }] })
      )
    ).toBeNull();
    expect(
      containerConfigRefusal(
        config({ mounts: [{ hostPath: 'C:\\Users\\j\\project', containerPath: '/work' }] })
      )
    ).toBeNull();
  });

  it('refuses a relative host path', () => {
    expect(refusalText({ mounts: [{ hostPath: 'project', containerPath: '/work' }] })).toMatch(
      /not absolute/
    );
  });

  it.each([
    ['/var/run/docker.sock', /control of the container engine/],
    ['/run/podman/podman.sock', /control of the container engine/],
    ['/home/j/.docker/desktop/docker.sock', /control of the container engine/],
    ['/proc', /\/proc/],
    ['/proc/self', /\/proc/],
    ['/sys/fs/cgroup', /\/sys/],
    ['/var/run', /\/var\/run/],
    ['/run/user/1000', /\/run/],
  ])('refuses %s', (hostPath, expected) => {
    expect(refusalText({ mounts: [{ hostPath, containerPath: '/mnt/x' }] })).toMatch(expected);
  });

  it('refuses a denied path written in Windows separators', () => {
    expect(
      refusalText({ mounts: [{ hostPath: 'C:\\var\\run\\docker.sock', containerPath: '/mnt/x' }] })
    ).toMatch(/control of the container engine/);
  });

  it.each([
    // The directory holding a socket hands over the same socket one level up.
    ['/home/j/.docker/run', 'engine-control', undefined],
    ['/home/j/.docker', 'engine-control', undefined],
    ['/home/j/.podman/xdg', 'engine-control', undefined],
    // An ancestor of a denied prefix reaches it with an extra step.
    ['/var', 'denied-prefix', '/var/run'],
    ['/var/lib', 'denied-prefix', '/var/lib/docker'],
    // The engines' own state: every other container's rootfs and layers.
    ['/var/lib/docker', 'denied-prefix', '/var/lib/docker'],
    ['/var/lib/containers/storage', 'denied-prefix', '/var/lib/containers'],
  ] as const)('refuses %s, which reaches an engine socket or its state', (hostPath, code, prefix) => {
    const refusal = containerConfigRefusal(
      config({ mounts: [{ hostPath, containerPath: '/mnt/x' }] })
    );
    expect(refusal?.code).toBe(code);
    if (prefix !== undefined) expect(refusal?.params.prefix).toBe(prefix);
  });

  it('still calls the filesystem root a root rather than naming one denied child', () => {
    const refusal = containerConfigRefusal(
      config({ mounts: [{ hostPath: '/', containerPath: '/mnt/x' }] })
    );
    expect(refusal?.code).toBe('host-root');
  });

  it('allows a directory whose name merely contains a denied segment', () => {
    expect(
      containerConfigRefusal(
        config({ mounts: [{ hostPath: '/home/j/.dockerignore-samples', containerPath: '/work' }] })
      )
    ).toBeNull();
  });

  it('allows a path that merely starts with a denied prefix as a name', () => {
    expect(
      containerConfigRefusal(
        config({ mounts: [{ hostPath: '/proc-exports/data', containerPath: '/work' }] })
      )
    ).toBeNull();
  });

  it.each([
    ['/tmp/../proc', 'denied-prefix', '/proc'],
    ['/tmp/../../var/run', 'denied-prefix', '/var/run'],
    ['/home/j/../../var/run/docker.sock', 'engine-control', undefined],
  ] as const)('refuses a denied path spelled with a traversal segment: %s', (hostPath, code, prefix) => {
    const refusal = containerConfigRefusal(
      config({ mounts: [{ hostPath, containerPath: '/mnt/x' }] })
    );
    expect(refusal?.code).toBe(code);
    if (prefix !== undefined) expect(refusal?.params.prefix).toBe(prefix);
  });

  it('allows a traversal that resolves to an ordinary path', () => {
    expect(
      containerConfigRefusal(
        config({ mounts: [{ hostPath: '/home/j/project/../project', containerPath: '/work' }] })
      )
    ).toBeNull();
  });

  it.each([
    '/',
    'C:\\foo\\..\\..',
    'C:/',
    'C:\\',
    'c:/',
  ])('refuses the host filesystem root: %s', (hostPath) => {
    expect(refusalText({ mounts: [{ hostPath, containerPath: '/mnt/x' }] })).toMatch(
      /entire filesystem/
    );
  });

  it('refuses a host path carrying its own mount separator', () => {
    expect(
      refusalText({ mounts: [{ hostPath: '/home/j/p:/etc:ro', containerPath: '/work' }] })
    ).toMatch(/colon/);
  });

  it('refuses a mount that would shadow the runtime binary', () => {
    expect(
      refusalText({
        mounts: [{ hostPath: '/home/j/fake', containerPath: CONTAINER_RUNTIME_MOUNT_PATH }],
      })
    ).toMatch(/where the MangoStudio runtime is mounted/);
  });

  it('refuses a mount over the container root', () => {
    expect(refusalText({ mounts: [{ hostPath: '/home/j', containerPath: '/' }] })).toMatch(
      /replace the image/
    );
  });

  it('refuses two mounts on one target', () => {
    expect(
      refusalText({
        mounts: [
          { hostPath: '/home/j/a', containerPath: '/work' },
          { hostPath: '/home/j/b', containerPath: '/work' },
        ],
      })
    ).toMatch(/Two mounts/);
  });

  it('refuses two mounts on the same target spelled with a trailing slash', () => {
    const refusal = containerConfigRefusal(
      config({
        mounts: [
          { hostPath: '/home/j/a', containerPath: '/work' },
          { hostPath: '/home/j/b', containerPath: '/work/' },
        ],
      })
    );
    expect(refusal?.code).toBe('duplicate-target');
  });
});

describe('containerLaunchCommand', () => {
  it('defaults to docker and keeps the engine a binary name', () => {
    expect(containerEngineOf(config())).toBe('docker');
    expect(
      containerLaunchCommand({
        config: config(),
        name: 'mango-rt-sandbox-abc123',
        runtimeBinaryPath: RUNTIME_BINARY,
      }).command
    ).toBe('docker');
    expect(
      containerLaunchCommand({
        config: config({ engine: 'podman' }),
        name: 'mango-rt-sandbox-abc123',
        runtimeBinaryPath: RUNTIME_BINARY,
      }).command
    ).toBe('podman');
  });

  it('mounts the runtime read-only and runs it as the entrypoint', () => {
    const args = launchArgs();
    expect(args).toContain('-v');
    expect(args).toContain(`${RUNTIME_BINARY}:${CONTAINER_RUNTIME_MOUNT_PATH}:ro`);
    expect(valueAfter(args, '--entrypoint')).toBe(CONTAINER_RUNTIME_MOUNT_PATH);
  });

  it('puts the image last so the spawn can append --stdio as its argument', () => {
    expect(launchArgs().at(-1)).toBe('node:22');
  });

  it('never pulls at launch', () => {
    expect(launchArgs()).toContain('--pull=never');
  });

  it('keeps stdin open without a tty', () => {
    const args = launchArgs();
    expect(args).toContain('-i');
    expect(args).not.toContain('-t');
  });

  it('reaps grandchildren and removes the container', () => {
    const args = launchArgs();
    expect(args).toContain('--init');
    expect(args).toContain('--rm');
  });

  it('names the container so the backstop can aim at it', () => {
    expect(valueAfter(launchArgs(), '--name')).toBe('mango-rt-sandbox-abc123');
  });

  it('leaves the network on by default and takes it away only when asked', () => {
    expect(launchArgs()).not.toContain('--network');
    expect(launchArgs({ network: true })).not.toContain('--network');
    expect(valueAfter(launchArgs({ network: false }), '--network')).toBe('none');
  });

  it('passes resource limits in the units each engine flag takes', () => {
    expect(valueAfter(launchArgs({ cpus: 1.5 }), '--cpus')).toBe('1.5');
    expect(valueAfter(launchArgs({ memoryMib: 2_048 }), '--memory')).toBe('2048m');
  });

  it('omits resource flags entirely when unset', () => {
    const args = launchArgs();
    expect(args).not.toContain('--cpus');
    expect(args).not.toContain('--memory');
  });

  it('renders user mounts before the runtime mount, read-only when asked', () => {
    const args = launchArgs({
      mounts: [
        { hostPath: '/home/j/project', containerPath: '/work' },
        { hostPath: '/home/j/cache', containerPath: '/cache', readonly: true },
      ],
    });
    expect(args).toContain('/home/j/project:/work');
    expect(args).toContain('/home/j/cache:/cache:ro');
    expect(args.indexOf('/home/j/project:/work')).toBeLessThan(
      args.indexOf(`${RUNTIME_BINARY}:${CONTAINER_RUNTIME_MOUNT_PATH}:ro`)
    );
  });

  it('passes every value as its own argv entry', () => {
    // The whole injection defence: nothing here is a string a shell parses, so
    // an image or a path can only ever be one argument.
    for (const arg of launchArgs({ mounts: [{ hostPath: '/a b', containerPath: '/c d' }] })) {
      expect(typeof arg).toBe('string');
    }
    expect(launchArgs({ mounts: [{ hostPath: '/a b', containerPath: '/c d' }] })).toContain(
      '/a b:/c d'
    );
  });
});

describe('container support commands', () => {
  it('probes the image with no network and no pull', () => {
    const probe = containerProbeCommand(config(), PLATFORM_PROBE_SCRIPT);
    expect(probe.command).toBe('docker');
    expect(probe.args).toEqual([
      'run',
      '--rm',
      '--pull=never',
      '--network',
      'none',
      '--entrypoint',
      'sh',
      'node:22',
      '-c',
      PLATFORM_PROBE_SCRIPT,
    ]);
  });

  it('asks the engine whether it already holds the image', () => {
    expect(containerImageInspectCommand(config()).args).toEqual([
      'image',
      'inspect',
      '--format',
      '{{.Id}}',
      'node:22',
    ]);
  });

  it('pulls by name', () => {
    expect(containerPullCommand(config({ engine: 'podman' }))).toEqual({
      command: 'podman',
      args: ['pull', 'node:22'],
    });
  });

  it('kills by container name, never by image', () => {
    const kill = containerKillCommand('docker', 'mango-rt-sandbox-abc123');
    expect(kill.args).toEqual(['kill', 'mango-rt-sandbox-abc123']);
    expect(kill.args).not.toContain('node:22');
  });

  it('reads a version out of either engine', () => {
    expect(containerEngineVersionCommand('podman').command).toBe('podman');
    expect(containerEngineVersionCommand('docker').args).toContain('version');
  });
});

describe('containerName', () => {
  it('is prefixed, environment-scoped and nonce-suffixed', () => {
    expect(containerName('sandbox', 'abc123')).toBe('mango-rt-sandbox-abc123');
  });

  it('produces a name both engines accept', () => {
    expect(containerName('my-env-2', 'f00ba7')).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
  });
});
