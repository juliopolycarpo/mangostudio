import { chmod } from 'node:fs/promises';
import { win32 } from 'node:path';

import { HIDDEN_WINDOW } from '@mangostudio/shared/process';

interface CommandResult {
  exitCode: number;
  stdout: string;
}
type Run = (argv: string[]) => Promise<CommandResult>;

async function runCommand(argv: string[]): Promise<CommandResult> {
  const child = Bun.spawn(argv, {
    stdout: 'pipe',
    stderr: 'ignore',
    timeout: 5000,
    ...HIDDEN_WINDOW,
  });
  const stdout = await new Response(child.stdout).text();
  return { exitCode: await child.exited, stdout };
}

/** Apply owner-only permissions before any data enters a new staging directory. */
export async function protectStaging(
  path: string,
  platform = process.platform,
  run: Run = runCommand,
  windowsDirectory = process.env.SystemRoot || 'C:\\Windows'
): Promise<void> {
  if (platform !== 'win32') {
    await chmod(path, 0o700);
    return;
  }
  if (!win32.isAbsolute(windowsDirectory) || win32.parse(windowsDirectory).root.length < 2) {
    throw new Error('Could not locate the absolute Windows system directory for backup staging.');
  }
  // Git for Windows can put a Unix whoami ahead of the system utility on PATH.
  const system32 = win32.join(windowsDirectory, 'System32');
  const identity = await run([win32.join(system32, 'whoami.exe'), '/user', '/fo', 'csv', '/nh']);
  // The first CSV field is the account name and can itself look like a SID.
  const sid = identity.stdout.trim().match(/^[^\r\n]+, *("?)(S-1-(?:\d+-)+\d+)\1$/u)?.[2];
  if (identity.exitCode !== 0 || !sid)
    throw new Error('Could not determine the current Windows user SID for private backup staging.');
  const permissions = await run([
    win32.join(system32, 'icacls.exe'),
    path,
    '/inheritance:r',
    '/grant:r',
    `*${sid}:(OI)(CI)F`,
  ]);
  if (permissions.exitCode !== 0)
    throw new Error('Could not apply a private backup staging ACL. No user data was staged.');
}
