/**
 * Restore for the `@google/genai` module mock.
 *
 * `mock.restore()` does not revert `mock.module()`, so a suite that fakes the
 * Gemini SDK leaves that fake installed for every file after it in the
 * unisolated `api-integration` lane. Undoing it means re-registering the real
 * namespace, which only works if "the real namespace" was captured before any
 * test replaced it.
 *
 * ## Why the capture is here and not in the bunfig preload
 *
 * The preload is the one point that provably precedes every test module, so it
 * looks like the natural home. It is not: importing `@google/genai` from the
 * preload puts it in the preload's own module graph, and the first
 * `mock.module('@google/genai', …)` then re-evaluates that graph —
 * `test-environment.ts` included, which yields a second, uninitialized copy of
 * the bootstrap. Measured on Bun 1.4.0: with the preload importing this module,
 * `--randomize --seed=1` over `tests/integration` went from 36 failures to 605,
 * most of them `createAuthenticatedApiTestApp was called before the API test
 * environment was initialized`.
 *
 * So the capture happens at *this module's* load instead, and the invariant is
 * held by where it is imported from: **import it from a support module that
 * test files import at module scope** (`tests/support/connectors/index.ts`
 * does), never lazily from inside a hook or a test. Module evaluation of a test
 * file precedes every hook in it, so the capture always runs before the first
 * `mock.module` call — in any file order, in any isolation mode.
 */

import { mock } from 'bun:test';
import * as googleGenAI from '@google/genai';

// The whole namespace, not a hand-listed subset: mock.module() on an already
// loaded module *merges*, so restoring only the exports a fake happened to
// name would leave the rest of that fake in place.
const realGoogleGenAI = { ...googleGenAI };

/**
 * Re-registers the real `@google/genai` exports, undoing any `mock.module()`
 * override a test installed. // Usage: afterEach(restoreGoogleGenAI)
 */
export async function restoreGoogleGenAI(): Promise<void> {
  await mock.module('@google/genai', () => realGoogleGenAI);
}
