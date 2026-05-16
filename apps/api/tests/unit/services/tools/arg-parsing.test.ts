import { describe, expect, it } from 'bun:test';
import {
  getBoundedOptionalInteger,
  getOptionalString,
  getRequiredString,
} from '../../../../src/services/tools/arg-parsing';

describe('getRequiredString', () => {
  it('returns the trimmed string value', () => {
    expect(getRequiredString('  hello  ', 'field')).toBe('hello');
  });

  it('throws for an empty string', () => {
    expect(() => getRequiredString('   ', 'field')).toThrow('Missing required field "field"');
  });

  it('throws for a non-string value', () => {
    expect(() => getRequiredString(42, 'field')).toThrow('Missing required field "field"');
  });

  it('throws for null', () => {
    expect(() => getRequiredString(null, 'field')).toThrow('Missing required field "field"');
  });

  it('throws for undefined', () => {
    expect(() => getRequiredString(undefined, 'field')).toThrow('Missing required field "field"');
  });
});

describe('getOptionalString', () => {
  it('returns the trimmed string value', () => {
    expect(getOptionalString('  hello  ')).toBe('hello');
  });

  it('returns undefined for an empty string', () => {
    expect(getOptionalString('   ')).toBeUndefined();
  });

  it('returns undefined for a non-string value', () => {
    expect(getOptionalString(42)).toBeUndefined();
  });

  it('returns undefined for null', () => {
    expect(getOptionalString(null)).toBeUndefined();
  });

  it('returns undefined for undefined', () => {
    expect(getOptionalString(undefined)).toBeUndefined();
  });
});

describe('getBoundedOptionalInteger', () => {
  const bounds = { min: 1, max: 10 };

  it('returns undefined when value is undefined', () => {
    expect(getBoundedOptionalInteger(undefined, 'count', bounds)).toBeUndefined();
  });

  it('throws when value is not a number', () => {
    expect(() => getBoundedOptionalInteger('abc', 'count', bounds)).toThrow(
      'Field "count" must be a finite number.'
    );
  });

  it('throws when value is NaN', () => {
    expect(() => getBoundedOptionalInteger(NaN, 'count', bounds)).toThrow(
      'Field "count" must be a finite number.'
    );
  });

  it('throws when value is Infinity', () => {
    expect(() => getBoundedOptionalInteger(Infinity, 'count', bounds)).toThrow(
      'Field "count" must be a finite number.'
    );
  });

  it('returns the value clamped to min', () => {
    expect(getBoundedOptionalInteger(0, 'count', bounds)).toBe(1);
  });

  it('returns the value clamped to max', () => {
    expect(getBoundedOptionalInteger(20, 'count', bounds)).toBe(10);
  });

  it('returns the value as-is when within bounds', () => {
    expect(getBoundedOptionalInteger(5, 'count', bounds)).toBe(5);
  });

  it('rounds float values before clamping', () => {
    expect(getBoundedOptionalInteger(5.7, 'count', bounds)).toBe(6);
  });
});
