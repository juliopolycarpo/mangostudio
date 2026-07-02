export type CursorNativePackagePlatform =
  | 'linux-x64'
  | 'linux-x64-musl'
  | 'linux-arm64'
  | 'linux-arm64-musl'
  | 'windows-x64'
  | 'windows-arm64'
  | 'darwin-x64'
  | 'darwin-arm64';

export const CURSOR_SDK_CHUNK_FILE_PATTERN = /^\d+\.js$/;

/**
 * Maps each release target to the native Cursor SDK package that carries the
 * platform runtime. `null` means Cursor does not publish a native runtime for
 * that target, so MangoStudio must not ship a broken sidecar there.
 */
export const CURSOR_NATIVE_PACKAGES = {
  'linux-x64': '@cursor/sdk-linux-x64',
  'linux-x64-musl': null,
  'linux-arm64': '@cursor/sdk-linux-arm64',
  'linux-arm64-musl': null,
  'windows-x64': '@cursor/sdk-win32-x64',
  'windows-arm64': null,
  'darwin-x64': '@cursor/sdk-darwin-x64',
  'darwin-arm64': '@cursor/sdk-darwin-arm64',
} as const satisfies Readonly<Record<CursorNativePackagePlatform, string | null>>;

export function cursorNativePackageForPlatform(
  platform: CursorNativePackagePlatform
): string | null {
  return CURSOR_NATIVE_PACKAGES[platform];
}

export function cursorNativePackageForNodeRuntime(platform: string, arch: string): string | null {
  if (platform === 'linux' && arch === 'x64') return CURSOR_NATIVE_PACKAGES['linux-x64'];
  if (platform === 'linux' && arch === 'arm64') return CURSOR_NATIVE_PACKAGES['linux-arm64'];
  if (platform === 'darwin' && arch === 'x64') return CURSOR_NATIVE_PACKAGES['darwin-x64'];
  if (platform === 'darwin' && arch === 'arm64') return CURSOR_NATIVE_PACKAGES['darwin-arm64'];
  if (platform === 'win32' && arch === 'x64') return CURSOR_NATIVE_PACKAGES['windows-x64'];
  return null;
}

export function isCursorSdkChunkFileName(fileName: string): boolean {
  return CURSOR_SDK_CHUNK_FILE_PATTERN.test(fileName);
}
