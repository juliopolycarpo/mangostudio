import { describe, expect, it } from 'bun:test';
import type { RuntimeInstallation } from '@mangostudio/shared/environments';
import {
  markWingetOwnedNodeInstallations,
  NODE_LTS_WINGET_PACKAGE_ID,
  parseWingetListOutput,
  WINGET_LIST_ARGV,
} from '@mangostudio/shared/environments/detection';

function installation(overrides: Partial<RuntimeInstallation> = {}): RuntimeInstallation {
  return {
    path: 'C:\\Program Files\\nodejs\\node.exe',
    rawPath: 'C:\\Program Files\\nodejs\\node.exe',
    version: 'v24.19.0',
    origin: 'path',
    effective: true,
    pathSource: 'system',
    ...overrides,
  };
}

describe('WINGET_LIST_ARGV', () => {
  it('never prompts for anything a host adapter cannot answer', () => {
    expect(WINGET_LIST_ARGV(NODE_LTS_WINGET_PACKAGE_ID)).toEqual([
      'list',
      '--id',
      'OpenJS.NodeJS.LTS',
      '--exact',
      '--accept-source-agreements',
      '--disable-interactivity',
    ]);
  });
});

describe('parseWingetListOutput', () => {
  // Real captures from a pt-BR Windows host, winget v1.29.290.
  const INSTALLED_STDOUT = [
    'Nome    ID                Versão  Origem',
    '-----------------------------------------',
    'Node.js OpenJS.NodeJS.LTS 24.19.0 winget',
  ].join('\n');
  const NOT_INSTALLED_STDOUT =
    'Nenhum pacote instalado foi encontrado que corresponda aos critérios de entrada.';

  it('reads an installed package at exit 0', () => {
    expect(parseWingetListOutput(INSTALLED_STDOUT, 0, 'OpenJS.NodeJS.LTS')).toBe('owned');
  });

  it('reads "no packages found" (signed exit code) as not-owned', () => {
    expect(parseWingetListOutput(NOT_INSTALLED_STDOUT, -1978335212, 'OpenJS.NodeJS.LTS')).toBe(
      'not-owned'
    );
  });

  it('reads the same "no packages found" exit code in its unsigned DWORD form', () => {
    // GetExitCodeProcess returns the exit code as an unsigned 32-bit value;
    // 2316632084 is -1978335212 reinterpreted that way. Which form a caller
    // sees depends on which layer of the host reads it, so both must resolve
    // to the same verdict.
    expect(parseWingetListOutput(NOT_INSTALLED_STDOUT, 2316632084, 'OpenJS.NodeJS.LTS')).toBe(
      'not-owned'
    );
  });

  it('reads a missing exit code as unknown rather than guessing', () => {
    expect(parseWingetListOutput('', null, 'OpenJS.NodeJS.LTS')).toBe('unknown');
  });

  it('reads exit 0 with no matching row as not-owned', () => {
    const stdout = [
      'Name    Id                Version Source',
      '---',
      'Git     Git.Git 2.47.0 winget',
    ].join('\n');
    expect(parseWingetListOutput(stdout, 0, 'OpenJS.NodeJS.LTS')).toBe('not-owned');
  });

  it('never matches a shorter id against a row for a longer one', () => {
    // A substring match would let `OpenJS.NodeJS.LTS` in the output satisfy a
    // query for `OpenJS.NodeJS` — the exact opposite of the id winget was asked
    // to list.
    expect(parseWingetListOutput(INSTALLED_STDOUT, 0, 'OpenJS.NodeJS')).toBe('not-owned');
  });

  it('reads any other exit code as unknown, not as a negative verdict', () => {
    expect(parseWingetListOutput('winget: command failed', 1, 'OpenJS.NodeJS.LTS')).toBe('unknown');
  });
});

describe('markWingetOwnedNodeInstallations', () => {
  it('marks only the system installation resolved to %ProgramFiles%\\nodejs', () => {
    const installations = [
      installation({ path: 'C:\\Program Files\\nodejs\\node.exe', pathSource: 'system' }),
      installation({
        path: 'C:\\Users\\x\\AppData\\Roaming\\fnm\\aliases\\default\\node.exe',
        pathSource: 'fnm',
      }),
    ];

    const result = markWingetOwnedNodeInstallations(installations, 'C:\\Program Files');

    expect(result[0]?.pathSource).toBe('winget');
    expect(result[1]?.pathSource).toBe('fnm');
  });

  it('leaves a non-system attribution at the same directory alone', () => {
    // nvm-windows can point NVM_SYMLINK at the same Program Files\nodejs
    // directory winget installs into; the scanner's own attribution wins.
    const installations = [
      installation({ path: 'C:\\Program Files\\nodejs\\node.exe', pathSource: 'nvm' }),
    ];

    const result = markWingetOwnedNodeInstallations(installations, 'C:\\Program Files');

    expect(result[0]?.pathSource).toBe('nvm');
  });

  it('matches the directory regardless of case or slash style', () => {
    const installations = [
      installation({ path: 'c:/program files/nodejs/node.exe', pathSource: 'system' }),
    ];

    const result = markWingetOwnedNodeInstallations(installations, 'C:\\Program Files');

    expect(result[0]?.pathSource).toBe('winget');
  });

  it('returns installations unchanged when no Program Files directory is known', () => {
    const installations = [installation()];

    const result = markWingetOwnedNodeInstallations(installations, undefined);

    expect(result).toEqual(installations);
  });
});
