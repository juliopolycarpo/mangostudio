import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { registerTools } from '../../../../src/services/tools/register-tools';
import { clearRegistry, getAllTools } from '../../../../src/services/tools/registry';
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
});
