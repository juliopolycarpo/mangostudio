import { chmod } from 'node:fs/promises';

interface CommandResult {
  exitCode: number;
  stdout: string;
}
type Run = (argv: string[]) => Promise<CommandResult>;

async function runCommand(argv: string[]): Promise<CommandResult> {
  const child = Bun.spawn(argv, { stdout: 'pipe', stderr: 'ignore', timeout: 5000 });
  const stdout = await new Response(child.stdout).text();
  return { exitCode: await child.exited, stdout };
}

/** Apply owner-only permissions before any data enters a new staging directory. */
export async function protectStaging(
  path: string,
  platform = process.platform,
  run: Run = runCommand
): Promise<void> {
  if (platform !== 'win32') {
    await chmod(path, 0o700);
    return;
  }
  const identity = await run(['whoami.exe', '/user', '/fo', 'csv', '/nh']);
  const sid = identity.stdout.match(/\bS-1-(?:\d+-)+\d+\b/u)?.[0];
  if (identity.exitCode !== 0 || !sid)
    throw new Error('Could not determine the current Windows user SID for private backup staging.');
  const permissions = await run([
    'icacls.exe',
    path,
    '/inheritance:r',
    '/grant:r',
    `*${sid}:(OI)(CI)F`,
  ]);
  if (permissions.exitCode !== 0)
    throw new Error('Could not apply a private backup staging ACL. No user data was staged.');
}
