import { afterAll, beforeAll } from 'bun:test';

import { disposeCompiledFakeCli, prepareFakeCli } from './fake-cli';

// Compiles the Windows launcher once per worker, under its own bound, before
// any test file runs; off Windows it does nothing.
beforeAll(() => {
  prepareFakeCli();
}, 120_000);

// A preload hook runs after every test file in the worker has used the cache.
afterAll(disposeCompiledFakeCli);
