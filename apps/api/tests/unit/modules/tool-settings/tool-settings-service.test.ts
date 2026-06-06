import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { getDb } from '../../../../src/db/database';
import {
  listToolSettingsDescriptors,
  ToolSettingsError,
  updateToolSettingsDescriptor,
} from '../../../../src/modules/tool-settings/application/tool-settings-service';
import { clearRegistry, getAllTools, registerTool } from '../../../../src/services/tools/registry';
import type { RegisteredTool } from '../../../../src/services/tools/types';

const USER_ID = 'user-tool-settings-test';

function snapshotRegistry(): RegisteredTool[] {
  return getAllTools().map((tool) => ({
    definition: { ...tool.definition },
    settings: {
      ...tool.settings,
      parameterDescriptors: [...tool.settings.parameterDescriptors],
    },
    execute: tool.execute,
    buildDefinition: tool.buildDefinition,
  }));
}

function restoreRegistry(snapshot: RegisteredTool[]): void {
  clearRegistry();
  for (const tool of snapshot) {
    registerTool(tool);
  }
}

function registerTestTools(): void {
  registerTool({
    definition: {
      name: 'test_alpha',
      description: 'Alpha tool',
      parameters: { type: 'object', properties: { quality: { type: 'number' } } },
    },
    settings: {
      title: 'Alpha',
      description: 'Alpha tool',
      category: 'system',
      enabledByDefault: true,
      canDisable: true,
      defaultParameters: { quality: 5 },
      parameterDescriptors: [
        { name: 'quality', type: 'number', label: 'Quality', required: false },
      ],
    },
    execute: () => Promise.resolve('alpha'),
  });

  registerTool({
    definition: {
      name: 'test_beta',
      description: 'Beta tool',
      parameters: { type: 'object' },
    },
    settings: {
      title: 'Beta',
      description: 'Beta tool',
      category: 'system',
      enabledByDefault: false,
      canDisable: false,
      defaultParameters: {},
      parameterDescriptors: [],
    },
    execute: () => Promise.resolve('beta'),
  });
}

describe('tool-settings-service', () => {
  let snapshot: RegisteredTool[];

  beforeEach(() => {
    snapshot = snapshotRegistry();
    clearRegistry();
    registerTestTools();
  });

  afterEach(() => {
    restoreRegistry(snapshot);
  });

  describe('listToolSettingsDescriptors', () => {
    it('returns descriptors for all registered tools with defaults when no saved settings', async () => {
      const db = getDb();
      const result = await listToolSettingsDescriptors(db, USER_ID);

      expect(result.tools).toHaveLength(2);

      const alpha = result.tools.find((t) => t.name === 'test_alpha');
      if (!alpha) throw new Error('Expected test_alpha descriptor');
      expect(alpha.enabled).toBe(true);
      expect(alpha.parameters).toEqual({ quality: 5 });

      const beta = result.tools.find((t) => t.name === 'test_beta');
      if (!beta) throw new Error('Expected test_beta descriptor');
      expect(beta.enabled).toBe(false);
    });
  });

  describe('updateToolSettingsDescriptor', () => {
    it('throws ToolSettingsError for unknown tools', () => {
      const db = getDb();
      expect(
        updateToolSettingsDescriptor(db, USER_ID, 'nonexistent', { enabled: true })
      ).rejects.toBeInstanceOf(ToolSettingsError);
    });

    it('throws ToolSettingsError when disabling a non-disableable tool', () => {
      const db = getDb();
      expect(
        updateToolSettingsDescriptor(db, USER_ID, 'test_beta', { enabled: false })
      ).rejects.toBeInstanceOf(ToolSettingsError);
    });

    it('throws ToolSettingsError for invalid parameter values', () => {
      const db = getDb();
      expect(
        updateToolSettingsDescriptor(db, USER_ID, 'test_alpha', {
          parameters: { unknown_param: 'bad' },
        })
      ).rejects.toBeInstanceOf(ToolSettingsError);
    });
  });
});
