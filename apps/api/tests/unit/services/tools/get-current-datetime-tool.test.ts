import { beforeEach, describe, expect, it } from 'bun:test';
import type { GetCurrentDatetimeResult } from '../../../../src/services/tools/builtin/get-current-datetime';
import { register as registerGetCurrentDatetimeTool } from '../../../../src/services/tools/builtin/get-current-datetime';
import { clearRegistry, executeTool } from '../../../../src/services/tools/registry';
import type { ToolContext } from '../../../../src/services/tools/types';

const TOOL_NAME = 'get_current_datetime';

function context(parameters: Record<string, unknown> = {}): ToolContext {
  return { userId: 'u1', chatId: 'c1', parameters };
}

function run(
  args: Record<string, unknown>,
  parameters?: Record<string, unknown>
): Promise<GetCurrentDatetimeResult> {
  return executeTool(TOOL_NAME, args, context(parameters), {
    enabled: true,
    parameters: parameters ?? {},
  }) as Promise<GetCurrentDatetimeResult>;
}

beforeEach(() => {
  clearRegistry();
  registerGetCurrentDatetimeTool();
});

describe('get_current_datetime registry contract', () => {
  it('uses the requested timezone and locale', async () => {
    const result = await run({ timezone: 'America/Sao_Paulo', locale: 'pt-BR' });

    expect(result.timezone).toBe('America/Sao_Paulo');
    expect(result.locale).toBe('pt-BR');
  });

  it('falls back to the configured defaults when the arguments are absent', async () => {
    const result = await run({}, { timezone: 'Europe/London', locale: 'en-GB' });

    expect(result.timezone).toBe('Europe/London');
    expect(result.locale).toBe('en-GB');
  });

  it('reads an explicit null as absent and falls back to the configured defaults', async () => {
    const result = await run(
      { timezone: null, locale: null },
      { timezone: 'Europe/London', locale: 'en-GB' }
    );

    expect(result.timezone).toBe('Europe/London');
    expect(result.locale).toBe('en-GB');
  });

  it('falls back to UTC when neither an argument nor a setting is available', async () => {
    const result = await run({});

    expect(result.timezone).toBe('UTC');
    expect(result.locale).toBe('en-US');
  });

  for (const [label, value] of [
    ['a number', 42],
    ['a boolean', true],
    ['an object', {}],
  ] as const) {
    it(`rejects ${label} timezone instead of silently answering in UTC`, async () => {
      // Returning UTC here reads to the model as the local time of the zone it
      // named — the same silent wrong answer a dropped grep flag produces.
      await expect(run({ timezone: value })).rejects.toThrow('Field "timezone" must be a string.');
    });

    it(`rejects ${label} locale instead of silently formatting as en-US`, async () => {
      await expect(run({ locale: value })).rejects.toThrow('Field "locale" must be a string.');
    });
  }

  it('still coerces a malformed stored setting rather than failing the call', async () => {
    // Settings are not model output: there is no turn to hand a correctable
    // error to, so a bad stored value degrades to the default.
    const result = await run({}, { timezone: 42, locale: {} });

    expect(result.timezone).toBe('UTC');
    expect(result.locale).toBe('en-US');
  });

  it('reports an unusable timezone rather than formatting against a fallback', async () => {
    await expect(run({ timezone: 'Mars/Olympus_Mons' })).rejects.toThrow(
      'Invalid timezone: "Mars/Olympus_Mons"'
    );
  });
});
