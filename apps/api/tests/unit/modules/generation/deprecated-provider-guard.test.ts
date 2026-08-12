/**
 * The deprecation guard, at the one place every path to a provider passes.
 *
 * The case that matters is the second one: hiding a provider's catalog entries
 * does not stop it running, because `resolveModel` accepts an explicit stored
 * id whether or not catalog metadata exists for it. A chat already carrying
 * `cursor/composer-2.5` is exactly the input that would otherwise keep reaching
 * the deprecated provider forever, and it arrives with no catalog entry at all.
 */

import { afterEach, describe, expect, mock, test } from 'bun:test';
import { ERROR_CODES } from '@mangostudio/shared/errors';

import type { NoModelAvailableError } from '../../../../src/modules/generation/application/resolve-model';

import {
  getCachedModelMetadata,
  getUnifiedModelCatalog,
} from '../../../../src/services/providers/catalog';
import {
  getProviderObservabilityMetrics,
  resetProviderObservability,
} from '../../../../src/services/providers/core/provider-observability';
import { resolveProviderTypeForModel } from '../../../../src/services/providers/core/provider-registry';

// Captured before any mock.module() call: Bun updates live namespace bindings,
// so restoring from a spread namespace in afterEach would restore the mock.
const realGetCachedModelMetadata = getCachedModelMetadata;
const realGetUnifiedModelCatalog = getUnifiedModelCatalog;
const realResolveProviderTypeForModel = resolveProviderTypeForModel;

const USER_ID = 'user-deprecation-guard';

interface CatalogStub {
  readonly cachedProvider?: 'cursor' | 'openai';
  readonly connectorProvider?: 'cursor' | 'openai';
  readonly textModels?: Array<{ modelId: string; provider: 'openai' }>;
}

async function stubResolution(stub: CatalogStub): Promise<void> {
  await mock.module('../../../../src/services/providers/catalog', () => ({
    getCachedModelMetadata: () =>
      stub.cachedProvider
        ? { providerType: stub.cachedProvider, capabilities: undefined }
        : undefined,
    getUnifiedModelCatalog: () =>
      Promise.resolve({ textModels: stub.textModels ?? [], imageModels: [] }),
  }));
  await mock.module('../../../../src/services/providers/core/provider-registry', () => ({
    resolveProviderTypeForModel: () => Promise.resolve(stub.connectorProvider),
  }));
}

/** Imported per test: the module reads its collaborators at call time. */
function loadResolveModel() {
  return import('../../../../src/modules/generation/application/resolve-model');
}

afterEach(async () => {
  await mock.module('../../../../src/services/providers/catalog', () => ({
    getCachedModelMetadata: realGetCachedModelMetadata,
    getUnifiedModelCatalog: realGetUnifiedModelCatalog,
  }));
  await mock.module('../../../../src/services/providers/core/provider-registry', () => ({
    resolveProviderTypeForModel: realResolveProviderTypeForModel,
  }));
  resetProviderObservability();
});

describe('resolveModel deprecation guard', () => {
  test('refuses a stored cursor model that no catalog entry claims', async () => {
    await stubResolution({ connectorProvider: 'cursor' });
    const { resolveModel, NoModelAvailableError: NoModelAvailable } = await loadResolveModel();

    const error = await resolveModel({
      requestedModel: 'cursor/composer-2.5',
      userId: USER_ID,
      type: 'text',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NoModelAvailable);
    expect((error as NoModelAvailableError).details).toEqual({
      reason: 'provider-deprecated',
      action: 'fork-with-external-runner',
      modelId: 'cursor/composer-2.5',
      provider: 'cursor',
      targetId: 'cursor',
    });
  });

  test('refuses a cursor model the catalog still has metadata for', async () => {
    await stubResolution({ cachedProvider: 'cursor' });
    const { resolveModel, NoModelAvailableError: NoModelAvailable } = await loadResolveModel();

    const error = await resolveModel({
      requestedModel: 'cursor/auto',
      userId: USER_ID,
      type: 'text',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NoModelAvailable);
    expect((error as NoModelAvailableError).details.reason).toBe('provider-deprecated');
  });

  test('records the refusal so a deprecation window is checkable', async () => {
    await stubResolution({ connectorProvider: 'cursor' });
    const { resolveModel } = await loadResolveModel();

    await resolveModel({
      requestedModel: 'cursor/composer-2.5',
      userId: USER_ID,
      type: 'text',
    }).catch(() => undefined);
    await resolveModel({
      requestedModel: 'cursor/auto',
      userId: USER_ID,
      type: 'text',
    }).catch(() => undefined);

    const metrics = getProviderObservabilityMetrics().providers.find(
      (entry) => entry.provider === 'cursor'
    );
    expect(metrics?.deprecatedAttempts?.refusedTurns).toBe(2);
    expect(metrics?.deprecatedAttempts?.lastModelId).toBe('cursor/auto');
    expect(metrics?.deprecatedAttempts?.lastAttemptedAt).toBeGreaterThan(0);
  });

  test('leaves a live provider alone', async () => {
    await stubResolution({ cachedProvider: 'openai' });
    const { resolveModel } = await loadResolveModel();

    const resolved = await resolveModel({
      requestedModel: 'gpt-5.2',
      userId: USER_ID,
      type: 'text',
    });

    expect(resolved.modelId).toBe('gpt-5.2');
    expect(resolved.providerType).toBe('openai');
    expect(
      getProviderObservabilityMetrics().providers.find((entry) => entry.provider === 'cursor')
        ?.deprecatedAttempts
    ).toBeUndefined();
  });

  test('leaves a model no connector claims to the caller that already handles it', async () => {
    await stubResolution({});
    const { resolveModel } = await loadResolveModel();

    // Not the guard's problem: an unroutable id fails later, where it always
    // did. Refusing it here would report a deprecation that did not happen.
    const resolved = await resolveModel({
      requestedModel: 'some-unknown-model',
      userId: USER_ID,
      type: 'text',
    });

    expect(resolved.modelId).toBe('some-unknown-model');
    expect(resolved.providerType).toBeUndefined();
  });

  test('still reports a plain missing-model failure as not-configured', async () => {
    await stubResolution({});
    const { resolveModel, NoModelAvailableError: NoModelAvailable } = await loadResolveModel();

    const error = await resolveModel({ userId: USER_ID, type: 'text' }).catch(
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(NoModelAvailable);
    expect((error as NoModelAvailableError).details).toEqual({
      reason: 'not-configured',
      action: 'configure-connector',
    });
  });
});

describe('modelUnavailableResponse', () => {
  test('carries the reason and the action the client renders', async () => {
    await stubResolution({ connectorProvider: 'cursor' });
    const { resolveModel } = await loadResolveModel();
    const { modelUnavailableResponse } = await import(
      '../../../../src/modules/generation/http/model-unavailable-response'
    );

    const error = await resolveModel({
      requestedModel: 'cursor/composer-2.5',
      userId: USER_ID,
      type: 'text',
    }).catch((caught: unknown) => caught);

    const refusal = modelUnavailableResponse(error as NoModelAvailableError);
    expect(refusal.status).toBe(503);
    expect(refusal.body.code).toBe(ERROR_CODES.MODEL_PROVIDER_DEPRECATED);
    expect(refusal.body.details).toMatchObject({
      reason: 'provider-deprecated',
      action: 'fork-with-external-runner',
      targetId: 'cursor',
    });
  });
});
