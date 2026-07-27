import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentProfile } from '@mangostudio/shared/agents';
import {
  AgentProfileDbAdapterError,
  type AgentProfileDbStore,
  parseAgentProfileRendering,
  readAgentProfileRendering,
  serializeAgentProfileRendering,
  writeAgentProfileRendering,
} from '../../../../../src/modules/library/application/adapters/agent-profile-db';

const profile: AgentProfile = {
  id: 'user:reviewer',
  name: 'Reviewer',
  description: 'Reviews diffs.',
  kind: 'user',
  role: 'both',
  source: { type: 'markdown' },
  systemPrompt: 'Review carefully.',
  model: 'gpt-test',
  toolNames: ['read_file', 'list_directory'],
  toolsEnabled: true,
  subagentIds: ['user:researcher'],
  metadata: { zeta: 'last', alpha: true },
};

describe('virtual agent profile database adapter', () => {
  it('matches the golden rendering and is byte-stable across a parse cycle', () => {
    const fixture = readFileSync(
      join(import.meta.dir, '__fixtures__/agent-profile.golden.md'),
      'utf8'
    );
    const rendered = serializeAgentProfileRendering(profile);

    expect(rendered).toBe(fixture);
    expect(serializeAgentProfileRendering(parseAgentProfileRendering(rendered, profile.id))).toBe(
      fixture
    );
  });

  it('hashes the stable rendering rather than storage JSON', async () => {
    const store = storeWith(profile);
    const rendered = await readAgentProfileRendering(store, 'user-1', profile.id);

    expect(rendered.content).toBe(serializeAgentProfileRendering(profile));
    expect(rendered.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('throws a typed error and never upserts invalid Markdown', () => {
    let upserts = 0;
    const store: AgentProfileDbStore = {
      read: () => Promise.resolve(undefined),
      upsert: (_userId, value) => {
        upserts += 1;
        return Promise.resolve(value);
      },
    };

    expect(() =>
      writeAgentProfileRendering(
        store,
        'user-1',
        profile.id,
        '---\nname: "Broken"\nrole: worker\n---\nPrompt'
      )
    ).toThrow(AgentProfileDbAdapterError);
    expect(upserts).toBe(0);
  });
});

function storeWith(value: AgentProfile): AgentProfileDbStore {
  return {
    read: () => Promise.resolve(value),
    upsert: (_userId, updated) => Promise.resolve(updated),
  };
}
