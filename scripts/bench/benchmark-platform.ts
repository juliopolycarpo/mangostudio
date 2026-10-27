/** Require the POSIX process-group boundary used by benchmark children.
 * @example assertBenchmarkPlatform(process.platform);
 */
export function assertBenchmarkPlatform(platform: NodeJS.Platform): void {
  if (platform === 'win32')
    throw new Error('benchmark host: expected POSIX process-group containment | received: win32');
}
