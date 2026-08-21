/**
 * Installs happy-dom's globals, and does nothing else.
 *
 * This file must not import `@testing-library/react` or anything that reaches
 * it, directly or transitively. Bun runs `[test] preload` entries sequentially
 * but evaluates each file's imports before its body, so a single combined
 * preload would evaluate `@testing-library/dom` before `document` exists on
 * `globalThis` — `screen` then initializes against nothing and every query
 * fails in a way that does not point at the cause.
 */

import { GlobalRegistrator } from '@happy-dom/global-registrator';

GlobalRegistrator.register({ url: 'http://localhost:3001/' });
