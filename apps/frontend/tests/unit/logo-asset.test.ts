/**
 * The in-app logo is drawn at most 48 CSS pixels wide (the brand lockup and the
 * not-found page), so a 144 px export covers a 3x display. It used to be the
 * 512 px PWA icon byte for byte: 26 KB downloaded on every first paint, and a
 * second copy of the same bytes in the dist and in the embedded binary beside
 * `public/icon-512.png`. This pins the small export so the icon is not copied
 * back in.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FRONTEND_ROOT = join(import.meta.dir, '../..');
const LOGO_PATH = join(FRONTEND_ROOT, 'src/assets/logo.png');
const PWA_ICON_PATH = join(FRONTEND_ROOT, 'public/icon-512.png');

const MAX_LOGO_EDGE_PX = 144;
const MAX_LOGO_BYTES = 8 * 1024;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Width and height from the IHDR chunk, which always follows the 8-byte signature. */
function pngSize(bytes: Buffer): { width: number; height: number } {
  const signature = [...bytes.subarray(0, 8)];
  if (signature.some((value, index) => value !== PNG_SIGNATURE[index])) {
    throw new Error(`expected a PNG signature | received: ${signature.join(',')}`);
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe('the in-app logo asset', () => {
  const logo = readFileSync(LOGO_PATH);

  it('is a small export, not the 512 px PWA icon', () => {
    const { width, height } = pngSize(logo);
    expect(
      Math.max(width, height),
      `expected logo.png edge <= ${MAX_LOGO_EDGE_PX}px | received: ${width}x${height}`
    ).toBeLessThanOrEqual(MAX_LOGO_EDGE_PX);
    expect(
      logo.byteLength,
      `expected logo.png <= ${MAX_LOGO_BYTES} B | received: ${logo.byteLength} B`
    ).toBeLessThanOrEqual(MAX_LOGO_BYTES);
  });

  it('is not a byte-for-byte copy of public/icon-512.png', () => {
    expect(
      logo.equals(readFileSync(PWA_ICON_PATH)),
      'expected src/assets/logo.png and public/icon-512.png to differ | received: identical bytes'
    ).toBe(false);
  });

  it('stays square, so object-contain draws it undistorted', () => {
    const { width, height } = pngSize(logo);
    expect(width, `expected a square logo | received: ${width}x${height}`).toBe(height);
  });
});
