/**
 * Reading what `wsl.exe` prints.
 *
 * Two traps live here. The first is the encoding: `wsl.exe` writes UTF-16LE,
 * usually without a byte-order mark, so anything that treats its output as
 * UTF-8 sees every character followed by a NUL. Newer builds emit UTF-8 when
 * `WSL_UTF8` is set, so both have to be read.
 *
 * The second is the layout. Column headers are localized and columns are padded
 * to whatever their widest value needs, so neither header text nor byte offsets
 * identify a field. Single spaces are not separators either: a German host
 * reports a running distribution as "Wird ausgeführt". What is stable is that
 * columns are padded apart — a run of spaces separates them, a single space
 * does not — and that the last column is an integer version. Anything else is
 * the header, the "no installed distributions" notice, or whatever a future
 * build decides to print.
 */

import type { WslDistribution } from '@mangostudio/shared/environments';

const COLUMN_GAP = /\s{2,}/;
const WSL_VERSION = /^\d+$/;
const DEFAULT_MARKER = /^\s*\*/;
const LEADING_MARKER = /^\s*\*?\s*/;

export function decodeWslOutput(bytes: Uint8Array): string {
  // Valid UTF-8 never contains a NUL byte, and UTF-16LE of mostly-ASCII text is
  // roughly half NUL — a more reliable signal than a byte-order mark that is
  // usually absent. "utf-16" is the WHATWG label for the little-endian decoder,
  // and either decoder drops a mark when one is there.
  const utf16 = (bytes[0] === 0xff && bytes[1] === 0xfe) || bytes.includes(0);
  return new TextDecoder(utf16 ? 'utf-16' : 'utf-8').decode(bytes);
}

export function parseWslDistributions(output: string): WslDistribution[] {
  const distributions: WslDistribution[] = [];
  for (const line of output.split(/\r?\n/)) {
    const columns = line.replace(LEADING_MARKER, '').trimEnd().split(COLUMN_GAP);
    const version = columns.at(-1) ?? '';
    if (columns.length < 3 || !WSL_VERSION.test(version)) continue;

    const name = columns[0]?.trim() ?? '';
    // Anything between the name and the version is the state, which is one
    // padded column however many words the host's language spends on it.
    const state = columns.slice(1, -1).join(' ').trim();
    if (!name || !state) continue;
    distributions.push({
      name,
      state,
      wslVersion: Number(version),
      default: DEFAULT_MARKER.test(line),
    });
  }
  return distributions;
}
