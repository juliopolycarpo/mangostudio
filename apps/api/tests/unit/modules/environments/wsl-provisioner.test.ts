import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeSlotConfig } from '@mangostudio/shared/runtime-home';
import {
  createWslProvisioner,
  type DistroCommandResult,
  WslProvisioningError,
} from '../../../../src/modules/environments/infrastructure/wsl-provisioner';

const VERSION = '1.2.3';
const ASSET = `mangostudio-${VERSION}-linux-x64.tar.gz`;
const RAW_ASSET = `mangostudio-runtime-${VERSION}-linux-x64`;
const ARCHIVE = new TextEncoder().encode('pretend this is a tar.gz');
const DIGEST = createHash('sha256').update(ARCHIVE).digest('hex');
const CHECKSUMS = `${DIGEST}  ${RAW_ASSET}\n${DIGEST}  ${ASSET}\n`;
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
    /** Overrides the (otherwise fake) cache directory — used for real-fs GC tests. */
    readonly cacheDirOverride?: (version: string) => string;
    /** Stands in for a full disk or an unwritable cache directory. */
    readonly writeCacheFails?: boolean;
    /**
     * `canary-manifest.json` the rolling tag serves, or null for a release that
     * publishes none. Only consulted on a rolling version.
     */
    readonly manifest?: string | null;
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
    cacheDir: options.cacheDirOverride ?? ((cacheVersion) => `/cache/${cacheVersion}`),
    localBuildPath: (platformId) => `/repo/.mango/out/${platformId}/mangostudio-runtime`,
    readBytes: (path) => {
      read.push(path);
      return Promise.resolve(
        path.startsWith('/repo/') ? (options.localBuild ?? null) : (options.cached ?? null)
      );
    },
    writeCache: (path, bytes) => {
      if (options.writeCacheFails) return Promise.reject(new Error('disk full'));
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
      // The real runner reports as it writes; a fake that swallows the callback
      // would let the progress plumbing rot without a test noticing.
      if (runOptions?.stdin && runOptions.onStdinProgress) {
        runOptions.onStdinProgress(runOptions.stdin.byteLength);
      }
      const override = options.respond?.(script);
      if (override) return Promise.resolve(override);
      // Before the `printf` arm: the config write prints a lock owner too, so
      // the looser pattern would swallow it and record nothing.
      if (script.includes('runtime.json.incoming')) {
        config = JSON.parse(new TextDecoder().decode(runOptions?.stdin)) as RuntimeSlotConfig;
        return Promise.resolve(ok());
      }
      if (script.startsWith('printf')) {
        // The slot probe: home, then the platform preamble, then whatever
        // config is on record. Version is a separate round trip, below.
        return Promise.resolve(
          ok(
            `${DISTRO_HOME}\nLinux\nx86_64\nldd (GNU libc) 2.35\n` +
              (config ? JSON.stringify(config) : '')
          )
        );
      }
      if (script.includes('setup --profile')) {
        config = { ...(config as RuntimeSlotConfig), setup: { state: 'configured', by: 'cli' } };
        return Promise.resolve(ok());
      }
      if (script.includes('.mango/bin')) return Promise.resolve(ok());
      if (script.includes('mv -f ')) {
        installed = version;
        return Promise.resolve(ok());
      }
      // VERSION_SCRIPT, the one remaining branch: reports what runs, or fails
      // the way a missing/wedged binary would.
      return Promise.resolve(
        installed
          ? ok(`${installed}\n`)
          : { stdout: '', stderr: 'sh: no such file or directory', exitCode: 127 }
      );
    },
    fetch: ((input: string | URL) => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith('canary-manifest.json')) {
        return Promise.resolve(
          options.manifest
            ? new Response(new TextEncoder().encode(options.manifest), { status: 200 })
            : new Response('not found', { status: 404 })
        );
      }
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
      `https://github.com/juliopolycarpo/mangostudio/releases/download/v${VERSION}/${RAW_ASSET}`,
    ]);
    expect(written.get(`/cache/${VERSION}/${RAW_ASSET}`)).toEqual(ARCHIVE);
    expect(calls.every((call) => call.distro === 'Ubuntu')).toBe(true);

    const unpack = calls.find((call) => call.script.includes('cat > '));
    expect(unpack?.stdinBytes).toBe(ARCHIVE.byteLength);
    expect(unpack?.script).not.toContain('tar');
    // The version is an argv entry, never text inside the script.
    expect(unpack?.args).toEqual([VERSION]);
  });

  it('merges the platform probe into the initial slot probe', async () => {
    const { provisioner, calls } = harness();

    await provisioner.ensure('Ubuntu');

    // Exactly one call happens before the runtime is pushed: the merged
    // slot probe, which now also answers the platform question a separate
    // PLATFORM_PROBE_SCRIPT call used to.
    expect(calls[0]?.script.startsWith('printf')).toBe(true);
    const pushIndex = calls.findIndex((call) => call.script.includes('cat > '));
    expect(pushIndex).toBe(1);
  });

  it('falls back to the platform archive when the raw asset is unpublished', async () => {
    const { provisioner, calls, requested, written } = harness({
      checksums: `${DIGEST}  ${ASSET}\n`,
    });

    await provisioner.ensure('Ubuntu');

    expect(requested).toEqual([
      `https://github.com/juliopolycarpo/mangostudio/releases/download/v${VERSION}/SHA256SUMS`,
      `https://github.com/juliopolycarpo/mangostudio/releases/download/v${VERSION}/SHA256SUMS`,
      `https://github.com/juliopolycarpo/mangostudio/releases/download/v${VERSION}/${ASSET}`,
    ]);
    expect(written.get(`/cache/${VERSION}/${ASSET}`)).toEqual(ARCHIVE);
    const unpack = calls.find((call) => call.script.includes('tar -xzf -'));
    expect(unpack?.stdinBytes).toBe(ARCHIVE.byteLength);
  });

  // A canary hub calls itself `<root>-canary.<sha7>` while its assets live on
  // the rolling `v<root>-canary` tag under rolling names. Splicing the running
  // version into the URL asked GitHub for a tag that has never existed, so
  // hub-driven provisioning could not work on canary at all.
  it('resolves canary assets onto the rolling tag, not the running version', async () => {
    const canaryVersion = '1.2.3-canary.abcdef0';
    const canaryAsset = 'mangostudio-runtime-1.2.3-canary-linux-x64';
    const { provisioner, requested, written } = harness({
      version: canaryVersion,
      checksums: `${DIGEST}  ${canaryAsset}\n`,
    });

    await provisioner.ensure('Ubuntu');

    expect(requested).toEqual([
      'https://github.com/juliopolycarpo/mangostudio/releases/download/v1.2.3-canary/canary-manifest.json',
      'https://github.com/juliopolycarpo/mangostudio/releases/download/v1.2.3-canary/SHA256SUMS',
      `https://github.com/juliopolycarpo/mangostudio/releases/download/v1.2.3-canary/${canaryAsset}`,
    ]);
    // Cached under the hub's own sha-stamped version even though it was fetched
    // from the rolling tag: two canary builds must not share a cache entry.
    expect(written.get(`/cache/${canaryVersion}/${canaryAsset}`)).toEqual(ARCHIVE);
  });

  // Two canary builds resolve one filename on one tag, so the only thing that
  // can tell yesterday's bytes from today's is a checksum fetched now. Serving
  // a stale cache entry against a stale manifest would install the wrong pair.
  it('re-downloads a rolling asset whose cached bytes no longer match the tag', async () => {
    const canaryAsset = 'mangostudio-runtime-1.2.3-canary-linux-x64';
    const { provisioner, requested, written } = harness({
      version: '1.2.3-canary.abcdef0',
      checksums: `${DIGEST}  ${canaryAsset}\n`,
      cached: new TextEncoder().encode('yesterday of the same rolling name'),
    });

    await provisioner.ensure('Ubuntu');

    expect(requested).toEqual([
      'https://github.com/juliopolycarpo/mangostudio/releases/download/v1.2.3-canary/canary-manifest.json',
      'https://github.com/juliopolycarpo/mangostudio/releases/download/v1.2.3-canary/SHA256SUMS',
      `https://github.com/juliopolycarpo/mangostudio/releases/download/v1.2.3-canary/${canaryAsset}`,
    ]);
    expect(written.get(`/cache/1.2.3-canary.abcdef0/${canaryAsset}`)).toEqual(ARCHIVE);
  });

  // The rolling tag is clobbered on every green commit, so a hub can ask for
  // "its" runtime and be handed a newer one whose checksum verifies. Nothing
  // else catches that until the handshake refuses the pair on the machine, so
  // the refusal has to land here — before anything is written to the distro.
  it('refuses a rolling install the canary tag has moved past', async () => {
    const canaryAsset = 'mangostudio-runtime-1.2.3-canary-linux-x64';
    const manifest = JSON.stringify({
      schemaVersion: 1,
      channel: 'canary',
      version: '1.2.3-canary.9999999',
      assetVersion: '1.2.3-canary',
      sourceSha: '9999999999999999999999999999999999999999',
      builtAt: '2026-08-05T00:00:00.000Z',
      pairs: [
        {
          platform: 'linux-x64',
          hub: { asset: 'mangostudio-1.2.3-canary-linux-x64', digest: 'a'.repeat(64) },
          runtime: { asset: canaryAsset, digest: 'b'.repeat(64) },
        },
      ],
    });
    const { provisioner, calls } = harness({
      version: '1.2.3-canary.abcdef0',
      checksums: `${DIGEST}  ${canaryAsset}\n`,
      manifest,
    });

    await expect(provisioner.ensure('Ubuntu')).rejects.toThrow(
      /rolling canary release has moved on/
    );
    expect(calls.some((call) => call.script.includes('cat > '))).toBe(false);
    expect(calls.some((call) => call.script.includes('runtime.json.incoming'))).toBe(false);
  });

  // Rolling releases cut before the manifest existed have none, and turning
  // that into a failure would break the channel to add a check.
  it('still provisions from a rolling tag that publishes no manifest', async () => {
    const canaryAsset = 'mangostudio-runtime-1.2.3-canary-linux-x64';
    const { provisioner, calls } = harness({
      version: '1.2.3-canary.abcdef0',
      checksums: `${DIGEST}  ${canaryAsset}\n`,
      manifest: null,
    });

    await provisioner.ensure('Ubuntu');

    expect(calls.some((call) => call.script.includes('cat > '))).toBe(true);
  });

  // The manifest read that clears `canaryPairRefusal` already named a digest
  // for this platform's raw asset. Trusting it instead of a second SHA256SUMS
  // fetch removes the only remaining window for the tag to move between the
  // check and the download.
  it('binds a rolling raw asset to the digest a validated manifest already named, skipping a second SHA256SUMS fetch', async () => {
    const canaryAsset = 'mangostudio-runtime-1.2.3-canary-linux-x64';
    const manifest = JSON.stringify({
      schemaVersion: 1,
      channel: 'canary',
      version: '1.2.3-canary.abcdef0',
      assetVersion: '1.2.3-canary',
      sourceSha: 'abcdef0abcdef0abcdef0abcdef0abcdef0abcde',
      builtAt: '2026-08-05T00:00:00.000Z',
      pairs: [
        {
          platform: 'linux-x64',
          hub: { asset: 'mangostudio-1.2.3-canary-linux-x64', digest: 'a'.repeat(64) },
          runtime: { asset: canaryAsset, digest: DIGEST },
        },
      ],
    });
    const { provisioner, requested, written } = harness({
      version: '1.2.3-canary.abcdef0',
      manifest,
    });

    await provisioner.ensure('Ubuntu');

    expect(requested).toEqual([
      'https://github.com/juliopolycarpo/mangostudio/releases/download/v1.2.3-canary/canary-manifest.json',
      `https://github.com/juliopolycarpo/mangostudio/releases/download/v1.2.3-canary/${canaryAsset}`,
    ]);
    expect(written.get(`/cache/1.2.3-canary.abcdef0/${canaryAsset}`)).toEqual(ARCHIVE);
  });

  // Simulates the tag moving between the manifest read and the asset download:
  // same asset name, different bytes, still "clean" against a SHA256SUMS this
  // hub never consults for a bound asset. Without the binding, this is the
  // scenario where build B installs under the pair validated for build A.
  it('refuses a rolling raw asset whose bytes do not match the manifest-bound digest', async () => {
    const canaryAsset = 'mangostudio-runtime-1.2.3-canary-linux-x64';
    const manifest = JSON.stringify({
      schemaVersion: 1,
      channel: 'canary',
      version: '1.2.3-canary.abcdef0',
      assetVersion: '1.2.3-canary',
      sourceSha: 'abcdef0abcdef0abcdef0abcdef0abcdef0abcde',
      builtAt: '2026-08-05T00:00:00.000Z',
      pairs: [
        {
          platform: 'linux-x64',
          hub: { asset: 'mangostudio-1.2.3-canary-linux-x64', digest: 'a'.repeat(64) },
          runtime: { asset: canaryAsset, digest: 'b'.repeat(64) },
        },
      ],
    });
    const { provisioner, calls } = harness({
      version: '1.2.3-canary.abcdef0',
      manifest,
      archive: new TextEncoder().encode('a later build under the same rolling name'),
    });

    await expect(provisioner.ensure('Ubuntu')).rejects.toThrow(/does not match the checksum/);
    expect(calls.some((call) => call.script.includes('cat > '))).toBe(false);
    expect(calls.some((call) => call.script.includes('runtime.json.incoming'))).toBe(false);
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

  it('reinstalls rather than fail when the installed binary is wedged', async () => {
    // A damaged or stuck runtime binary times out `--version` rather than
    // exiting, which the real runner reports as a killed command. That must
    // not read as "the distribution could not start" — the slot probe itself
    // still answered fine — it must fail only the version check and fall
    // through to reinstall, the self-healing path this config exists for.
    // Only the pre-install check is wedged; the freshly pushed binary's own
    // post-install verification (also a `--version` call) must still pass.
    let preInstallChecked = false;
    const { provisioner, requested } = harness({
      config: provisionedConfig(VERSION, ARCHIVE),
      respond: (script) => {
        if (!script.includes('--version') || script.includes('uname')) return undefined;
        if (preInstallChecked) return undefined;
        preInstallChecked = true;
        return { stdout: '', stderr: '', exitCode: -1, signal: 'SIGTERM' };
      },
    });

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
      respond: (script) =>
        script.startsWith('printf')
          ? ok('/home/dev\nLinux\nx86_64\nldd (GNU libc) 2.35\n{ truncated')
          : undefined,
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
    // Only the merged slot probe ran; nothing was piped into the distribution.
    expect(calls).toHaveLength(1);
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
      // Only the slot probe runs before the download fails.
      runInDistro: () =>
        Promise.resolve(ok(`${DISTRO_HOME}\nLinux\nx86_64\nldd (GNU libc) 2.35\n`)),
      fetch: ((_input: string | URL): Promise<Response> =>
        Promise.reject(new Error('getaddrinfo ENOTFOUND'))) as typeof fetch,
    });

    // An air-gapped or proxied hub has no other move, so both are spelled out:
    // where the cache expects the asset, and where the binary belongs.
    await expect(provisioner.ensure('Ubuntu')).rejects.toThrow(
      new RegExp(
        `Could not download .*\\. Either download .*/${RAW_ASSET} to /cache/${VERSION}/${RAW_ASSET} ` +
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
    // The prune constant contains `rm -rf "$d"`; the hostile name must never
    // appear inside a script string where the shell would parse it.
    expect(calls.every((call) => !call.script.includes(hostile))).toBe(true);
    expect(calls.every((call) => !call.script.includes('rm -rf /'))).toBe(true);
  });

  // Regression: this provisioner's own `loadAsset` writes into the hub cache
  // but used to never call `pruneRuntimeCache`, so `~/.mango/runtime-cache/`
  // grew one directory per version forever — the exact "stranded bytes"
  // problem the removal feature exists to fix, just on the hub side instead
  // of the distro side. `pruneRuntimeCache` reads/writes the real filesystem
  // (it is shared with the ssh fetch path), so this test uses a real temp
  // directory rather than the harness's mocked cache; `writeCache` itself
  // stays mocked, so the current version's own directory never lands on
  // disk here — pruning older entries down to one survivor is what proves
  // the call happened.
  it('prunes the hub-side download cache after a fresh install', async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), 'mango-wsl-cache-'));
    try {
      await mkdir(join(cacheRoot, '0.9.0'), { recursive: true });
      await mkdir(join(cacheRoot, '0.8.0'), { recursive: true });

      const { provisioner } = harness({ cacheDirOverride: (version) => join(cacheRoot, version) });
      await provisioner.ensure('Ubuntu');

      // Only the most recent stale entry survives as "previous"; the older
      // one is pruned. Left unfixed, both (and every future version) pile up.
      expect(await readdir(cacheRoot)).toEqual(['0.9.0']);
    } finally {
      await rm(cacheRoot, { force: true, recursive: true });
    }
  });

  // Regression: this provisioner keeps its own copy of `loadAsset`, and only the
  // shared one in `runtime-release-fetch` learned to record the digest it
  // verified. Both write into the same `~/.mango/runtime-cache/<version>/` the
  // staged-runtime card reads, so bytes cached by a WSL install arrived with no
  // sidecar — and the card fell back to checking them against whatever
  // SHA256SUMS the rolling tag serves at view time. That reports a mismatch for
  // a perfectly good cached file as soon as the tag moves, which is the exact
  // false alarm the sidecar exists to prevent.
  it('records the verified digest beside a freshly cached asset', async () => {
    const { provisioner, written } = harness();

    await provisioner.ensure('Ubuntu');

    const sidecar = written.get(`/cache/${VERSION}/${RAW_ASSET}.sha256`);
    expect(sidecar).toBeDefined();
    expect(new TextDecoder().decode(sidecar)).toBe(DIGEST);
  });

  // The archive fallback caches a different filename; the sidecar has to follow
  // the bytes that actually landed, not the raw asset that was never written.
  it('records the digest beside the platform archive when the raw asset is unpublished', async () => {
    const { provisioner, written } = harness({ checksums: `${DIGEST}  ${ASSET}\n` });

    await provisioner.ensure('Ubuntu');

    expect(written.has(`/cache/${VERSION}/${RAW_ASSET}.sha256`)).toBe(false);
    expect(new TextDecoder().decode(written.get(`/cache/${VERSION}/${ASSET}.sha256`))).toBe(DIGEST);
  });

  // Caching is a courtesy: a hub that cannot write the asset must not leave a
  // sidecar claiming a digest for a file that is not there. The card treats a
  // readable sidecar as proof of what the cached bytes are.
  it('writes no sidecar when the asset itself could not be cached', async () => {
    const { provisioner, written } = harness({ writeCacheFails: true });

    await provisioner.ensure('Ubuntu');

    expect([...written.keys()]).toEqual([]);
  });

  // Regression: `ensure` had no way to report transfer bytes, so a WSL install
  // streamed two log lines and an exit event — a ~95 MB push across the 9P
  // share into a cold distribution with nothing to show for the wait.
  it('reports transfer progress while pushing bytes into the distro', async () => {
    const { provisioner } = harness();
    const progress: Array<{ written: number; total: number }> = [];

    await provisioner.ensure('Ubuntu', {
      onTransferProgress: (written, total) => progress.push({ written, total }),
    });

    expect(progress.length).toBeGreaterThan(0);
    expect(progress.at(-1)?.written).toBe(ARCHIVE.byteLength);
    expect(progress.every((entry) => entry.total === ARCHIVE.byteLength)).toBe(true);
  });

  it('reports the wsl slot byte size for the removal dialog', async () => {
    const { provisioner } = harness({
      respond: (script) => (script.includes('du -sb') ? ok('123456\n') : undefined),
    });

    await expect(provisioner.slotBytes('Ubuntu')).resolves.toBe(123456);
  });

  it('reports null when the byte-size probe fails', async () => {
    const { provisioner } = harness({
      respond: (script) =>
        script.includes('du -sb')
          ? { stdout: '', stderr: 'no such distro', exitCode: 1 }
          : undefined,
    });

    await expect(provisioner.slotBytes('Ubuntu')).resolves.toBeNull();
  });
});
