import { describe, expect, it } from 'bun:test';
import Value from 'typebox/value';
import {
  WORKSPACE_PANEL_IDS,
  WorkspacePanelIdSchema,
  WorkspacePanelSettingsSchema,
} from '../../src/workspaces';

/**
 * `WORKSPACE_PANEL_IDS` and `WorkspacePanelIdSchema` are two hand-written halves
 * of one list — TypeBox needs the literals spelled out to infer the union, so a
 * new panel means editing both. Nothing in the type system connects them: adding
 * a panel to only the array leaves the schema rejecting a value the rest of the
 * app treats as valid, and adding it to only the schema leaves the settings
 * normalizer refusing to backfill a panel it does not know exists. Both failures
 * are silent, and both surface as "the panel is missing for some users".
 */
describe('workspace panel ids', () => {
  const schemaIds = WorkspacePanelIdSchema.anyOf.map((literal) => literal.const);

  it('lists the same ids in the array and the schema union', () => {
    expect(schemaIds).toEqual([...WORKSPACE_PANEL_IDS]);
  });

  it('accepts every declared id', () => {
    for (const panelId of WORKSPACE_PANEL_IDS) {
      expect(Value.Check(WorkspacePanelIdSchema, panelId)).toBe(true);
    }
  });

  it('rejects an id neither half declares', () => {
    expect(Value.Check(WorkspacePanelIdSchema, 'not-a-panel')).toBe(false);
  });

  /**
   * `maxItems` is derived from the array's length, so a panel added to the
   * schema alone would let a settings blob list every panel and still be
   * rejected for being one item too long.
   */
  it('allows a settings blob that lists every panel', () => {
    const settings = {
      visiblePanelIds: [...WORKSPACE_PANEL_IDS],
      panelOrder: [...WORKSPACE_PANEL_IDS],
      width: 360,
    };

    expect(Value.Check(WorkspacePanelSettingsSchema, settings)).toBe(true);
  });
});
