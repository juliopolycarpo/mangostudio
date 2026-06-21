import { describe, expect, it } from 'bun:test';
import {
  normalizeToolParameters,
  ToolParameterError,
} from '../../../../src/services/tools/settings-policy';
import type { RegisteredTool } from '../../../../src/services/tools/types';

const tool: RegisteredTool = {
  definition: {
    name: 'test-tool',
    description: 'Tool used by settings policy tests.',
    parameters: {},
  },
  settings: {
    title: 'Test Tool',
    description: 'Tool used by settings policy tests.',
    category: 'system',
    enabledByDefault: true,
    canDisable: true,
    defaultParameters: {
      names: [],
      paths: [],
    },
    parameterDescriptors: [
      {
        name: 'names',
        label: 'Names',
        type: 'string_list',
        required: true,
        defaultValue: [],
      },
      {
        name: 'paths',
        label: 'Paths',
        type: 'path_list',
        required: true,
        defaultValue: [],
      },
    ],
  },
  execute: () => Promise.resolve(null),
};

describe('normalizeToolParameters list values', () => {
  it('normalizes string and path list text values', () => {
    expect(
      normalizeToolParameters(tool, {
        names: ' alpha\n\n beta ',
        paths: ' /tmp\n/var ',
      })
    ).toEqual({
      names: ['alpha', 'beta'],
      paths: [
        { path: '/tmp', enabled: true },
        { path: '/var', enabled: true },
      ],
    });
  });

  it('rejects non-string entries in string list arrays', () => {
    expect(() =>
      normalizeToolParameters(tool, {
        names: ['alpha', 42],
        paths: [],
      })
    ).toThrow(ToolParameterError);
  });

  it('rejects malformed path list entries', () => {
    expect(() =>
      normalizeToolParameters(tool, {
        names: [],
        paths: [{ path: '/tmp', enabled: 'yes' }],
      })
    ).toThrow(ToolParameterError);
  });
});
