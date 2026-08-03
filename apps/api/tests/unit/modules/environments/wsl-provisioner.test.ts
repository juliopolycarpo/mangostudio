import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import type { RuntimeSlotConfig } from '@mangostudio/shared/runtime-home';
import {
  createWslProvisioner,
  type DistroCommandResult,
  WslProvisioningError,
} from '../../../../src/modules/environments/infrastructure/wsl-provisioner';

const VERSION = '1.2.3';
const ASSET = `mangostudio-${VERSION}-linux-x64.tar.gz`;
const ARCHIVE = new TextEncoder().encode('pretend this is a tar.gz');
const DIGEST = createHash('sha256').update(ARCHIVE).digest('hex');
const CHECKSUMS = `${DIGEST}  ${ASSET}\n`;
const DISTRO_HOME = '/home/dev';

interface DistroCall {
  readonly distro: string;
  readonly script: string;
  readonly stdinBytes: number;
  readonly args: readonly string[];
}

function ok(stdout = ''): DistroCommandResult {
  return { stdout, stderr: '', exitCode: 0 };
}

/** What the hub would have written for a distribution already holding `version`. */
function provisionedConfig(version: string, bytes: Uint8Array): RuntimeSlotConfig {
  return {
    schemaVersion: 1,
    slot: 'wsl',
    source: 'provisioned',
    version,
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    profile: 'full',
    setup: { state: 'configured', by: 'cli' },
  };
}

function harness(
  options: {
    /** Consulted first; falls through to the healthy defaults when it returns nothing. */
    readonly respond?: (script: string) => DistroCommandResult | undefined;
    readonly cached?: Uint8Array | null;
    readonly checksums?: string;
    readonly archive?: Uint8Array;
    /** Version the distribution already reports, if any, before provisioning. */
    readonly installed?: string;
    /** What the distribution's `runtime.json` says before provisioning. */
    readonly config?: RuntimeSlotConfig | null;
    /** What this hub reports, which decides whether a release exists to install from. */
    readonly version?: string;
    /** Bytes at the local build path, standing in for a checkout that built one. */
    readonly localBuild?: Uint8Array | null;
  } = {}
) {
  const version = options.version ?? VERSION;
  const calls: DistroCall[] = [];
  const requested: string[] = [];
  const read: string[] = [];
  const written = new Map<string, Uint8Array>();
  let installed = options.installed;
  let config = options.config ?? null;

  const provisioner = createWslProvisioner({
    version: () => version,
    hubHost: () => 'win-desktop',
    cacheDir: (cacheVersion) => `/cache/${cacheVersion}`,
    localBuildPath: (platformId) => `/repo/.mango/out/${platformId}/mangostudio-runtime`,
    readBytes: (path) => {
      read.push(path);
      return Promise.resolve(
        path.startsWith('/repo/') ? (options.localBuild ?? null) : (options.cached ?? null)
      );
    },
    writeCache: (path, bytes) => {
      written.set(path, bytes);
      return Promise.resolve();
    },
    runInDistro: (distro, script, runOptions) => {
      calls.push({
        distro,
        script,
        stdinBytes: runOptions?.stdin?.byteLength ?? 0,
        args: runOptions?.args ?? [],
      });
      const override = options.respond?.(script);
      if (override) return Promise.resolve(override);
      // Before the `printf` arm: the config write prints a lock owner too, so
      // the looser pattern would swallow it and record nothing.
      if (script.includes('runtime.json.incoming')) {
        config = JSON.parse(new TextDecoder().decode(runOptions?.stdin)) as RuntimeSlotConfig;
        return Promise.resolve(ok());
      }
      if (script.startsWith('printf')) {
        return Promise.resolve(ok(`${DISTRO_HOME}\n${config ? JSON.stringify(config) : ''}`));
      }
      if (script.includes('uname -m')) return Promise.resolve(ok('x86_64\nldd (GNU libc) 2.35\n'));
      if (script.includes('setup --profile')) {
        config = { ...(config as RuntimeSlotConfig), setup: { state: 'configured', by: 'cli' } };
        return Promise.resolve(ok());
      }
      if (script.includes('.mango/bin')) return Promise.resolve(ok());
      if (script.includes('mv -f ')) {
        installed = version;
        return Promise.resolve(ok());
      }
      return Promise.resolve(
        installed
          ? ok(`${installed}\n`)
          : { stdout: '', stderr: 'sh: no such file or directory', exitCode: 127 }
      );
    },
    fetch: ((input: string | URL) => {
      const url = String(input);
      requested.push(url);
      const body = url.endsWith('SHA256SUMS')
        ? new TextEncoder().encode(options.checksums ?? CHECKSUMS)
        : (options.archive ?? ARCHIVE);
      return Promise.resolve(new Response(body, { status: 200 }));
    }) as typeof fetch,
  });

  return { provisioner, calls, read, requested, written, config: () => config };
}

describe('WslProvisioner', () => {
  it('downloads, verifies, unpacks, and confirms the runtime runs', async () => {
    const { provisioner, calls, requested, written } = harness();

    await provisioner.ensure('Ubuntu');

    expect(requested).toEqual([
      `https://github.com/juliopolycarpo/mangostudio/releases/download/v${VERSION}/SHA256SUMS`,
      `https://github.com/juliopolycarpo/mangostudio/releases/download/v${VERSION}/${ASSET}`,
    ]);
    expect(written.get(`/cache/${VERSION}/${ASSET}`)).toEqual(ARCHIVE);
    expect(calls.every((call) => call.distro === 'Ubuntu')).toBe(true);

    const unpack = calls.find((call) => call.script.includes('tar -xzf -'));
    expect(unpack?.stdinBytes).toBe(ARCHIVE.byteLength);
    // The version is an argv entry, never text inside the script.
    expect(unpack?.args).toEqual([VERSION]);
  });

  it('records what it installed and what the distribution may do', async () => {
    const { provisioner, calls, config } = harness();

    await provisioner.ensure('Ubuntu');

    expect(config()).toMatchObject({
      slot: 'wsl',
      source: 'provisioned',
      version: VERSION,
      digest: `sha256:${DIGEST}`,
      binaryPath: `${DISTRO_HOME}/.mango/runtime/wsl/${VERSION}/mangostudio-runtime`,
      installedBy: { host: 'win-desktop', transport: 'wsl' },
    });
    // Consent is written by the runtime's own `setup`, never by the hub.
    expect(calls.some((call) => call.script.includes('setup --profile full --yes'))).toBe(true);
  });

  it('deletes the unversioned binary the previous layout left behind', async () => {
    const { provisioner, calls } = harness();

    await provisioner.ensure('Ubuntu');

    expect(calls.some((call) => call.script.includes('rm -f "$HOME/.mango/bin/'))).toBe(true);
  });

  it('does nothing when the distribution already matches this hub', async () => {
    const { provisioner, calls, requested } = harness({
      installed: VERSION,
      config: provisionedConfig(VERSION, ARCHIVE),
    });

    await provisioner.ensure('Ubuntu');

    // What it holds, then that it still runs — and nothing else.
    expect(calls).toHaveLength(2);
    expect(requested).toEqual([]);
  });

  it('reinstalls when the recorded runtime is no longer there', async () => {
    const { provisioner, requested } = harness({ config: provisionedConfig(VERSION, ARCHIVE) });

    await provisioner.ensure('Ubuntu');

    expect(requested).toHaveLength(2);
  });

  it('replaces a runtime an older release left behind', async () => {
    const { provisioner, requested } = harness({
      installed: '1.0.0',
      config: provisionedConfig('1.0.0', ARCHIVE),
    });

    await provisioner.ensure('Ubuntu');

    expect(requested).toHaveLength(2);
  });

  it('arms the gate rather than re-granting when the distribution config is unreadable', async () => {
    // The file that could not be read may have narrowed this distribution, and
    // an unknown answer must not resolve to full.
    const { provisioner, calls, config } = harness({
      respond: (script) => (script.startsWith('printf') ? ok('/home/dev\n{ truncated') : undefined),
    });

    await provisioner.ensure('Ubuntu');

    expect(calls.some((call) => call.script.includes('setup --profile'))).toBe(false);
    expect(config()).toMatchObject({ setup: { state: 'pending', by: 'install' } });
  });

  it('leaves consent alone when it upgrades a distribution', async () => {
    const { provisioner, calls, config } = harness({
      installed: '1.0.0',
      config: {
        ...provisionedConfig('1.0.0', ARCHIVE),
        profile: 'readonly',
        allow: { fsRead: true, shell: false },
      },
    });

    await provisioner.ensure('Ubuntu');

    expect(calls.some((call) => call.script.includes('setup --profile'))).toBe(false);
    expect(config()).toMatchObject({ version: VERSION, profile: 'readonly' });
  });

  it('reuses a cached archive whose digest still matches', async () => {
    const { provisioner, requested } = harness({ cached: ARCHIVE });

    await provisioner.ensure('Ubuntu');

    // The checksum is still fetched — it is what proves the cache entry is the
    // right bytes — but the archive itself is not downloaded again.
    expect(requested).toEqual([
      `https://github.com/juliopolycarpo/mangostudio/releases/download/v${VERSION}/SHA256SUMS`,
    ]);
  });

  it('re-downloads when the cached archive does not match', async () => {
    const { provisioner, requested } = harness({
      cached: new TextEncoder().encode('a stale or corrupted archive'),
    });

    await provisioner.ensure('Ubuntu');

    expect(requested).toHaveLength(2);
  });

  it('refuses an archive whose digest is not the published one', async () => {
    const { provisioner, calls } = harness({
      archive: new TextEncoder().encode('substituted payload'),
    });

    await expect(provisioner.ensure('Ubuntu')).rejects.toThrow(WslProvisioningError);
    // Only the two probes ran; nothing was piped into the distribution.
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.stdinBytes === 0)).toBe(true);
  });

  it('says so when the release publishes no build for the distribution', async () => {
    const { provisioner } = harness({ checksums: 'unrelated content\n' });

    // Nothing to download here, so the offline advice would be a dead end: the
    // answer is a newer MangoStudio or a hand-placed binary.
    await expect(provisioner.ensure('Ubuntu')).rejects.toThrow(
      /does not publish .* put a matching runtime at ~\/\.mango\/runtime\/wsl\/current\/mangostudio-runtime/s
    );
  });

  it('names both ways out when the release cannot be reached', async () => {
    const provisioner = createWslProvisioner({
      version: () => VERSION,
      cacheDir: (version) => `/cache/${version}`,
      readBytes: () => Promise.resolve(null),
      runInDistro: (_distro, script) =>
        script.includes('uname -m')
          ? Promise.resolve(ok('x86_64\nldd (GNU libc) 2.35\n'))
          : Promise.resolve({ stdout: '', stderr: 'not found', exitCode: 127 }),
      fetch: ((_input: string | URL): Promise<Response> =>
        Promise.reject(new Error('getaddrinfo ENOTFOUND'))) as typeof fetch,
    });

    // An air-gapped or proxied hub has no other move, so both are spelled out:
    // where the cache expects the archive, and where the binary belongs.
    await expect(provisioner.ensure('Ubuntu')).rejects.toThrow(
      new RegExp(
        `Could not download .*\\. Either download .*/${ASSET} to /cache/${VERSION}/${ASSET} ` +
          'on this host and connect again, or put the 1\\.2\\.3 runtime at ' +
          '~/\\.mango/runtime/wsl/current/mangostudio-runtime inside "Ubuntu" yourself\\.',
        's'
      )
    );
  });

  it('reports a distribution that cannot start', async () => {
    const provisioner = createWslProvisioner({
      version: () => VERSION,
      runInDistro: () =>
        Promise.resolve({
          stdout: '',
          stderr: 'There is no distribution with the supplied name.',
          exitCode: 1,
        }),
    });

    await expect(provisioner.ensure('Missing')).rejects.toThrow(
      /Could not start the "Missing" distribution: There is no distribution/
    );
  });

  it('names the signal when a command is killed instead of exiting', async () => {
    // What the timeout looks like from here: no output, no exit code, and a
    // stopped distribution that never finished booting.
    const provisioner = createWslProvisioner({
      version: () => VERSION,
      runInDistro: () =>
        Promise.resolve({ stdout: '', stderr: '', exitCode: -1, signal: 'SIGTERM' }),
    });

    await expect(provisioner.ensure('Ubuntu')).rejects.toThrow(
      /Could not start the "Ubuntu" distribution: it was stopped by SIGTERM after 120s/
    );
  });

  it('reports a runtime that lands but will not execute', async () => {
    const { provisioner } = harness({
      // The unpack succeeds; only running the result fails, which is what a
      // wrong-architecture build looks like from here.
      respond: (script) =>
        script.includes('--version') && !script.includes('uname')
          ? { stdout: '', stderr: 'Exec format error', exitCode: 126 }
          : undefined,
    });

    await expect(provisioner.ensure('Ubuntu')).rejects.toThrow(/does not run there: Exec format/);
  });

  it('installs the checkout own build instead of asking for a release that cannot exist', async () => {
    const build = new TextEncoder().encode('a runtime this checkout compiled');
    const { provisioner, calls, read, requested } = harness({ version: 'dev', localBuild: build });

    await provisioner.ensure('Ubuntu');

    // There is no `vdev` tag and never will be, so nothing is downloaded and the
    // binary goes in whole rather than being unpacked from an archive.
    expect(requested).toEqual([]);
    expect(read).toEqual(['/repo/.mango/out/linux-x64/mangostudio-runtime']);
    const unpack = calls.find((call) => call.stdinBytes === build.byteLength);
    expect(unpack?.script).toContain('cat > ');
    expect(unpack?.script).not.toContain('tar');
  });

  it('leaves a checkout alone when the build it would push is already there', async () => {
    const build = new TextEncoder().encode('a runtime this checkout compiled');
    const { provisioner, calls } = harness({
      version: 'dev',
      installed: 'dev',
      localBuild: build,
      config: provisionedConfig('dev', build),
    });

    await provisioner.ensure('Ubuntu');

    expect(calls.some((call) => call.stdinBytes > 0)).toBe(false);
  });

  it('re-pushes a checkout build that changed under the same dev version', async () => {
    // The hole version equality cannot see: two `dev` builds are different
    // binaries with the same name, so without a digest the first one installed
    // would stay in the distribution forever.
    const rebuilt = new TextEncoder().encode('a runtime this checkout rebuilt');
    const { provisioner, calls } = harness({
      version: 'dev',
      installed: 'dev',
      localBuild: rebuilt,
      config: provisionedConfig('dev', new TextEncoder().encode('the previous build')),
    });

    await provisioner.ensure('Ubuntu');

    expect(calls.some((call) => call.stdinBytes === rebuilt.byteLength)).toBe(true);
  });

  it('tells a checkout how to build the runtime it does not have', async () => {
    const { provisioner, requested } = harness({ version: 'dev', localBuild: null });

    await expect(provisioner.ensure('Ubuntu')).rejects.toThrow(
      /source checkout.*bun build apps\/runtime\/src\/cli\.ts --compile --target=bun-linux-x64 --outfile \/repo\/\.mango\/out\/linux-x64\/mangostudio-runtime/s
    );
    // A release URL or a cache path would be a dead end here; neither is offered.
    expect(requested).toEqual([]);
  });

  it('names the version stamp when a checkout built a release runtime by mistake', async () => {
    // What `bun run build:binary` leaves at that path: a runtime carrying the
    // package version, which the handshake would refuse against a `dev` hub.
    const { provisioner } = harness({
      version: 'dev',
      localBuild: new TextEncoder().encode('a version-stamped build'),
      respond: (script) =>
        script.includes('--version') && !script.includes('uname')
          ? { stdout: '0.1.1\n', stderr: '', exitCode: 0 }
          : undefined,
    });

    await expect(provisioner.ensure('Ubuntu')).rejects.toThrow(
      /reports version 0\.1\.1 rather than dev\. .*without a version stamp/s
    );
  });

  it('passes the distribution name through as data, never as script', async () => {
    const { provisioner, calls } = harness();
    const hostile = 'Ubuntu"; rm -rf /; #';

    await provisioner.ensure(hostile);

    expect(calls.every((call) => call.distro === hostile)).toBe(true);
    expect(calls.every((call) => !call.script.includes('rm -rf'))).toBe(true);
  });
});
