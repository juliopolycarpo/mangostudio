import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_APP_SETTINGS } from '@mangostudio/shared/app-settings';
import { type SkillListResponse, SkillListResponseSchema } from '@mangostudio/shared/skills';
import { Value } from '@sinclair/typebox/value';
import { getDb } from '../../../src/db/database';
import { loadConfigForTest, TEST_MANAGED_CONFIG_PATH } from '../../../src/lib/config';
import { upsertAppSettings } from '../../../src/modules/app-settings/infrastructure/app-settings-repository';
import { resetSkillsCache } from '../../../src/modules/skills/application/skill-discovery';
import { settingsRoutes } from '../../../src/routes/settings';
import {
  createApiTestApp,
  createAuthenticatedApiTestApp,
} from '../../support/harness/create-api-test-app';

const TEST_USER = {
  id: 'skill-settings-user',
  name: 'Skill Settings User',
  email: 'skill-settings@mangostudio.test',
};

const ORIGINAL_HOME = homedir();
let restoreAuth: (() => void) | null = null;
let skillsDir: string;
let homeDir: string;

beforeEach(() => {
  skillsDir = mkdtempSync(join(tmpdir(), 'mango-skill-routes-'));
  homeDir = mkdtempSync(join(tmpdir(), 'mango-skill-routes-home-'));
  process.env.HOME = homeDir;
  mkdirSync(join(homeDir, '.agents', 'skills'), { recursive: true });
  loadConfigForTest({
    auth: { secret: 'test-secret-at-least-32-characters-long', url: 'http://localhost:3001' },
    database: { path: ':memory:' },
    skills: { dir: skillsDir },
    configFilePath: TEST_MANAGED_CONFIG_PATH,
  });
  resetSkillsCache();
});

afterEach(() => {
  restoreAuth?.();
  restoreAuth = null;
  process.env.HOME = ORIGINAL_HOME;
  rmSync(skillsDir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
  resetSkillsCache();
});

function writeSkill(slug: string, description = 'A test skill'): void {
  const dir = join(skillsDir, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${slug}\ndescription: ${description}\n---\nbody`,
    'utf8'
  );
}

describe('settings skill routes', () => {
  it('lists discovered skills and source state', async () => {
    writeSkill('alpha', 'Alpha skill');
    await upsertAppSettings(getDb(), TEST_USER.id, DEFAULT_APP_SETTINGS);

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, settingsRoutes);
    restoreAuth = restore;

    const response = await app.handle(new Request('http://localhost/settings/skills'));
    const payload = (await response.json()) as SkillListResponse;

    expect(response.status).toBe(200);
    expect(Value.Check(SkillListResponseSchema, payload)).toBe(true);
    expect(payload.skills.map((skill) => skill.slug)).toContain('alpha');
    expect(payload.skills[0]?.shadowed).toBe(false);
    expect(payload.sources.agents.enabled).toBe(false);
    expect(payload.sources.claude.enabled).toBe(false);
  });

  it('persists a per-skill toggle and reflects it in the list', async () => {
    writeSkill('alpha', 'Alpha skill');
    await upsertAppSettings(getDb(), TEST_USER.id, DEFAULT_APP_SETTINGS);

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, settingsRoutes);
    restoreAuth = restore;

    const update = await app.handle(
      new Request('http://localhost/settings/skills/mango:alpha', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      })
    );
    const updatedPayload = await update.json();

    expect(update.status).toBe(200);
    expect(updatedPayload).toMatchObject({ key: 'mango:alpha', enabled: false });

    const list = await app.handle(new Request('http://localhost/settings/skills'));
    const listPayload = (await list.json()) as SkillListResponse;
    const alpha = listPayload.skills.find((skill) => skill.key === 'mango:alpha');
    expect(alpha?.enabled).toBe(false);
  });

  it('returns 404 for an unknown skill key', async () => {
    await upsertAppSettings(getDb(), TEST_USER.id, DEFAULT_APP_SETTINGS);
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, settingsRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/settings/skills/mango:nonexistent', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      })
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('returns 422 for a malformed skill key', async () => {
    await upsertAppSettings(getDb(), TEST_USER.id, DEFAULT_APP_SETTINGS);
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, settingsRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/settings/skills/not-a-key', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      })
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: 'VALIDATION' });
  });

  it('rejects unauthenticated requests with 401', async () => {
    const app = createApiTestApp(settingsRoutes);

    const response = await app.handle(new Request('http://localhost/settings/skills'));
    expect(response.status).toBe(401);
  });
});
