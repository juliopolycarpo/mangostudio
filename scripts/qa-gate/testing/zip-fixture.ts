// Builds in-memory zip archives shaped like the ones `actions/upload-artifact`
// produces, so the publisher's archive reader can be tested without a zip binary.

import { deflateRawSync } from 'node:zlib';

export interface ZipEntry {
  readonly name: string;
  readonly content: string;
  /** `deflate` (default) matches upload-artifact; `stored` exercises method 0. */
  readonly method?: 'deflate' | 'stored';
  /** Zero the local-header sizes and set bit 3, as streaming zippers do. */
  readonly dataDescriptor?: boolean;
  /** Override the compression method field with an unsupported value. */
  readonly rawMethod?: number;
  /** Understate the uncompressed size in the directory, as a zip bomb would. */
  readonly declaredSize?: number;
}

const u16 = (value: number): number[] => [value & 0xff, (value >>> 8) & 0xff];
const u32 = (value: number): number[] => [...u16(value & 0xffff), ...u16(value >>> 16)];

const localHeader = (
  entry: ZipEntry,
  name: Uint8Array,
  sizes: { compressed: number; raw: number },
  method: number
): number[] => [
  ...u32(0x04034b50),
  ...u16(20),
  ...u16(entry.dataDescriptor ? 0x08 : 0),
  ...u16(method),
  ...u32(0),
  ...u32(0),
  ...u32(entry.dataDescriptor ? 0 : sizes.compressed),
  ...u32(entry.dataDescriptor ? 0 : sizes.raw),
  ...u16(name.length),
  ...u16(0),
];

const centralHeader = (
  entry: ZipEntry,
  name: Uint8Array,
  sizes: { compressed: number; raw: number },
  method: number,
  localOffset: number
): number[] => [
  ...u32(0x02014b50),
  ...u16(20),
  ...u16(20),
  ...u16(entry.dataDescriptor ? 0x08 : 0),
  ...u16(method),
  ...u32(0),
  ...u32(0),
  ...u32(sizes.compressed),
  ...u32(sizes.raw),
  ...u16(name.length),
  ...u16(0),
  ...u16(0),
  ...u16(0),
  ...u16(0),
  ...u32(0),
  ...u32(localOffset),
];

/**
 * Assemble a zip archive from entries. Sizes and offsets are exact; CRCs are
 * zero because the reader under test never verifies them.
 *
 * // Usage: buildZip([{ name: 'metrics.json', content: '{}' }])
 */
export const buildZip = (entries: readonly ZipEntry[]): Uint8Array => {
  const encoder = new TextEncoder();
  const body: number[] = [];
  const central: number[] = [];

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const raw = encoder.encode(entry.content);
    const stored = entry.method === 'stored';
    const data = stored ? raw : new Uint8Array(deflateRawSync(raw));
    const method = entry.rawMethod ?? (stored ? 0 : 8);
    const sizes = { compressed: data.length, raw: entry.declaredSize ?? raw.length };
    central.push(...centralHeader(entry, name, sizes, method, body.length), ...name);
    body.push(...localHeader(entry, name, sizes, method), ...name, ...data);
  }

  const end = [
    ...u32(0x06054b50),
    ...u16(0),
    ...u16(0),
    ...u16(entries.length),
    ...u16(entries.length),
    ...u32(central.length),
    ...u32(body.length),
    ...u16(0),
  ];
  return new Uint8Array([...body, ...central, ...end]);
};
