import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { CHAT_SEARCH_MAX_LENGTH } from '@mangostudio/shared/chat';

import { getDb } from '../../../src/db/database';
import { chatSearchKey } from '../../../src/modules/chats/domain/chat-search-key';
import { chatRoutes } from '../../../src/modules/chats/http/chat-routes';
import { errorHandler } from '../../../src/plugins/error-handler';
import { insertTestChat, insertTestUser, type UserFixture } from '../../support/factories';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';

/**
 * `GET /chats?q=`: the sidebar and the palette search the whole history on the
 * server instead of loading every page. A chat matches when the query is a
 * substring of its title, its workdir's last path segment or its runner label,
 * the three things the client-side filter read, compared without regard to
 * case or accents. Every test seeds explicit `updatedAt` values so the order is fixed.
 */

const BASE_TIME = 1_750_000_000_000;

interface PageBody {
  items: { id: string; title: string }[];
  nextCursor: string | null;
}

interface SeededChat {
  name: string;
  title?: string;
  workdir?: string;
  runner?: { kind: 'external'; targetId: string };
}

let user!: UserFixture;
let tag = '';
let restoreAuth: (() => void) | null = null;
let app: ReturnType<typeof createAuthenticatedApiTestApp>['app'] | null = null;

beforeEach(async () => {
  user = await insertTestUser();
  tag = user.id.slice(-12);
  const created = createAuthenticatedApiTestApp(user, errorHandler, chatRoutes);
  app = created.app;
  restoreAuth = created.restore;
});

afterEach(() => {
  restoreAuth?.();
  restoreAuth = null;
  app = null;
});

function uid(name: string): string {
  return `${tag}-${name}`;
}

function liveApp() {
  if (!app) throw new Error('(chat-list-search): expected a test app: created | received: null');
  return app;
}

/** Seeds newest-last, so the list order is the reverse of the argument order. */
async function seed(owner: UserFixture, chats: SeededChat[]) {
  for (const [index, chat] of chats.entries()) {
    const title = chat.title ?? chat.name;
    await insertTestChat(owner.id, { id: uid(chat.name), title });
    // A raw write, to pin `updatedAt`, so it stores the search text itself.
    await getDb()
      .updateTable('chats')
      .set({
        updatedAt: BASE_TIME + index,
        ...(chat.workdir ? { workdir: chat.workdir } : {}),
        ...(chat.runner
          ? { runnerKind: 'external', runnerAgentId: null, runnerTargetId: chat.runner.targetId }
          : {}),
        searchText: chatSearchKey({
          title,
          workdir: chat.workdir ?? null,
          runnerKind: chat.runner ? 'external' : 'mangostudio',
          runnerTargetId: chat.runner?.targetId ?? null,
        }),
      })
      .where('id', '=', uid(chat.name))
      .execute();
  }
}

async function search(
  q: string,
  extra = ''
): Promise<{ status: number; body: PageBody & { code?: string; error?: string } }> {
  const response = await liveApp().handle(
    new Request(`http://localhost/chats?q=${encodeURIComponent(q)}${extra}`)
  );
  return { status: response.status, body: (await response.json()) as PageBody };
}

function names(page: { body: PageBody }): string[] {
  return page.body.items.map((item) => item.id.slice(tag.length + 1));
}

describe('GET /chats?q= matching', () => {
  it('matches the title as a substring, ignoring ASCII case, newest first', async () => {
    await seed(user, [
      { name: 'a', title: 'Release notes' },
      { name: 'b', title: 'unrelated' },
      { name: 'c', title: 'Plan the RELEASE' },
    ]);

    const found = await search('release');

    expect(found.status).toBe(200);
    expect(names(found)).toEqual(['c', 'a']);
    expect(found.body.nextCursor).toBeNull();
  });

  it('matches the last segment of the workdir and not the folders above it', async () => {
    await seed(user, [
      { name: 'in-lsp', workdir: '/srv/projects/mango-lsp-store' },
      { name: 'elsewhere', workdir: '/srv/other/thing' },
    ]);

    expect(names(await search('LSP'))).toEqual(['in-lsp']);
    expect(names(await search('projects')), 'a parent folder must not match').toEqual([]);
  });

  it('reads the last folder through a trailing separator and from a Windows path', async () => {
    await seed(user, [
      { name: 'trailing', workdir: '/srv/projects/ledger/' },
      { name: 'windows', workdir: 'C:\\work\\harbor' },
    ]);

    expect(names(await search('ledger'))).toEqual(['trailing']);
    expect(names(await search('harbor'))).toEqual(['windows']);
    expect(names(await search('work')), 'a parent folder must not match').toEqual([]);
  });

  it('matches the runner label the sidebar shows: mango for the built-in runner, the target for a vendor', async () => {
    await seed(user, [
      { name: 'native' },
      { name: 'vendor', runner: { kind: 'external', targetId: 'codex' } },
    ]);

    expect(names(await search('codex'))).toEqual(['vendor']);
    expect(names(await search('MANGO'))).toEqual(['native']);
  });

  it('finds an accented title by its upper-case form and by the accent-free spelling', async () => {
    await seed(user, [
      { name: 'pt', title: 'Configuração' },
      { name: 'other', title: 'Revisão do plano' },
    ]);

    for (const query of ['CONFIGURAÇÃO', 'configuracao', 'configuração', 'CONFIGURACAO', 'çã']) {
      expect(
        names(await search(query)),
        `(q=${JSON.stringify(query)}): expected chats matching "Configuração": ["pt"]`
      ).toEqual(['pt']);
    }
  });

  it('finds an accent-free title by an accented query', async () => {
    await seed(user, [{ name: 'plain', title: 'configuracao do servidor' }]);

    expect(names(await search('Configuração'))).toEqual(['plain']);
  });

  it('treats a decomposed accent and a precomposed one as the same letter', async () => {
    await seed(user, [{ name: 'nfd', title: 'Configuração' }]);

    expect(names(await search('configuração'))).toEqual(['nfd']);
    expect(names(await search('CONFIGURAÇÃO'))).toEqual(['nfd']);
  });

  it('matches the workdir folder through accents and case', async () => {
    await seed(user, [{ name: 'dir', workdir: '/srv/Projétos/Relatório' }]);

    expect(names(await search('RELATORIO'))).toEqual(['dir']);
    expect(names(await search('projetos')), 'a parent folder must not match').toEqual([]);
  });

  it('folds Turkish dotted and dotless i onto i', async () => {
    await seed(user, [
      { name: 'dotted', title: 'İstanbul trip' },
      { name: 'dotless', title: 'ıspanak recipe' },
      { name: 'ascii', title: 'ISTANBUL guide' },
    ]);

    expect(names(await search('istanbul'))).toEqual(['ascii', 'dotted']);
    expect(names(await search('İSTANBUL'))).toEqual(['ascii', 'dotted']);
    expect(names(await search('ISPANAK'))).toEqual(['dotless']);
  });

  it('folds German sharp s onto ss, and umlauts onto their base letter', async () => {
    await seed(user, [
      { name: 'strasse', title: 'Straße' },
      { name: 'upper', title: 'MÜLLER' },
      { name: 'ascii', title: 'strasse map' },
    ]);

    expect(names(await search('STRASSE'))).toEqual(['ascii', 'strasse']);
    expect(names(await search('straße'))).toEqual(['ascii', 'strasse']);
    expect(names(await search('muller'))).toEqual(['upper']);
  });

  it('treats % and _ as the characters they are', async () => {
    await seed(user, [
      { name: 'pct', title: '100% sure' },
      { name: 'under', title: 'a_b' },
      { name: 'wild', title: 'axb' },
    ]);

    expect(names(await search('%'))).toEqual(['pct']);
    expect(names(await search('a_b'))).toEqual(['under']);
  });

  it('ignores surrounding whitespace, and lists everything for a whitespace-only query', async () => {
    await seed(user, [{ name: 'a', title: 'Release notes' }, { name: 'b' }]);

    expect(names(await search('  notes  '))).toEqual(['a']);
    expect(names(await search('   ')), 'whitespace is no filter').toEqual(['b', 'a']);
  });

  it('never matches another account', async () => {
    const other = await insertTestUser();
    await insertTestChat(other.id, { id: `${tag}-theirs`, title: 'shared secret term' });
    await seed(user, [{ name: 'mine', title: 'shared term of mine' }]);

    expect(names(await search('shared'))).toEqual(['mine']);
  });
});

describe('GET /chats?q= paging', () => {
  it('walks only the matches, in order, with the same cursor the unfiltered list uses', async () => {
    await seed(
      user,
      Array.from({ length: 12 }, (_, index) => ({
        name: `c${index}`,
        title: index % 2 === 0 ? `match ${index}` : `other ${index}`,
      }))
    );

    const walked: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await search(
        'match',
        `&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
      );
      walked.push(...names(page));
      cursor = page.body.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 10);

    expect(walked).toEqual(['c10', 'c8', 'c6', 'c4', 'c2', 'c0']);
    expect(pages).toBe(3);
  });
});

describe('GET /chats?q= bounds', () => {
  it('accepts a query of the longest allowed length', async () => {
    const response = await search('x'.repeat(CHAT_SEARCH_MAX_LENGTH));

    expect(response.status).toBe(200);
  });

  it('refuses a longer query with a 422', async () => {
    const response = await search('x'.repeat(CHAT_SEARCH_MAX_LENGTH + 1));

    expect(
      response.status,
      `(GET /chats): expected q of ${CHAT_SEARCH_MAX_LENGTH + 1} chars: 422 | received ${response.status} ${JSON.stringify(response.body)}`
    ).toBe(422);
  });
});
