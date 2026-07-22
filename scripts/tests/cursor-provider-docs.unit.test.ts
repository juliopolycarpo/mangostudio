import { describe, expect, test } from 'bun:test';

import { readText } from './support/read-text';

const CURSOR_DOC = 'docs/providers/cursor.md';
const README = 'README.md';

describe('cursor provider docs', () => {
  test('cursor.md rejects stale in-process model discovery claims', () => {
    const doc = readText(CURSOR_DOC);

    expect(doc).not.toMatch(/runs in-process on the Bun API/i);
    expect(doc).not.toMatch(/does \*\*not\*\* implement `generateAgentTurnStream`/);
    expect(doc).not.toMatch(/does \*\*not\*\* expose `tools: true`/);
  });

  test('cursor.md documents current sidecar and agent-turn architecture', () => {
    const doc = readText(CURSOR_DOC);

    expect(doc).toMatch(/list_models|validate_api_key/);
    expect(doc).toMatch(/generateAgentTurnStream/);
    expect(doc).toMatch(/services\/providers\/cursor\/sidecar/);
    expect(doc).toMatch(/tools: true/);
    expect(doc).toMatch(/internalAgentTools: true/);
  });

  test('README links to the canonical Cursor provider doc', () => {
    const readme = readText(README);
    expect(readme).toContain('docs/providers/cursor.md');
  });
});
