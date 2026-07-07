import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SkillDescriptorSchema,
  type SkillListResponse,
  SkillListResponseSchema,
} from '@mangostudio/shared/skills';
import { Value } from '@sinclair/typebox/value';
import { loadConfigForTest } from '../../../src/lib/config';
import {
  resetSkillsCache,
  setThirdPartySkillDirsForTest,
} from '../../../src/modules/skills/application/skill-discovery';
import { skillRoutes } from '../../../src/modules/skills/http/skill-routes';
import {
  createApiTestApp,
  createAuthenticatedApiTestApp,
} from '../../support/harness/create-api-test-app';

const TEST_USER = {
  id: 'skills-routes-user',
  name: 'Skills Routes User',
  email: 'skills-routes@mangostudio.test',
};

const OTHER_USER = {
  id: 'skills-routes-other-user',
  name: 'Other Skills Routes User',
  email: 'other-skills-routes@mangostudio.test',
};

let skillsDir: string;
let agentsDir: string;
let claudeDir: string;
let restoreAuth: (() => void) | null = null;

function writeSkill(slug: string, description: string): void {
  const dir = join(skillsDir, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${slug}\ndescription: ${description}\n---\n\nBody.\n`,
    'utf8'
  );
}

beforeEach(() => {
  skillsDir = mkdtempSync(join(tmpdir(), 'mango-skills-routes-'));
  agentsDir = mkdtempSync(join(tmpdir(), 'mango-skills-routes-agents-'));
  claudeDir = mkdtempSync(join(tmpdir(), 'mango-skills-routes-claude-'));
  // Mirror the preload's base test config: overriding only `skills` would
  // reset the auth secret and break `getAuth()` inside the routes under test.
  loadConfigForTest({
    auth: { secret: 'test-secret-at-least-32-characters-long', url: 'http://localhost:3001' },
    database: { path: ':memory:' },
    skills: { dir: skillsDir },
  });
  setThirdPartySkillDirsForTest({ agents: agentsDir, claude: claudeDir });
  resetSkillsCache();
});

afterEach(() => {
  restoreAuth?.();
  restoreAuth = null;
  rmSync(skillsDir, { recursive: true, force: true });
  rmSync(agentsDir, { recursive: true, force: true });
  rmSync(claudeDir, { recursive: true, force: true });
  setThirdPartySkillDirsForTest(null);
  resetSkillsCache();
});

describe('skills routes', () => {
  it('lists discovered skills and third-party source states', async () => {
    writeSkill('pdf-tools', 'Work with PDF files');
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, skillRoutes);
    restoreAuth = restore;

    const response = await app.handle(new Request('http://localhost/skills'));
    const payload = (await response.json()) as SkillListResponse;

    expect(response.status).toBe(200);
    expect(Value.Check(SkillListResponseSchema, payload)).toBe(true);
    expect(payload.skills.map((skill) => skill.key)).toEqual(['mango:pdf-tools']);
    expect(payload.sources.agents).toMatchObject({ enabled: false, path: agentsDir, exists: true });
    expect(payload.sources.claude).toMatchObject({ enabled: false, path: claudeDir, exists: true });
  });

  it('persists per-skill toggles per user', async () => {
    writeSkill('pdf-tools', 'Work with PDF files');
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, skillRoutes);
    restoreAuth = restore;

    const update = await app.handle(
      new Request('http://localhost/skills/mango:pdf-tools', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      })
    );
    const updatedPayload = await update.json();

    expect(update.status).toBe(200);
    expect(Value.Check(SkillDescriptorSchema, updatedPayload)).toBe(true);
    expect(updatedPayload).toMatchObject({ key: 'mango:pdf-tools', enabled: false });

    const list = await app.handle(new Request('http://localhost/skills'));
    const listPayload = (await list.json()) as SkillListResponse;
    expect(listPayload.skills[0]).toMatchObject({ enabled: false });

    restoreAuth?.();
    const other = createAuthenticatedApiTestApp(OTHER_USER, skillRoutes);
    restoreAuth = other.restore;

    const otherList = await other.app.handle(new Request('http://localhost/skills'));
    const otherPayload = (await otherList.json()) as SkillListResponse;
    expect(otherPayload.skills[0]).toMatchObject({ enabled: true });
  });

  it('returns 404 for unknown or malformed skill keys', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, skillRoutes);
    restoreAuth = restore;

    const unknown = await app.handle(
      new Request('http://localhost/skills/mango:nope', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      })
    );
    const malformed = await app.handle(
      new Request('http://localhost/skills/not-a-key', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      })
    );

    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ code: 'NOT_FOUND' });
    expect(malformed.status).toBe(404);
    expect(await malformed.json()).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects unauthenticated requests', async () => {
    const app = createApiTestApp(skillRoutes);

    const list = await app.handle(new Request('http://localhost/skills'));
    const update = await app.handle(
      new Request('http://localhost/skills/mango:pdf-tools', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      })
    );

    expect(list.status).toBe(401);
    expect(update.status).toBe(401);
  });
});
