import { describe, expect, it } from 'bun:test';
import { GITHUB_PR_REVIEW_THREADS_QUERY } from '@mangostudio/shared/github';
import {
  buildGhCommandArgv,
  GH_COMMAND_SPECS,
  type GhCommandId,
} from '../../../../src/modules/github/domain/gh-command-registry';

/**
 * Values a person could plausibly type into a pull request title and that Go's
 * pflag would read as flags if they arrived as their own argv token.
 */
const HOSTILE_TEXT = [
  '--repo=evil/repo',
  '--repo evil/repo',
  '-R evil/repo',
  '--web',
  '--show-token',
  '-',
  '--',
] as const;

/** Every command's subcommand tokens must stay inside the runtime's allowlist. */
const RUNTIME_ALLOWLIST: Readonly<Record<GhCommandId, { subcommand: string; mutation: boolean }>> =
  {
    'auth.status': { subcommand: 'auth status', mutation: false },
    'repo.view': { subcommand: 'repo view', mutation: false },
    'pr.view-current': { subcommand: 'pr view', mutation: false },
    'pr.view': { subcommand: 'pr view', mutation: false },
    'pr.view-summary': { subcommand: 'pr view', mutation: false },
    'pr.list': { subcommand: 'pr list', mutation: false },
    'pr.checks': { subcommand: 'pr checks', mutation: false },
    'pr.review-threads': { subcommand: 'api graphql', mutation: false },
    'issue.list': { subcommand: 'issue list', mutation: false },
    'search.prs': { subcommand: 'search prs', mutation: false },
    'pr.create': { subcommand: 'pr create', mutation: true },
    'pr.ready': { subcommand: 'pr ready', mutation: true },
    'pr.checkout': { subcommand: 'pr checkout', mutation: true },
  };

/** Minimal valid slots per command, so the sweeps below can build every argv. */
const VALID_PARAMS = {
  'auth.status': {},
  'repo.view': {},
  'pr.view-current': {},
  'pr.view': { number: 42 },
  'pr.view-summary': { number: 42 },
  'pr.list': { filter: 'open', limit: 20 },
  'pr.checks': { number: 42 },
  'pr.review-threads': { owner: 'mango', name: 'mangostudio', number: 42 },
  'issue.list': { filter: 'open', limit: 20 },
  'search.prs': { limit: 20 },
  'pr.create': { title: 'Add a panel', body: 'Because.', head: 'feat/panel', draft: false },
  'pr.ready': { number: 42 },
  'pr.checkout': { number: 42 },
} satisfies Record<GhCommandId, object>;

const ids = Object.keys(GH_COMMAND_SPECS) as GhCommandId[];

/**
 * `never` rather than a cast to each command's own slot type: the sweeps below
 * are generic over every spec, and `never` is assignable to all of them.
 */
const argvFor = (id: GhCommandId): readonly string[] =>
  buildGhCommandArgv(id, VALID_PARAMS[id] as never);

describe('gh command registry', () => {
  it('keys every spec by its own id', () => {
    for (const id of ids) expect(GH_COMMAND_SPECS[id].id).toBe(id);
  });

  it('stays inside the runtime subcommand allowlist for the right method', () => {
    // The runtime keys its allowlist on the first one or two argv tokens and
    // keeps a separate list per method. A spec whose prefix drifted out of the
    // read list, or a read marked as a mutation, would be refused over the wire
    // rather than here — this is the copy that fails in a test instead.
    for (const id of ids) {
      const expected = RUNTIME_ALLOWLIST[id];
      const argv = argvFor(id);
      const subcommand = argv[0] === '--version' ? '--version' : `${argv[0]} ${argv[1]}`;
      expect(subcommand).toBe(expected.subcommand);
      expect(GH_COMMAND_SPECS[id].mutation).toBe(expected.mutation);
    }
  });

  it('never emits a flag the runtime refuses outright', () => {
    for (const id of ids) {
      const argv = argvFor(id);
      expect(argv).not.toContain('--web');
      expect(argv).not.toContain('--show-token');
    }
  });

  it('builds the documented argv for every read', () => {
    expect(argvFor('auth.status')).toEqual(['auth', 'status']);
    expect(argvFor('pr.list')).toEqual([
      'pr',
      'list',
      '--state=open',
      '--limit=20',
      '--json',
      'number,title,url,state,isDraft,headRefName,baseRefName,updatedAt,author,labels,reviewDecision,statusCheckRollup',
    ]);
    expect(buildGhCommandArgv('pr.list', { filter: 'mine', limit: 5 })).toContain('--author=@me');
    expect(buildGhCommandArgv('pr.list', { filter: 'review-requested', limit: 5 })).toContain(
      '--search=review-requested:@me'
    );
    expect(buildGhCommandArgv('issue.list', { filter: 'assigned', limit: 5 })).toContain(
      '--assignee=@me'
    );
    expect(buildGhCommandArgv('issue.list', { filter: 'mine', limit: 5 })).toContain(
      '--author=@me'
    );
    expect(argvFor('search.prs')).toEqual([
      'search',
      'prs',
      '--review-requested=@me',
      '--state=open',
      '--limit=20',
      '--json',
      'number,title,url,state,isDraft,updatedAt,author,labels,repository',
    ]);
  });

  it('carries the pinned GraphQL document as -f/-F pairs the runtime can walk', () => {
    // The one place the `=` form is wrong: the runtime's pinned-document check
    // reads `gh api graphql` argv two tokens at a time from index 2, so a fused
    // `-f=query=...` would fail its field-flag check. Safe because every value
    // here is a checked integer or a pattern-matched repository name part.
    expect(argvFor('pr.review-threads')).toEqual([
      'api',
      'graphql',
      '-f',
      `query=${GITHUB_PR_REVIEW_THREADS_QUERY}`,
      '-f',
      'owner=mango',
      '-f',
      'name=mangostudio',
      '-F',
      'number=42',
    ]);
  });

  it('rejects a repository name that is not one', () => {
    expect(() =>
      buildGhCommandArgv('pr.review-threads', {
        owner: '-f query=malicious',
        name: 'mangostudio',
        number: 1,
      })
    ).toThrow(TypeError);
  });

  describe('flag injection', () => {
    it('emits every free-text slot as a single --flag=value token', () => {
      for (const hostile of HOSTILE_TEXT) {
        const argv = buildGhCommandArgv('pr.create', {
          title: hostile,
          body: hostile,
          head: hostile,
          draft: false,
          base: hostile,
        });

        // The whole defence: the value is never a token of its own, so pflag
        // cannot read it as a flag however it starts.
        expect(argv).not.toContain(hostile);
        expect(argv).toContain(`--title=${hostile}`);
        expect(argv).toContain(`--body=${hostile}`);
        expect(argv).toContain(`--head=${hostile}`);
        expect(argv).toContain(`--base=${hostile}`);
      }
    });

    it('never lets a hostile value become a bare argv token on any command', () => {
      for (const id of ids) {
        for (const token of argvFor(id)) {
          for (const hostile of HOSTILE_TEXT) expect(token).not.toBe(hostile);
        }
      }
    });

    it('emits an empty body rather than omitting the flag', () => {
      // Omitting `--body` is what sends gh to the interactive editor, which
      // cannot open under GH_PROMPT_DISABLED=1.
      const argv = buildGhCommandArgv('pr.create', {
        title: 'Title',
        body: '',
        head: 'feat/x',
        draft: false,
      });
      expect(argv).toContain('--body=');
      expect(argv).toContain('--head=feat/x');
      expect(argv).not.toContain('--draft');
    });

    it('adds --draft only when the caller asked for a draft', () => {
      const argv = buildGhCommandArgv('pr.create', {
        title: 'Title',
        body: '',
        head: 'feat/x',
        draft: true,
      });
      expect(argv).toContain('--draft');
    });
  });

  describe('closed slots', () => {
    it('refuses a filter that is not one of the contract literals', () => {
      expect(() =>
        // @ts-expect-error the point of the test: an unknown filter must not build argv.
        buildGhCommandArgv('pr.list', { filter: '--author=attacker', limit: 20 })
      ).toThrow(TypeError);
    });

    it('refuses a limit outside the contract bounds', () => {
      expect(() => buildGhCommandArgv('pr.list', { filter: 'open', limit: 0 })).toThrow(TypeError);
      expect(() => buildGhCommandArgv('pr.list', { filter: 'open', limit: 31 })).toThrow(TypeError);
      expect(() => buildGhCommandArgv('pr.list', { filter: 'open', limit: 1.5 })).toThrow(
        TypeError
      );
    });

    it('refuses a pull request number that could become a flag', () => {
      // A positional cannot use the `=` form, so the bound is what keeps a
      // negative number from reaching gh as `-1`.
      expect(() => buildGhCommandArgv('pr.view', { number: -1 })).toThrow(TypeError);
      expect(() => buildGhCommandArgv('pr.view', { number: 0 })).toThrow(TypeError);
      expect(argvFor('pr.view')).toContain('42');
    });

    it('refuses an empty title, which gh would prompt for', () => {
      expect(() =>
        buildGhCommandArgv('pr.create', { title: '', body: '', head: 'feat/x', draft: false })
      ).toThrow(TypeError);
    });
  });

  it('accepts the reporting exit codes gh pr checks uses', () => {
    // `gh pr checks` exits 1 on a failing check and 8 on a pending one while
    // still printing the JSON, so a panel that only accepted 0 would 500 on
    // exactly the pull requests a person opens it to look at.
    expect(GH_COMMAND_SPECS['pr.checks'].acceptedExitCodes).toEqual([1, 8]);
    expect(GH_COMMAND_SPECS['pr.list'].acceptedExitCodes).toBeUndefined();
  });
});
