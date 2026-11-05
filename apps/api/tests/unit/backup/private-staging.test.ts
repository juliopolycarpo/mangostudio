import { expect, it } from 'bun:test';

import { protectStaging } from '../../../src/backup/private-staging';

it('establishes an owner-only inheritable Windows ACL before staging', async () => {
  const calls: string[][] = [];
  function windowsSecurityCommands(argv: string[]) {
    calls.push(argv);
    if (argv[0] === 'whoami.exe')
      return Promise.resolve({ exitCode: 0, stdout: '"fixture\\user","S-1-5-21-100-200-300-400"' });
    if (argv[0] === 'icacls.exe') return Promise.resolve({ exitCode: 0, stdout: '' });
    return Promise.reject(new Error('Unexpected security command.'));
  }
  await protectStaging('C:\\private staging', 'win32', windowsSecurityCommands);
  expect(calls[1]).toEqual([
    'icacls.exe',
    'C:\\private staging',
    '/inheritance:r',
    '/grant:r',
    '*S-1-5-21-100-200-300-400:(OI)(CI)F',
  ]);
});

it('refuses unknown identity and failed ACL configuration', async () => {
  const noIdentity = () => Promise.resolve({ exitCode: 1, stdout: '' });
  await expect(protectStaging('staging', 'win32', noIdentity)).rejects.toThrow('SID');
  function failedAcl(argv: string[]) {
    return Promise.resolve(
      argv[0] === 'whoami.exe' ? { exitCode: 0, stdout: 'S-1-5-21-1' } : { exitCode: 1, stdout: '' }
    );
  }
  await expect(protectStaging('staging', 'win32', failedAcl)).rejects.toThrow('ACL');
});
