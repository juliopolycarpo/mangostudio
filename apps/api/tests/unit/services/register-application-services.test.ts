import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  clearRegistry as clearProviders,
  listRegisteredProviderTypes,
} from '../../../src/services/providers/core/provider-registry';
import { registerApplicationServices } from '../../../src/services/register-application-services';
import { clearRegistry as clearTools, getAllTools } from '../../../src/services/tools/registry';
import { expectedProviderTypes, expectedToolNames } from '../../support/registration-expectations';

function resetRegistries(): void {
  clearProviders();
  clearTools();
}

function restoreRegistries(): void {
  resetRegistries();
  registerApplicationServices();
}

describe('registerApplicationServices', () => {
  beforeEach(() => {
    resetRegistries();
  });

  afterEach(() => {
    restoreRegistries();
  });

  it('registers providers and tools from one startup entrypoint', () => {
    registerApplicationServices();

    expect([...listRegisteredProviderTypes()].sort()).toEqual(expectedProviderTypes());
    expect(
      getAllTools()
        .map((tool) => tool.definition.name)
        .sort()
    ).toEqual(expectedToolNames());
  });
});
