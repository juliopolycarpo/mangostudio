import { describe, expect, test } from 'bun:test';

import { readText } from './support/read-text';

const CURSOR_DOC = 'docs/providers/cursor.md';
const README = 'README.md';

describe('cursor provider docs', () => {
  test('cursor.md documents Cursor as external-only', () => {
    const doc = readText(CURSOR_DOC);

    expect(doc).toMatch(/Cursor is external-only/i);
    expect(doc).toMatch(/MODEL_PROVIDER_DEPRECATED/);
    expect(doc).toMatch(/provider-deprecated/);
    // The migration is a fork, never an in-place switch — the one claim in this
    // doc a reader would act on, and the one D14 exists to protect.
    expect(doc).toMatch(/forks/i);
  });

  test('cursor.md carries no stale sidecar or SDK instructions', () => {
    const doc = readText(CURSOR_DOC);

    // The removal list names these deliberately. What must not survive is the
    // imperative form — telling a reader to install Node or run the sidecar.
    expect(doc).not.toMatch(/install Node\.js for Cursor/i);
    expect(doc).not.toMatch(/generateAgentTurnStream/);
    expect(doc).toMatch(/Generic Node\.js support is unaffected/i);
  });

  test('README links to the canonical Cursor provider doc', () => {
    const readme = readText(README);
    expect(readme).toContain('docs/providers/cursor.md');
  });
});
