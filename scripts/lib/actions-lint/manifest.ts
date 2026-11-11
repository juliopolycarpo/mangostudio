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
      'win32-x64': {
        assetName: 'actionlint_1.7.12_windows_amd64.zip',
        sha256: '6e7241b51e6817ea6a047693d8e6fed13b31819c9a0dd6c5a726e1592d22f6e9',
        binaryPath: 'actionlint.exe',
      },
    },
  },
  zizmor: {
    name: 'zizmor',
    version: '1.29.0',
    baseUrl: 'https://github.com/zizmorcore/zizmor/releases/download/v1.29.0',
    binaryPath: 'zizmor',
    assets: {
      'linux-x64': {
        assetName: 'zizmor-x86_64-unknown-linux-gnu.tar.gz',
        sha256: 'dd96df044a6e8538d5f423790f453bdd03d49e5b2bcc38214acc41a2f1297839',
      },
      'linux-arm64': {
        assetName: 'zizmor-aarch64-unknown-linux-gnu.tar.gz',
        sha256: '415eaa7c0a06479a701b8e44a3e812c1047decc848ec4bede7bd6bbf49f22d20',
      },
      'darwin-x64': {
        assetName: 'zizmor-x86_64-apple-darwin.tar.gz',
        sha256: '648b72ab9941a7f2a8d65d7b68a8e76cef789538c8df3a3950384d38423375b0',
      },
      'darwin-arm64': {
        assetName: 'zizmor-aarch64-apple-darwin.tar.gz',
        sha256: '720322fade9e83a9c7953944c438f2ba942636b86b96a8f0e6b15ce94c8a6b6f',
      },
      'win32-x64': {
        assetName: 'zizmor-x86_64-pc-windows-msvc.zip',
        sha256: '68a6bc6888f10bf0d53658c75885e7c1b7a0588d4c1fbc3f0ca280ad7324bf06',
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
