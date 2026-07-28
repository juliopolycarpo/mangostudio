import { describe, expect, it } from 'bun:test';
import { collectLibraryDoctorSection } from '../../../src/cli/library-doctor-checks';

describe('collectLibraryDoctorSection', () => {
  it('reports divergence as an ok hint with the mangostudio binary name', () => {
    const rows = collectLibraryDoctorSection({
      listLocations: () => [
        {
          id: 'mango-skills',
          kind: 'skill',
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
});
