import { describe, expect, it } from 'bun:test';
import { libraryContentPath } from '../../../../src/library/machine/read';

describe('libraryContentPath', () => {
  it.each([
    {
      style: 'posix' as const,
      instancePath: '/tmp/remote-b/skills/gh',
      expected: '/tmp/remote-b/skills/gh/SKILL.md',
    },
    {
      style: 'win32' as const,
      instancePath: 'C:\\Users\\me\\.mango\\skills\\gh',
      expected: 'C:\\Users\\me\\.mango\\skills\\gh\\SKILL.md',
    },
  ])('appends the skill entrypoint in the $style style, whatever the host', (fixture) => {
    const { style, instancePath, expected } = fixture;
    const received = libraryContentPath('skill', instancePath, style);
    expect(received, `expected remote library path: ${expected} | received: ${received}`).toBe(
      expected
    );
  });

  it('keeps a POSIX runtime path free of backslashes on any host', () => {
    // The Windows-hub regression: a host-flavoured join turned this into
    // `\tmp\remote-b\skills\gh\SKILL.md`.
    const received = libraryContentPath('skill', '/tmp/remote-b/skills/gh', 'posix');
    expect(received.includes('\\'), `expected no backslash in: ${received}`).toBe(false);
  });

  it.each(['posix', 'win32'] as const)(
    'returns a non-skill instance path untouched for %s',
    (style) => {
      const instancePath = style === 'win32' ? 'C:\\Users\\me\\AGENTS.md' : '/home/me/AGENTS.md';
      const received = libraryContentPath('instruction', instancePath, style);
      expect(
        received,
        `expected instance path unchanged: ${instancePath} | received: ${received}`
      ).toBe(instancePath);
    }
  );
});
