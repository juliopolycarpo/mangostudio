import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  embeddedInstaller,
  embeddedInstallerFileName,
} from '../../../../src/modules/updates/infrastructure/embedded-installers';

const SCRIPTS_DIR = join(import.meta.dir, '..', '..', '..', '..', '..', '..', 'scripts', 'install');

describe('embedded installers', () => {
  test('embed the install scripts byte for byte', () => {
    expect(embeddedInstaller('sh')).toBe(readFileSync(join(SCRIPTS_DIR, 'install.sh'), 'utf8'));
    expect(embeddedInstaller('ps1')).toBe(readFileSync(join(SCRIPTS_DIR, 'install.ps1'), 'utf8'));
  });

  test('name the file the shell expects', () => {
    expect(embeddedInstallerFileName('sh')).toBe('install.sh');
    expect(embeddedInstallerFileName('ps1')).toBe('install.ps1');
  });
});
