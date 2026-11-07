import { expect, it } from 'bun:test';
import { win32 } from 'node:path';

import { protectStaging } from '../../../src/backup/private-staging';

it('establishes an owner-only inheritable Windows ACL before staging', async () => {
  const calls: string[][] = [];
  const windowsDirectory = 'D:\\Windows Installation';
  const system32 = win32.join(windowsDirectory, 'System32');
  function windowsSecurityCommands(argv: string[]) {
    calls.push(argv);
    if (win32.basename(argv[0] ?? '') === 'whoami.exe')
      return Promise.resolve({
        exitCode: 0,
        stdout: '"fixture\\S-1-1-0","S-1-5-21-100-200-300-400"',
      });
    if (win32.basename(argv[0] ?? '') === 'icacls.exe')
      return Promise.resolve({ exitCode: 0, stdout: '' });
    return Promise.reject(new Error('Unexpected security command.'));
  }
  await protectStaging('C:\\private staging', 'win32', windowsSecurityCommands, windowsDirectory);
  expect(calls[0]).toEqual([win32.join(system32, 'whoami.exe'), '/user', '/fo', 'csv', '/nh']);
  expect(calls[1]).toEqual([
    win32.join(system32, 'icacls.exe'),
    'C:\\private staging',
    '/inheritance:r',
    '/grant:r',
    '*S-1-5-21-100-200-300-400:(OI)(CI)F',
  ]);
});

it('refuses unknown identity and failed ACL configuration', async () => {
  const noIdentity = () => Promise.resolve({ exitCode: 1, stdout: '' });
  for (const relative of ['relative', '\\Windows']) {
    await expect(protectStaging('staging', 'win32', noIdentity, relative)).rejects.toThrow(
      'absolute Windows system directory'
    );
  }
  await expect(protectStaging('staging', 'win32', noIdentity)).rejects.toThrow('SID');
  function failedAcl(argv: string[]) {
    return Promise.resolve(
      win32.basename(argv[0] ?? '') === 'whoami.exe'
        ? { exitCode: 0, stdout: '"fixture\\user","S-1-5-21-1"\r\n' }
        : { exitCode: 1, stdout: '' }
    );
  }
  await expect(protectStaging('staging', 'win32', failedAcl)).rejects.toThrow('ACL');
});

it('refuses a CSV account name with a SID shape when the SID field is missing', async () => {
  const missingSid = () => Promise.resolve({ exitCode: 0, stdout: '"fixture\\S-1-1-0",""\r\n' });
  await expect(protectStaging('staging', 'win32', missingSid)).rejects.toThrow('SID');
});
