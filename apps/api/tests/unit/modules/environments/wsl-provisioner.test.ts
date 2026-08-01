import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
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

interface DistroCall {
  readonly distro: string;
  readonly script: string;
  readonly stdinBytes: number;
}

function ok(stdout = ''): DistroCommandResult {
  return { stdout, stderr: '', exitCode: 0 };
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

  const provisioner = createWslProvisioner({
    version: () => version,
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
      calls.push({ distro, script, stdinBytes: runOptions?.stdin?.byteLength ?? 0 });
      const override = options.respond?.(script);
      if (override) return Promise.resolve(override);
      if (script.includes('uname -m')) return Promise.resolve(ok('x86_64\nldd (GNU libc) 2.35\n'));
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

  return { provisioner, calls, read, requested, written };
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
    // Version check, platform probe, unpack with the archive on stdin, then the
    // version check again to prove what landed actually runs.
    expect(calls).toHaveLength(4);
    expect(calls.every((call) => call.distro === 'Ubuntu')).toBe(true);
    expect(calls[2]?.script).toContain('tar -xzf -');
    expect(calls[2]?.stdinBytes).toBe(ARCHIVE.byteLength);
  });

  it('does nothing when the distribution already matches this hub', async () => {
    const { provisioner, calls, requested } = harness({ installed: VERSION });

    await provisioner.ensure('Ubuntu');

    expect(calls).toHaveLength(1);
    expect(requested).toEqual([]);
  });

  it('replaces a runtime an older release left behind', async () => {
    const { provisioner, requested } = harness({ installed: '1.0.0' });

    await provisioner.ensure('Ubuntu');

    expect(requested).toHaveLength(2);
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
    // Only the version check and the platform probe ran; nothing was piped in.
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.stdinBytes === 0)).toBe(true);
  });

  it('says so when the release publishes no build for the distribution', async () => {
    const { provisioner } = harness({ checksums: 'unrelated content\n' });

    // Nothing to download here, so the offline advice would be a dead end: the
    // answer is a newer MangoStudio or a hand-placed binary.
    await expect(provisioner.ensure('Ubuntu')).rejects.toThrow(
      /does not publish .* put a matching runtime at ~\/\.mango\/bin\/mangostudio-runtime/s
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
          '~/\\.mango/bin/mangostudio-runtime inside "Ubuntu" yourself\\.',
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
    expect(calls[2]?.script).toContain('cat > ');
    expect(calls[2]?.script).not.toContain('tar');
    expect(calls[2]?.stdinBytes).toBe(build.byteLength);
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
