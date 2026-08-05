/**
 * Exercises the container launcher against a real engine.
 *
 * The framing is the stdio transport's and is covered by its own conformance
 * suite; what only a real engine and a real image can prove is the launcher —
 * that the constructed argv starts a runtime off a read-only bind mount, that
 * `--network none` actually takes the network away, and that nothing is left
 * running once the connection ends.
 *
 * Self-skipping, like the sshd and Git suites, but on more than tool
 * availability: this needs a compiled Linux runtime binary matching the image's
 * libc, which a source checkout does not have lying around. Both are named by
 * environment so the CI job can point at the release bytes it already
 * downloaded rather than compiling a second copy:
 *
 *   MANGO_CONTAINER_E2E_IMAGE    a shell-bearing Linux image, present locally
 *   MANGO_CONTAINER_E2E_RUNTIME  absolute path to a matching runtime binary
 *   MANGO_CONTAINER_E2E_ENGINE   docker (default) or podman
 *
 * The runtime binary is injected rather than resolved: which bytes a platform
 * needs is settled by unit tests, and this suite is about what the engine does
 * with them.
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import type { ContainerEngine, ContainerEnvironmentConfig } from '@mangostudio/shared/environments';
import { CONTAINER_NAME_PREFIX } from '@mangostudio/shared/environments';
import { connectContainerRuntime } from '../../../src/services/runtime-client/connect-container-runtime';

const SHELL_DEFAULTS = { kind: 'bash', timeoutMs: 20_000, maxOutputBytes: 65_536 } as const;

const image = process.env.MANGO_CONTAINER_E2E_IMAGE?.trim() ?? '';
const runtimeBinary = process.env.MANGO_CONTAINER_E2E_RUNTIME?.trim() ?? '';
const engine: ContainerEngine =
  process.env.MANGO_CONTAINER_E2E_ENGINE?.trim() === 'podman' ? 'podman' : 'docker';

const ready = image !== '' && runtimeBinary !== '' && (await canRun());

function run(args: readonly string[], timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(engine, [...args], { timeout: timeoutMs }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

/** Everything this suite needs, checked the way the connector would find it. */
async function canRun(): Promise<boolean> {
  try {
    await access(runtimeBinary, constants.X_OK);
    await run(['image', 'inspect', '--format', '{{.Id}}', image], 30_000);
    return true;
  } catch {
    return false;
  }
}

/** Containers this hub started that are still around, by name. */
async function survivingContainers(): Promise<string[]> {
  const stdout = await run([
    'ps',
    '-a',
    '--format',
    '{{.Names}}',
    '--filter',
    `name=${CONTAINER_NAME_PREFIX}-`,
  ]);
  return stdout.split('\n').filter((line) => line.trim().length > 0);
}

function open(config: Partial<ContainerEnvironmentConfig> = {}) {
  return connectContainerRuntime(
    { id: 'e2e-sandbox', config: { image, engine, ...config } },
    () => undefined,
    undefined,
    { resolveRuntimeBinary: () => Promise.resolve(runtimeBinary) }
  );
}

afterAll(async () => {
  if (!ready) return;
  // A failed assertion can skip a `close()`; nothing should outlive the suite.
  for (const name of await survivingContainers()) {
    await run(['kill', name], 30_000).catch(() => undefined);
  }
});

describe('connectContainerRuntime against a real engine', () => {
  it.skipIf(!ready)(
    'handshakes with a runtime mounted into the image',
    async () => {
      const connection = await open();
      try {
        expect(connection.client.manifest.pathStyle).toBe('posix');
        expect(connection.client.manifest.features.tools).toBe(true);
      } finally {
        await connection.close();
      }
    },
    180_000
  );

  it.skipIf(!ready)(
    'runs a shell command inside the container rather than on the hub',
    async () => {
      const connection = await open();
      try {
        const result = await connection.client.shell.run({
          ...SHELL_DEFAULTS,
          // The hub's own hostname is not the container's, and /.dockerenv or
          // an empty /proc/1/cgroup only exist on the far side of the boundary.
          command:
            'printf %s ran-in-container; test -r /opt/mangostudio-runtime && printf %s :mounted',
        });
        expect(result.stdout).toContain('ran-in-container:mounted');
      } finally {
        await connection.close();
      }
    },
    180_000
  );

  it.skipIf(!ready)(
    'mounts the runtime read-only',
    async () => {
      const connection = await open();
      try {
        const result = await connection.client.shell.run({
          ...SHELL_DEFAULTS,
          command:
            'printf x >> /opt/mangostudio-runtime 2>/dev/null && printf %s writable || printf %s readonly',
        });
        expect(result.stdout).toContain('readonly');
      } finally {
        await connection.close();
      }
    },
    180_000
  );

  it.skipIf(!ready)(
    'takes the network away when the environment says so',
    async () => {
      // Reading the interface list rather than reaching for curl: the image is
      // the user's and need not ship a network tool, while /sys/class/net is
      // there in every Linux container and says exactly what the flag did.
      const withNetwork = await open({ network: true });
      let interfaces: string;
      try {
        interfaces = (
          await withNetwork.client.shell.run({ ...SHELL_DEFAULTS, command: 'ls /sys/class/net' })
        ).stdout;
      } finally {
        await withNetwork.close();
      }
      expect(interfaces).toContain('eth0');

      const isolated = await open({ network: false });
      try {
        const result = await isolated.client.shell.run({
          ...SHELL_DEFAULTS,
          command: 'ls /sys/class/net',
        });
        expect(result.stdout).toContain('lo');
        expect(result.stdout).not.toContain('eth0');
      } finally {
        await isolated.close();
      }
    },
    240_000
  );

  it.skipIf(!ready)(
    'shares a host directory when the environment mounts one',
    async () => {
      const connection = await open({
        mounts: [{ hostPath: process.cwd(), containerPath: '/mnt/hub', readonly: true }],
      });
      try {
        const result = await connection.client.shell.run({
          ...SHELL_DEFAULTS,
          command: 'test -f /mnt/hub/package.json && printf %s shared',
        });
        expect(result.stdout).toContain('shared');
      } finally {
        await connection.close();
      }
    },
    180_000
  );

  it.skipIf(!ready)(
    'leaves no container behind when the connection ends',
    async () => {
      const before = await survivingContainers();

      const connection = await open();
      await connection.client.shell.run({ ...SHELL_DEFAULTS, command: 'true' });
      await connection.close();

      // `--rm` is asynchronous in the engine, so allow the reaper a moment
      // rather than racing it and blaming the backstop.
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if ((await survivingContainers()).length <= before.length) break;
        await Bun.sleep(250);
      }
      expect(await survivingContainers()).toEqual(before);
    },
    180_000
  );
});
