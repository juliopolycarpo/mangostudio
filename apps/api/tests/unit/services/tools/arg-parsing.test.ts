import { describe, expect, it } from 'bun:test';
import {
  getBoundedOptionalInteger,
  getOptionalBoolean,
  getOptionalString,
  getRequiredInteger,
  getRequiredString,
  getRequiredTextArg,
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

describe('getRequiredTextArg', () => {
  it('returns payload text verbatim, including whitespace and empty strings', () => {
    expect(getRequiredTextArg('  line\n', 'content')).toBe('  line\n');
    expect(getRequiredTextArg('', 'content')).toBe('');
  });

  it('distinguishes an absent field from a wrongly typed one', () => {
    expect(() => getRequiredTextArg(undefined, 'content')).toThrow(
      'Missing required field "content".'
    );
    expect(() => getRequiredTextArg(42, 'content')).toThrow('Field "content" must be a string.');
    expect(() => getRequiredTextArg(null, 'content')).toThrow('Field "content" must be a string.');
  });
});

describe('getRequiredInteger', () => {
  it('returns integer values unchanged, including zero and negatives', () => {
    expect(getRequiredInteger(0, 'startLine')).toBe(0);
    expect(getRequiredInteger(-3, 'startLine')).toBe(-3);
  });

  it('rejects fractions, non-numbers, and non-finite values', () => {
    for (const value of [1.5, '1', undefined, null, NaN, Infinity]) {
      expect(() => getRequiredInteger(value, 'startLine')).toThrow(
        'Field "startLine" must be an integer.'
      );
    }
  });
});

describe('getOptionalBoolean', () => {
  it('returns undefined only when the field is absent', () => {
    expect(getOptionalBoolean(undefined, 'replaceAll')).toBeUndefined();
    expect(getOptionalBoolean(false, 'replaceAll')).toBe(false);
    expect(getOptionalBoolean(true, 'replaceAll')).toBe(true);
  });

  it('rejects truthy stand-ins instead of coercing them', () => {
    for (const value of ['true', 1, null]) {
      expect(() => getOptionalBoolean(value, 'replaceAll')).toThrow(
        'Field "replaceAll" must be a boolean.'
      );
    }
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
