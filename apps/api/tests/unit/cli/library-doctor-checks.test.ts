import { describe, expect, it } from 'bun:test';
import { collectLibraryDoctorSection } from '../../../src/cli/library-doctor-checks';

describe('collectLibraryDoctorSection', () => {
  it('reports divergence as an ok hint with the mangostudio binary name', async () => {
    const rows = await collectLibraryDoctorSection({
      listStagedRemovals: () => Promise.resolve([]),
      listLocations: () => [
        {
          id: 'mango-skills',
          kind: 'skill',
          scope: 'home',
          path: '/skills',
          access: 'read-write',
          exists: true,
          readable: true,
          writable: true,
          targetIds: ['mangostudio'],
        },
      ],
    });

    const divergence = rows.find((row) => row.label === 'divergence');
    expect(divergence?.status).toBe('ok');
    expect(divergence?.detail).toContain('mangostudio library --divergent');
    expect(divergence?.detail).not.toContain('mango library');
    expect(rows.filter((row) => row.status === 'warn')).toHaveLength(0);
  });

  it('warns about a temp tree an interrupted removal left behind, and says where', async () => {
    const rows = await collectLibraryDoctorSection({
      listLocations: () => [],
      listStagedRemovals: () =>
        Promise.resolve([
          {
            locationId: 'claude-skills',
            path: '/home/test/.claude/skills/.gh.abc123.removing',
            modifiedAtMs: 1,
          },
        ]),
    });

    const leftover = rows.find((row) => row.label === 'claude-skills');
    expect(leftover?.status).toBe('warn');
    expect(leftover?.detail).toContain('.gh.abc123.removing');
    // Never "cleaned up for you": the staged tree is the only in-place copy of
    // whatever the interrupted removal was moving.
    expect(leftover?.detail).toContain('by hand');
  });
});
