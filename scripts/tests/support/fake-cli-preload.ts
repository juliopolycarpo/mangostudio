import { afterAll } from 'bun:test';

import { disposeCompiledFakeCli } from './fake-cli';

// A preload hook runs after every test file in the worker has used the cache.
afterAll(disposeCompiledFakeCli);
