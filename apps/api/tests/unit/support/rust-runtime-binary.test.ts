import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { skipWithoutRustBinary } from '../../support/rust-runtime-binary';

const warn = spyOn(console, 'warn').mockImplementation(() => undefined);

afterEach(() => {
  warn.mockClear();
});

describe('skipWithoutRustBinary', () => {
  it('runs a case when the binary is present, saying nothing', () => {
    expect(skipWithoutRustBinary({ path: '/bin/runtime', available: true }, 'present-suite')).toBe(
      false
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('skips a case when the binary is missing and names the suite and the path once', () => {
    const missing = { path: '/nowhere/mangostudio-runtime', available: false };

    expect(skipWithoutRustBinary(missing, 'missing-suite')).toBe(true);
    expect(skipWithoutRustBinary(missing, 'missing-suite')).toBe(true);

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain('missing-suite');
    expect(message).toContain('/nowhere/mangostudio-runtime');
    expect(message).toContain('cargo build -p mangostudio-runtime --locked');
  });
});
