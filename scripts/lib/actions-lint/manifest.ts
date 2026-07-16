// Pinned manifest for the workflow static-analysis toolchain. Every binary the
// bootstrap may execute is listed here with its upstream release URL and
// SHA-256, so a version bump is a reviewable one-file diff: update `version`,
// the asset names, and the checksums from the upstream release in one commit
// (actionlint publishes `actionlint_<version>_checksums.txt`; for zizmor and
// ShellCheck hash the downloaded archives with `sha256sum`).

export type ToolName = 'actionlint' | 'zizmor' | 'shellcheck';

export type PlatformKey = 'linux-x64' | 'linux-arm64' | 'darwin-x64' | 'darwin-arm64';

interface ToolAsset {
  /** Release asset file name, appended to the tool's baseUrl. */
  readonly assetName: string;
  /** Hex SHA-256 of the release archive. */
  readonly sha256: string;
}

export interface ToolManifestEntry {
  readonly name: ToolName;
  readonly version: string;
  /** Release download prefix; asset URLs are `${baseUrl}/${assetName}`. */
  readonly baseUrl: string;
  /** Path of the executable inside the extracted archive. */
  readonly binaryPath: string;
  readonly assets: Readonly<Record<PlatformKey, ToolAsset>>;
}

export const TOOL_MANIFEST: Readonly<Record<ToolName, ToolManifestEntry>> = {
  actionlint: {
    name: 'actionlint',
    version: '1.7.12',
    baseUrl: 'https://github.com/rhysd/actionlint/releases/download/v1.7.12',
    binaryPath: 'actionlint',
    assets: {
      'linux-x64': {
        assetName: 'actionlint_1.7.12_linux_amd64.tar.gz',
        sha256: '8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8',
      },
      'linux-arm64': {
        assetName: 'actionlint_1.7.12_linux_arm64.tar.gz',
        sha256: '325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6',
      },
      'darwin-x64': {
        assetName: 'actionlint_1.7.12_darwin_amd64.tar.gz',
        sha256: '5b44c3bc2255115c9b69e30efc0fecdf498fdb63c5d58e17084fd5f16324c644',
      },
      'darwin-arm64': {
        assetName: 'actionlint_1.7.12_darwin_arm64.tar.gz',
        sha256: 'aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f',
      },
    },
  },
  zizmor: {
    name: 'zizmor',
    version: '1.26.1',
    baseUrl: 'https://github.com/zizmorcore/zizmor/releases/download/v1.26.1',
    binaryPath: 'zizmor',
    assets: {
      'linux-x64': {
        assetName: 'zizmor-x86_64-unknown-linux-gnu.tar.gz',
        sha256: '8556289a64e7aaf2400cd516f61a471aa91c5902cc56ad96a82fd12f90c2ef73',
      },
      'linux-arm64': {
        assetName: 'zizmor-aarch64-unknown-linux-gnu.tar.gz',
        sha256: '711f5af366b299128f9a04b1470e37d990b41fbd21f14a1a4148d25004a83762',
      },
      'darwin-x64': {
        assetName: 'zizmor-x86_64-apple-darwin.tar.gz',
        sha256: '2967414a561f8c1264121e8f723c3b5abcf3d1bf7ce5063114df99985dd75801',
      },
      'darwin-arm64': {
        assetName: 'zizmor-aarch64-apple-darwin.tar.gz',
        sha256: '68ab2b37836bbd44f6cfffcc102b9ffffbc20c5d67d84293dafb63bd2775a1da',
      },
    },
  },
  shellcheck: {
    name: 'shellcheck',
    version: '0.11.0',
    baseUrl: 'https://github.com/koalaman/shellcheck/releases/download/v0.11.0',
    binaryPath: 'shellcheck-v0.11.0/shellcheck',
    assets: {
      'linux-x64': {
        assetName: 'shellcheck-v0.11.0.linux.x86_64.tar.gz',
        sha256: 'b7af85e41cc99489dcc21d66c6d5f3685138f06d34651e6d34b42ec6d54fe6f6',
      },
      'linux-arm64': {
        assetName: 'shellcheck-v0.11.0.linux.aarch64.tar.gz',
        sha256: '68a8133197a50beb8803f8d42f9908d1af1c5540d4bb05fdfca8c1fa47decefc',
      },
      'darwin-x64': {
        assetName: 'shellcheck-v0.11.0.darwin.x86_64.tar.gz',
        sha256: 'c2c15e08df0e8fbc374c335b230a7ee958c313fa5714817a59aa59f1aa594f51',
      },
      'darwin-arm64': {
        assetName: 'shellcheck-v0.11.0.darwin.aarch64.tar.gz',
        sha256: '339b930feb1ea764467013cc1f72d09cd6b869ebf1013296ba9055ab2ffbd26f',
      },
    },
  },
};

export const ALL_TOOL_NAMES: readonly ToolName[] = ['actionlint', 'zizmor', 'shellcheck'];

const PLATFORM_KEYS: Readonly<Record<string, PlatformKey>> = {
  'linux:x64': 'linux-x64',
  'linux:arm64': 'linux-arm64',
  'darwin:x64': 'darwin-x64',
  'darwin:arm64': 'darwin-arm64',
};

/**
 * Map a Node platform/arch pair onto a manifest platform key, or throw an
 * actionable message so an unsupported host fails loudly instead of silently
 * skipping workflow analysis.
 */
export function resolvePlatformKey(
  platform: string = process.platform,
  arch: string = process.arch
): PlatformKey {
  const key = PLATFORM_KEYS[`${platform}:${arch}`];
  if (!key) {
    throw new Error(
      `Workflow static analysis has no pinned binaries for ${platform}/${arch}. ` +
        `Add a manifest entry (asset name + SHA-256) for this platform to ` +
        `scripts/lib/actions-lint/manifest.ts, or run \`bun run check\` on ` +
        `linux/macOS x64/arm64 (CI runs it on every pull request).`
    );
  }
  return key;
}

export function toolAssetUrl(entry: ToolManifestEntry, platform: PlatformKey): string {
  return `${entry.baseUrl}/${entry.assets[platform].assetName}`;
}
