import { describe, expect, it } from 'bun:test';
import { formatTimestamp } from '../../../src/features/settings/observability/utils';

const TIMESTAMP = 1_700_000_000_000;

describe('Settings timestamp formatting', () => {
  it('uses the selected language and clock convention across locale switches', () => {
    const english = formatTimestamp(TIMESTAMP, 'en');
    const portuguese = formatTimestamp(TIMESTAMP, 'pt-BR');

    expect(english).toMatch(/Nov \d{1,2}, 2023, \d{1,2}:\d{2}\s(AM|PM)/);
    expect(portuguese).toMatch(/\d{1,2} de nov\. de 2023, \d{2}:\d{2}/);
    expect(portuguese).not.toMatch(/AM|PM/);
    expect(formatTimestamp(TIMESTAMP, 'en')).toBe(english);
  });

  it('keeps the viewer timezone when selecting the language', () => {
    const timezone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    const expected = new Intl.DateTimeFormat('pt-BR', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: timezone,
    }).format(TIMESTAMP);

    expect(formatTimestamp(TIMESTAMP, 'pt-BR')).toBe(expected);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 8_640_000_000_000_001])(
    'retains the Intl RangeError for invalid timestamp %s',
    (timestamp) => {
      expect(() => formatTimestamp(timestamp, 'en')).toThrow(RangeError);
      expect(() => formatTimestamp(timestamp, 'pt-BR')).toThrow(RangeError);
    }
  );
});
