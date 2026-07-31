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
  } = {}
) {
  const calls: DistroCall[] = [];
  const requested: string[] = [];
  const written = new Map<string, Uint8Array>();
  let installed = options.installed;

  const provisioner = createWslProvisioner({
    version: () => VERSION,
    cacheDir: (version) => `/cache/${version}`,
    readCache: () => Promise.resolve(options.cached ?? null),
    writeCache: (path, bytes) => {
      written.set(path, bytes);
      return Promise.resolve();
    },
    runInDistro: (distro, script, runOptions) => {
      calls.push({ distro, script, stdinBytes: runOptions?.stdin?.byteLength ?? 0 });
      const override = options.respond?.(script);
      if (override) return Promise.resolve(override);
      if (script.includes('uname -m')) return Promise.resolve(ok('x86_64\nldd (GNU libc) 2.35\n'));
      if (script.includes('tar -xzf -')) {
        installed = VERSION;
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

  return { provisioner, calls, requested, written };
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

    await expect(provisioner.ensure('Ubuntu')).rejects.toThrow(/does not publish/);
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

  it('passes the distribution name through as data, never as script', async () => {
    const { provisioner, calls } = harness();
    const hostile = 'Ubuntu"; rm -rf /; #';

    await provisioner.ensure(hostile);

    expect(calls.every((call) => call.distro === hostile)).toBe(true);
    expect(calls.every((call) => !call.script.includes('rm -rf'))).toBe(true);
  });
});
