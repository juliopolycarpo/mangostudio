import { describe, expect, it } from 'bun:test';

import { laneById, TEST_LANES } from '../../lib/test-lanes';
import { laneComponentRoot, lanesForComponentRoot } from './lane-components';

describe('laneComponentRoot', () => {
  it('rolls the root scripts lane into scripts and workspace lanes into apps/<workspace>', () => {
    expect(laneComponentRoot(laneById('root'))).toBe('scripts');
    expect(laneComponentRoot(laneById('api-unit'))).toBe('apps/api');
    expect(laneComponentRoot(laneById('api-integration'))).toBe('apps/api');
    expect(laneComponentRoot(laneById('frontend'))).toBe('apps/frontend');
  });
});

describe('lanesForComponentRoot', () => {
  it('gives the api component both of its lanes, in registry order', () => {
    expect(lanesForComponentRoot('apps/api').map((lane) => lane.id)).toEqual([
      'api-unit',
      'api-integration',
    ]);
  });

  it('is empty for a component with no lane wired, such as a crate', () => {
    expect(lanesForComponentRoot('crates/mango-protocol')).toEqual([]);
  });

  it('accounts for every registry lane under exactly one component', () => {
    const roots = [...new Set(TEST_LANES.map(laneComponentRoot))];

    const owned = roots.flatMap((root) => lanesForComponentRoot(root).map((lane) => lane.id));

    expect(owned.sort()).toEqual(TEST_LANES.map((lane) => lane.id).sort());
  });
});
