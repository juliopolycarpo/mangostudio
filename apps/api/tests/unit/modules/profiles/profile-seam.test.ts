import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PROFILE_ID } from '@mangostudio/shared/profiles';
import { sql } from 'kysely';
import { getDb } from '../../../../src/db/database';
import {
  assertRequestedProfileId,
  ProfileMismatchError,
  resolveActiveProfileId,
} from '../../../../src/lib/profile-context';

const API_ROOT = fileURLToPath(new URL('../../../..', import.meta.url));

const PROFILE_SCOPED_TABLES = ['environment_install_runs', 'library_divergence_acks'] as const;

const EXPECTED_INDEXES: Record<(typeof PROFILE_SCOPED_TABLES)[number], string> = {
  environment_install_runs: 'idx_environment_install_runs_user_profile_started',
  library_divergence_acks: 'idx_library_divergence_acks_user_profile_resource',
};

interface TableInfoRow {
  name: string;
  notnull: number;
  dflt_value: string | null;
}

interface IndexListRow {
  name: string;
  unique: number;
}

interface IndexInfoRow {
  name: string;
}

const QUERY_START =
  /\.(?:selectFrom|insertInto|updateTable|deleteFrom)\(\s*['"](environment_install_runs|library_divergence_acks)['"]\s*\)/g;

function extractQueryChains(
  source: string,
  relativePath: string
): { table: string; location: string; chain: string }[] {
  const chains: { table: string; location: string; chain: string }[] = [];
  const lineStarts = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === '\n') lineStarts.push(i + 1);
  }

  for (const match of source.matchAll(QUERY_START)) {
    const table = match[1];
    if (!table) continue;
    const start = match.index ?? 0;
    const executeMatch = /\.execute(?:TakeFirst)?\s*\(/.exec(source.slice(start));
    if (!executeMatch) continue;
    const end = start + (executeMatch.index ?? 0) + executeMatch[0].length;
    // Include a short lead-in so typed `.values(row)` inserts still show the
    // `profileId:` assignment that builds the row being written.
    const leadInStart = Math.max(0, start - 400);
    const line = lineStarts.findIndex((offset, index) => {
      const next = lineStarts[index + 1] ?? source.length;
      return offset <= start && start < next;
    });
    chains.push({
      table,
      location: `${relativePath}:${line + 1}`,
      chain: source.slice(leadInStart, end),
    });
  }
  return chains;
}

describe('profile seam', () => {
  it('resolveActiveProfileId always returns DEFAULT_PROFILE_ID', () => {
    expect(resolveActiveProfileId({ userId: 'anyone' })).toBe(DEFAULT_PROFILE_ID);
    expect(resolveActiveProfileId({ userId: '' })).toBe(DEFAULT_PROFILE_ID);
  });

  it('assertRequestedProfileId accepts a matching or omitted profile id', () => {
    expect(assertRequestedProfileId(undefined, { userId: 'u' })).toBe(DEFAULT_PROFILE_ID);
    expect(assertRequestedProfileId(DEFAULT_PROFILE_ID, { userId: 'u' })).toBe(DEFAULT_PROFILE_ID);
  });

  it('assertRequestedProfileId rejects a mismatched profile id', () => {
    expect(() => assertRequestedProfileId('work-laptop', { userId: 'u' })).toThrow(
      ProfileMismatchError
    );
  });

  it('migrated schema has profileId with the reserved default on both tables', async () => {
    const db = getDb();

    for (const table of PROFILE_SCOPED_TABLES) {
      const columns = await sql<TableInfoRow>`PRAGMA table_info(${sql.raw(table)})`.execute(db);
      const profileId = columns.rows.find((column) => column.name === 'profileId');
      expect(profileId, `${table}.profileId`).toBeDefined();
      expect(profileId?.notnull).toBe(1);
      expect(profileId?.dflt_value).toBe("'default'");

      const indexes = await sql<IndexListRow>`PRAGMA index_list(${sql.raw(table)})`.execute(db);
      const expectedIndex = EXPECTED_INDEXES[table];
      const index = indexes.rows.find((row) => row.name === expectedIndex);
      expect(index, expectedIndex).toBeDefined();
      if (table === 'library_divergence_acks') {
        expect(index?.unique).toBe(1);
      }

      const indexInfo =
        await sql<IndexInfoRow>`PRAGMA index_info(${sql.raw(expectedIndex)})`.execute(db);
      expect(indexInfo.rows.map((row) => row.name)).toContain('profileId');
    }
  });

  it('every query against a profile-scoped table mentions profileId', async () => {
    const offenders: string[] = [];

    for await (const relativePath of new Bun.Glob('src/**/*.ts').scan({
      cwd: API_ROOT,
      onlyFiles: true,
    })) {
      const source = await Bun.file(join(API_ROOT, relativePath)).text();
      for (const { table, location, chain } of extractQueryChains(source, relativePath)) {
        if (!/\bprofileId\b/.test(chain)) {
          offenders.push(`${location}: ${table} query omits profileId`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
