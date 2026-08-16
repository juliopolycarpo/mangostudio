import { describe, expect, it } from 'bun:test';
import {
  clampIntegerSetting,
  getBoundedOptionalInteger,
  getOptionalBoolean,
  getOptionalString,
  getRequiredInteger,
  getRequiredString,
  getRequiredTextArg,
  getStringSetting,
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
  it('reads absent and null alike as "no value"', () => {
    expect(getOptionalBoolean(undefined, 'replaceAll')).toBeUndefined();
    expect(getOptionalBoolean(null, 'replaceAll')).toBeUndefined();
  });

  it('returns booleans unchanged', () => {
    expect(getOptionalBoolean(false, 'replaceAll')).toBe(false);
    expect(getOptionalBoolean(true, 'replaceAll')).toBe(true);
  });

  it('rejects truthy stand-ins instead of coercing them', () => {
    for (const value of ['true', 'false', 1, 0, {}]) {
      expect(() => getOptionalBoolean(value, 'replaceAll')).toThrow(
        'Field "replaceAll" must be a boolean.'
      );
    }
  });
});

describe('getOptionalString', () => {
  it('reads absent and null alike as "no value"', () => {
    expect(getOptionalString(undefined, 'path')).toBeUndefined();
    expect(getOptionalString(null, 'path')).toBeUndefined();
  });

  it('returns the trimmed string value', () => {
    expect(getOptionalString('  hello  ', 'path')).toBe('hello');
  });

  it('reads a blank string as "no value"', () => {
    expect(getOptionalString('   ', 'path')).toBeUndefined();
  });

  it('rejects a non-string instead of reading it as absent', () => {
    for (const value of [42, true, [], {}]) {
      expect(() => getOptionalString(value, 'path')).toThrow('Field "path" must be a string.');
    }
  });
});

describe('getBoundedOptionalInteger', () => {
  const bounds = { min: 1, max: 10 };

  it('reads absent and null alike as "no value"', () => {
    expect(getBoundedOptionalInteger(undefined, 'count', bounds)).toBeUndefined();
    expect(getBoundedOptionalInteger(null, 'count', bounds)).toBeUndefined();
  });

  it('returns an in-range integer unchanged', () => {
    expect(getBoundedOptionalInteger(5, 'count', bounds)).toBe(5);
  });

  it('clamps an out-of-range integer to the nearest bound', () => {
    expect(getBoundedOptionalInteger(0, 'count', bounds)).toBe(1);
    expect(getBoundedOptionalInteger(20, 'count', bounds)).toBe(10);
  });

  it('rejects a fraction rather than rounding it to a value nobody asked for', () => {
    for (const value of [5.7, 2.6, -0.5]) {
      expect(() => getBoundedOptionalInteger(value, 'count', bounds)).toThrow(
        'Field "count" must be an integer.'
      );
    }
  });

  it('rejects non-numbers and non-finite values', () => {
    for (const value of ['abc', '5', true, NaN, Infinity, -Infinity, {}]) {
      expect(() => getBoundedOptionalInteger(value, 'count', bounds)).toThrow(
        'Field "count" must be an integer.'
      );
    }
  });
});

describe('setting readers stay lax where argument readers reject', () => {
  it('coerces a malformed string setting to "unset" rather than failing the call', () => {
    expect(getStringSetting('  gpt-image-1  ')).toBe('gpt-image-1');
    expect(getStringSetting('   ')).toBeUndefined();
    expect(getStringSetting(42)).toBeUndefined();
    expect(getStringSetting(null)).toBeUndefined();
  });

  it('rounds and clamps a numeric setting rather than rejecting it', () => {
    expect(clampIntegerSetting(5.7, 100, 1, 10)).toBe(6);
    expect(clampIntegerSetting('nope', 100, 1, 5000)).toBe(100);
  });
});
