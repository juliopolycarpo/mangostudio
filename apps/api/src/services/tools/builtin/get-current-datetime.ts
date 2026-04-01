/**
 * Built-in tool: get_current_datetime
 * Returns the current date and time in the requested timezone and locale.
 */

import { registerTool } from '../registry';
import type { ToolContext } from '../types';

export interface GetCurrentDatetimeArgs {
  /** IANA timezone name (e.g. "America/Sao_Paulo"). Defaults to "UTC". */
  timezone?: string;
  /** BCP 47 locale tag (e.g. "pt-BR"). Defaults to "en-US". */
  locale?: string;
}

export interface GetCurrentDatetimeResult {
  isoUtc: string;
  unixMs: number;
  timezone: string;
  locale: string;
  localDateTime: string;
  offset: string;
}

const definition = {
  name: 'get_current_datetime',
  description:
    'Returns the current date and time. Use this whenever the user asks about the current time, date, day of the week, or any time-sensitive information.',
  parameters: {
    type: 'object',
    properties: {
      timezone: {
        type: 'string',
        description:
          'IANA timezone name (e.g. "America/Sao_Paulo", "Europe/London"). Defaults to "UTC".',
      },
      locale: {
        type: 'string',
        description:
          'BCP 47 locale tag for output formatting (e.g. "pt-BR", "en-US"). Defaults to "en-US".',
      },
    },
    additionalProperties: false,
  },
};

async function execute(
  args: Record<string, unknown>,
  _context: ToolContext
): Promise<GetCurrentDatetimeResult> {
  const timezone = typeof args.timezone === 'string' ? args.timezone : 'UTC';
  const locale = typeof args.locale === 'string' ? args.locale : 'en-US';

  // Validate timezone by constructing a formatter — throws RangeError on invalid input
  try {
    new Intl.DateTimeFormat(locale, { timeZone: timezone });
  } catch {
    throw new Error(`Invalid timezone: "${timezone}"`);
  }

  const now = new Date();
  const unixMs = now.getTime();
  const isoUtc = now.toISOString();

  const localFormatter = new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const localDateTime = localFormatter.format(now);

  // Extract short UTC offset (e.g. "GMT-3")
  const offsetFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    timeZoneName: 'shortOffset',
  });
  const parts = offsetFormatter.formatToParts(now);
  const offset = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'UTC';

  return { isoUtc, unixMs, timezone, locale, localDateTime, offset };
}

// Self-register on import
registerTool({ definition, execute });
