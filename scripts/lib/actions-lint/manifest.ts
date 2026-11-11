// Pinned manifest for the workflow static-analysis toolchain. Every binary the
// bootstrap may execute is listed here with its upstream release URL and
// SHA-256, so a version bump is a reviewable one-file diff: update `version`,
// the asset names, and the checksums from the upstream release in one commit
// (actionlint publishes `actionlint_<version>_checksums.txt`; for zizmor and
// ShellCheck hash the downloaded archives with `sha256sum`).

export type ToolName = 'actionlint' | 'zizmor' | 'shellcheck';

export type PlatformKey = 'linux-x64' | 'linux-arm64' | 'darwin-x64' | 'darwin-arm64' | 'win32-x64';

interface ToolAsset {
  /** Release asset file name, appended to the tool's baseUrl. */
  readonly assetName: string;
  /** Hex SHA-256 of the release archive. */
  readonly sha256: string;
  /** Executable member when this platform differs from the tool's default. */
  readonly binaryPath?: string;
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
    version: '1.17.0',
    baseUrl: 'https://github.com/kjanat/actionlint/releases/download/v1.17.0',
    binaryPath: 'actionlint',
    assets: {
      'linux-x64': {
        assetName: 'actionlint_1.17.0_linux_amd64.tar.gz',
        sha256: '620abd485a12b6ab1125b844a876414e1d5bd2af8a3125b27f82b01d0d9d6e5a',
      },
      'linux-arm64': {
        assetName: 'actionlint_1.17.0_linux_arm64.tar.gz',
        sha256: '9be067d6b6e2f455fd0144850520b4b1114a0a792ca6e003302c939792589345',
      },
      'darwin-x64': {
        assetName: 'actionlint_1.17.0_darwin_amd64.tar.gz',
        sha256: 'e5fa505c0236666f2b1f36a2852db5fad6e186e9125babee017538a4049e3afb',
      },
      'darwin-arm64': {
        assetName: 'actionlint_1.17.0_darwin_arm64.tar.gz',
        sha256: 'f123b7ad57a0fe376dcc85e81b7e04e85eb39219184803fc25f989b255f569b4',
      },
      'win32-x64': {
        assetName: 'actionlint_1.17.0_windows_amd64.zip',
        sha256: '503a7649a97c5afb07aa51703b94066c9f63b5eabc25c55a6860eabd5298d559',
        binaryPath: 'actionlint.exe',
      },
    },
  },
  zizmor: {
    name: 'zizmor',
    version: '1.32.0',
    baseUrl: 'https://github.com/zizmorcore/zizmor/releases/download/v1.32.0',
    binaryPath: 'zizmor',
    assets: {
      'linux-x64': {
        assetName: 'zizmor-x86_64-unknown-linux-gnu.tar.gz',
        sha256: 'bb110cc765eca9cd7efb2e284a956be5974c60027b0970f16397d86208a9957b',
      },
      'linux-arm64': {
        assetName: 'zizmor-aarch64-unknown-linux-gnu.tar.gz',
        sha256: 'cb152b207f815116d7fa1c1ee4614f61578803351395052908095e79adfd9fd0',
      },
      'darwin-x64': {
        assetName: 'zizmor-x86_64-apple-darwin.tar.gz',
        sha256: '6983143c719ada6845a69cc4dd2bacc215f971662fecd8bbd2678388e5ce5969',
      },
      'darwin-arm64': {
        assetName: 'zizmor-aarch64-apple-darwin.tar.gz',
        sha256: '6efed18c4539a663fd3c851a2be9533fd8456c4e646d9416206da059154a0d3c',
      },
      'win32-x64': {
        assetName: 'zizmor-x86_64-pc-windows-msvc.zip',
        sha256: 'd284a16e09d9df4ce2c000357e7b59bd531be093bea5718a1ce225b449b59d49',
        binaryPath: 'zizmor.exe',
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
      'win32-x64': {
        assetName: 'shellcheck-v0.11.0.zip',
        sha256: '8a4e35ab0b331c85d73567b12f2a444df187f483e5079ceffa6bda1faa2e740e',
        binaryPath: 'shellcheck.exe',
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
  'win32:x64': 'win32-x64',
};

/**
 * Map a Node platform/arch pair onto a manifest platform key, or throw an
 * actionable message so an unsupported host fails loudly instead of silently
 * skipping workflow analysis.
 * // Usage: resolvePlatformKey('win32', 'x64')
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
        `Linux/macOS x64/arm64 or Windows x64 (CI runs it on every pull request).`
    );
  }
  return key;
}

export function toolAssetUrl(entry: ToolManifestEntry, platform: PlatformKey): string {
  return `${entry.baseUrl}/${entry.assets[platform].assetName}`;
}
