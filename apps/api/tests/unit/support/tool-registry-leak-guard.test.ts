import { describe, expect, it } from 'bun:test';

import { clearRegistry, getAllTools, registerTool } from '../../../src/services/tools/registry';
import type { RegisteredTool } from '../../../src/services/tools/types';
import { expectedToolNames } from '../../support/registration-expectations';
import {
  captureToolRegistryBaseline,
  restoreToolRegistryBaseline,
} from '../../support/setup/tool-registry-baseline';

function registeredToolNames(): string[] {
  return getAllTools()
    .map((tool) => tool.definition.name)
    .sort();
}

function createStubTool(name: string): RegisteredTool {
  return {
    definition: { name, description: 'A stand-in registered by a test', parameters: {} },
    settings: {
      title: name,
      description: 'A stand-in registered by a test',
      category: 'system',
      enabledByDefault: true,
      canDisable: true,
      defaultParameters: {},
      parameterDescriptors: [],
    },
    execute: () => Promise.resolve({ ok: true }),
  };
}

/**
 * Two tests in one file, in order: the first leaves the registry empty the way
 * a suite with a `clearRegistry()` and no restore does, the second is the next
 * file's test. Bun runs a file's tests in declaration order, so the global
 * `afterEach` the preload installs is the only thing between them.
 */
describe('tool registry leak guard (per-test restore)', () => {
  it('leaks an emptied registry out of the test (setup for the next one)', () => {
    clearRegistry();
    registerTool(createStubTool('leaked_stub_tool'));
    expect(registeredToolNames()).toEqual(['leaked_stub_tool']);
  });

  it('starts the next test with every built-in tool registered and no stub left behind', () => {
    // Exact list: an emptied registry and a stray stub both show in the diff.
    expect(registeredToolNames()).toEqual(expectedToolNames());
  });
});

describe('restoreToolRegistryBaseline', () => {
  it('re-registers the captured tools and drops anything else', () => {
    const baseline = captureToolRegistryBaseline();
    clearRegistry();
    registerTool(createStubTool('extra_stub_tool'));

    restoreToolRegistryBaseline(baseline);

    expect(registeredToolNames()).toEqual(baseline.map((tool) => tool.definition.name).sort());
  });

  it('puts the original object back when a test replaced a tool under the same name', () => {
    const baseline = captureToolRegistryBaseline();
    const original = baseline.find((tool) => tool.definition.name === 'generate_image');
    expect(original).toBeDefined();
    registerTool(createStubTool('generate_image'));

    restoreToolRegistryBaseline(baseline);

    expect(getAllTools().find((tool) => tool.definition.name === 'generate_image')).toBe(original);
  });
});
