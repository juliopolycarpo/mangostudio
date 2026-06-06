/**
 * Smoke test: verifies that the test preload registered all providers and
 * tools before any test module reached its top-level code.
 *
 * If this fails, the preload likely placed registerApplicationServices()
 * after an async operation — Bun does not block test module loading on
 * preload top-level await.  See AGENTS.md "Preload await gotcha".
 */

import { describe, expect, it } from 'bun:test';
import { listRegisteredProviderTypes } from '../../../src/services/providers/core/provider-registry';
import { getAllTools } from '../../../src/services/tools/registry';
import { expectedProviderTypes, expectedToolNames } from '../../support/registration-expectations';

describe('preload smoke — providers and tools are registered at module-load time', () => {
  it('has every expected provider type registered', () => {
    const registered = [...listRegisteredProviderTypes()].sort();
    expect(registered).toEqual(expectedProviderTypes());
  });

  it('has every expected built-in tool registered', () => {
    const registered = getAllTools()
      .map((t) => t.definition.name)
      .sort();
    expect(registered).toEqual(expectedToolNames());
  });
});
