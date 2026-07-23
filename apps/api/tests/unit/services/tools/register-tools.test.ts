import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { registerTools } from '../../../../src/services/tools/register-tools';
import { clearRegistry, getAllTools, getTool } from '../../../../src/services/tools/registry';
import { expectedToolNames } from '../../../support/registration-expectations';

function registeredToolNames(): string[] {
  return getAllTools()
    .map((tool) => tool.definition.name)
    .sort();
}

function restoreTools(): void {
  clearRegistry();
  registerTools();
}

describe('registerTools', () => {
  beforeEach(() => {
    clearRegistry();
  });

  afterEach(() => {
    restoreTools();
  });

  it('registers all built-in tools available on this host', () => {
    registerTools();

    expect(registeredToolNames()).toEqual(expectedToolNames());
  });

  it('keeps tool registration idempotent', () => {
    registerTools();
    registerTools();

    expect(registeredToolNames()).toEqual(expectedToolNames());
  });

  it('ships file lifecycle tools enabled with configurable path policies', () => {
    registerTools();

    for (const name of ['edit_file', 'replace_range', 'create_file', 'delete_file', 'move_file']) {
      const settings = getTool(name)?.settings;
      expect(settings).toMatchObject({
        enabledByDefault: true,
        canDisable: true,
        defaultParameters: {
          allowedPaths: [],
          deniedPaths: [],
        },
      });
      expect(settings?.parameterDescriptors.map((descriptor) => descriptor.name)).toEqual([
        'allowedPaths',
        'deniedPaths',
      ]);
    }
  });
});
