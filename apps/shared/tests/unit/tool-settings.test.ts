import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  ToolSettingsDescriptorSchema,
  ToolSettingsListResponseSchema,
  UpdateToolSettingsBodySchema,
} from '../../src/tool-settings';

describe('tool settings contracts', () => {
  it('validates a tool settings descriptor response shape', () => {
    const descriptor = {
      name: 'get_current_datetime',
      title: 'Current date and time',
      description: 'Returns the current date and time.',
      category: 'system',
      enabled: true,
      canDisable: true,
      parameters: { timezone: 'UTC', locale: 'en-US' },
      parameterDescriptors: [
        {
          name: 'timezone',
          label: 'Default timezone',
          type: 'string',
          required: true,
          defaultValue: 'UTC',
        },
      ],
    };

    expect(Value.Check(ToolSettingsDescriptorSchema, descriptor)).toBe(true);
    expect(Value.Check(ToolSettingsListResponseSchema, { tools: [descriptor] })).toBe(true);
  });

  it('rejects invalid update body shapes', () => {
    expect(Value.Check(UpdateToolSettingsBodySchema, { enabled: 'yes' })).toBe(false);
    expect(Value.Check(UpdateToolSettingsBodySchema, { parameters: [] })).toBe(false);
    expect(Value.Check(UpdateToolSettingsBodySchema, { unknown: true })).toBe(false);
  });
});
