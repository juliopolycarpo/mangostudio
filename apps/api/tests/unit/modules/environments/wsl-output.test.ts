import { describe, expect, it } from 'bun:test';
import {
  decodeWslOutput,
  parseWslDistributions,
} from '../../../../src/modules/environments/domain/wsl-output';

/** What `wsl.exe --list --verbose` writes: UTF-16LE, no byte-order mark. */
function utf16le(text: string, options: { bom?: boolean } = {}): Uint8Array {
  const body = options.bom ? `﻿${text}` : text;
  const bytes = new Uint8Array(body.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < body.length; index++) {
    view.setUint16(index * 2, body.charCodeAt(index), true);
  }
  return bytes;
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

const EN_US = [
  '  NAME                   STATE           VERSION',
  '* Ubuntu                 Running         2',
  '  Debian                 Stopped         2',
  '  docker-desktop-data    Stopped         2',
  '',
].join('\r\n');

/** German Windows: localized headers, and a state that is two words. */
const DE_DE = [
  '  NAME              STATUS           VERSION',
  '* Ubuntu-22.04      Wird ausgeführt  2',
  '  openSUSE-Leap-15  Beendet          1',
  '',
].join('\r\n');

describe('decodeWslOutput', () => {
  it('reads UTF-16LE without a byte-order mark', () => {
    expect(decodeWslOutput(utf16le(EN_US))).toBe(EN_US);
  });

  it('strips a byte-order mark when one is present', () => {
    expect(decodeWslOutput(utf16le(EN_US, { bom: true }))).toBe(EN_US);
  });

  it('reads UTF-8, which newer builds emit under WSL_UTF8', () => {
    expect(decodeWslOutput(utf8(DE_DE))).toBe(DE_DE);
  });

  it('reads non-ASCII UTF-16LE, where the first unit has no NUL byte', () => {
    const japanese = '  名前            状態    バージョン\r\n* Ubuntu  Running  2\r\n';
    expect(decodeWslOutput(utf16le(japanese))).toBe(japanese);
  });

  it('returns an empty string for empty output', () => {
    expect(decodeWslOutput(new Uint8Array())).toBe('');
  });
});

describe('parseWslDistributions', () => {
  it('reads names, state, version, and the default marker', () => {
    expect(parseWslDistributions(EN_US)).toEqual([
      { name: 'Ubuntu', state: 'Running', wslVersion: 2, default: true },
      { name: 'Debian', state: 'Stopped', wslVersion: 2, default: false },
      { name: 'docker-desktop-data', state: 'Stopped', wslVersion: 2, default: false },
    ]);
  });

  it('parses a localized capture by structure rather than header text', () => {
    expect(parseWslDistributions(DE_DE)).toEqual([
      { name: 'Ubuntu-22.04', state: 'Wird ausgeführt', wslVersion: 2, default: true },
      { name: 'openSUSE-Leap-15', state: 'Beendet', wslVersion: 1, default: false },
    ]);
  });

  it('keeps spaces inside a distribution name', () => {
    const output = '  NAME        STATE     VERSION\n  My Distro   Stopped   2\n';
    expect(parseWslDistributions(output)).toEqual([
      { name: 'My Distro', state: 'Stopped', wslVersion: 2, default: false },
    ]);
  });

  it('ignores prose that is not a row', () => {
    const output = [
      'Windows Subsystem for Linux has no installed distributions.',
      'Use "wsl.exe --list --online" to list available distributions',
      'and "wsl.exe --install <Distro>" to install.',
      '',
    ].join('\r\n');
    expect(parseWslDistributions(output)).toEqual([]);
  });

  it('returns nothing for empty output', () => {
    expect(parseWslDistributions('')).toEqual([]);
  });
});
