import { tmpdir } from 'node:os';
import {
  type Browser,
  type BrowserContext,
  expect,
  type Page,
  type Route,
  test,
} from '@playwright/test';

/**
 * A chat longer than one page opens on its NEWEST messages and loads older ones
 * as the reader scrolls up.
 *
 * It used to show only the oldest 50 messages: the transcript asked for the
 * first page oldest-first and never asked again, so a long chat ended at its
 * 50th message and nothing said anything was missing. What only a real browser
 * can prove is the part that is not data: that the view opens at the end, that
 * a page prepended above the reader does not move what they are looking at, and
 * that every message is reachable, once and in order, once everything is loaded.
 *
 * The spec is cheap on purpose. It gates every pull request and shares the
 * API's per-IP limiter (600 requests a minute) with every other spec, so it
 * never sleeps on the limiter and spends little of it: the transcript route
 * takes a `limit`, so the spec asks the hub for 12 rows a page instead of the
 * app's 50 (see `shrinkTranscriptPages`) and seeds 30 messages, three pages,
 * instead of 101 or more. The app's own request is asserted to be
 * `limit=50&order=desc`, so the page size is still the product's; only the
 * hub's answer is smaller.
 *
 * Waits are conditions (a row to be visible, a request to arrive), never
 * durations, and all of them draw on one budget (`SPEC_BUDGET_MS`) that the test
 * timeout exceeds. The scroll is the wheel, not `scrollTop = 0`: only a gesture
 * tells the feed that the reader, not layout, is moving the view.
 */

const TOTAL = 30;
/** What the spec makes the hub answer with, so three pages need only 30 rows. */
const PAGE_SIZE = 12;
/** What the app asks for; the spec asserts it still does. */
const APP_PAGE_SIZE = '50';
/** Pages behind the newest one: 30 rows in pages of 12 are 12 + 12 + 6. */
const OLDER_PAGES = Math.ceil(TOTAL / PAGE_SIZE) - 1;
const SEED_CONCURRENCY = 10;
const SMOKE_PASSWORD = 'smoke-pass-123';
/** The longest any single condition below is waited on. */
const WAIT_MS = 10_000;
/** Every wait of the spec body draws on this: seeding, opening, paging, the refetch. */
const SPEC_BUDGET_MS = 60_000;
/** Signing up before the budget starts and removing the chats after it. */
const OUTSIDE_BUDGET_MS = 30_000;
/** Twelve rows of about 150 px are 5 turns of the wheel; this is the bound, not the pace. */
const MAX_WHEEL_TURNS = 30;
/** A prepended page may not move the row the reader was looking at by more than this. */
const MAX_JUMP_PX = 4;
const BASE_TIMESTAMP = 1_700_000_000_000;
const TRANSCRIPT_PATTERN = '**/api/chats/*/messages?*';

let budgetEndsAt = 0;

/**
 * How long the next condition may be waited on: `WAIT_MS`, or what is left of
 * the spec's budget, so the waits can never add up to more than the test
 * timeout allows. Fails by name once the budget is spent.
 */
function waitMs(what: string): number {
  const left = budgetEndsAt - Date.now();
  if (left <= 0) {
    throw new Error(
      `expected ${what} within the ${SPEC_BUDGET_MS}ms spec budget | received: budget spent`
    );
  }
  return Math.min(WAIT_MS, left);
}

const label = (position: number) => `msg-${String(position).padStart(3, '0')}`;

interface ViewRow {
  /** The `msg-NNN` text of the row. */
  readonly text: string;
  /** The virtualizer's row index, which shifts when older rows are prepended. */
  readonly index: number;
  /** Distance of the row's top edge from the top of the scroll port. */
  readonly top: number;
}

interface View {
  readonly scrollTop: number;
  readonly clientHeight: number;
  readonly scrollHeight: number;
  /** Rows that intersect the scroll port, top to bottom. */
  readonly visible: readonly ViewRow[];
  /** Every rendered row, overscan included. */
  readonly rendered: readonly ViewRow[];
}

const FEED = 'section:has(> div > [data-index])';

/** Reads the transcript's scroll port: where it is and which rows are in it. */
function readView(page: Page): Promise<View | null> {
  return page.evaluate((selector) => {
    const port = document.querySelector<HTMLElement>(selector);
    if (!port) return null;
    const portTop = port.getBoundingClientRect().top;
    const rendered = [...port.querySelectorAll<HTMLElement>('[data-index]')].map((row) => {
      const box = row.getBoundingClientRect();
      return {
        text: /msg-\d{3}/.exec(row.textContent ?? '')?.[0] ?? '',
        index: Number(row.dataset.index),
        top: box.top - portTop,
        bottom: box.bottom - portTop,
      };
    });
    const visible = rendered.filter((row) => row.bottom > 0 && row.top < port.clientHeight);
    return {
      scrollTop: port.scrollTop,
      clientHeight: port.clientHeight,
      scrollHeight: port.scrollHeight,
      visible: visible.map(({ text, index, top }) => ({ text, index, top })),
      rendered: rendered.map(({ text, index, top }) => ({ text, index, top })),
    };
  }, FEED);
}

const visibleLabels = (view: View | null) => view?.visible.map((row) => row.text) ?? [];

/**
 * Waits until the newest (`last`) or oldest (`first`) message in the viewport
 * is `expected`, and fails as `expected last message visible: msg-030 |
 * received: msg-050 (on open)` when it never is.
 */
async function expectEdgeVisible(
  page: Page,
  edge: 'first' | 'last',
  expected: string,
  when: string
): Promise<void> {
  await expect(async () => {
    const labels = visibleLabels(await readView(page)).sort();
    const received = (edge === 'last' ? labels.at(-1) : labels[0]) ?? 'none';
    expect(
      received,
      `expected ${edge} message visible: ${expected} | received: ${received} (${when})`
    ).toBe(expected);
  }).toPass({ timeout: waitMs(`${edge} message ${expected} visible (${when})`) });
}

/** Moves the pointer over the transcript and turns the wheel: a reader's gesture. */
async function wheel(page: Page, deltaY: number): Promise<void> {
  const box = await page.locator(FEED).boundingBox();
  if (!box) throw new Error(`expected transcript: visible | received: ${FEED} not found`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, deltaY);
}

async function createChat(page: Page, title: string): Promise<string> {
  const created = await page.request.post('/api/chats', { data: { title } });
  expect(created.ok(), `expected chat create: 2xx | received: ${created.status()}`).toBe(true);
  const { id } = (await created.json()) as { id: string };
  // A chat with no working directory opens a folder picker over the rail.
  const bound = await page.request.put(`/api/chats/${id}`, { data: { workdir: tmpdir() } });
  expect(bound.ok(), `expected workdir bind: 2xx | received: ${bound.status()}`).toBe(true);
  return id;
}

/** Stores one message through the API, one request, no retry. */
async function postMessage(page: Page, chatId: string, position: number): Promise<void> {
  const response = await page.request.post('/api/messages', {
    data: {
      id: `${chatId}-${label(position)}`,
      chatId,
      role: position % 2 === 1 ? 'user' : 'ai',
      text: label(position),
      timestamp: BASE_TIMESTAMP + position,
      interactionMode: 'agent',
    },
  });
  expect(
    response.ok(),
    `expected ${label(position)} stored: 2xx | received: ${response.status()}`
  ).toBe(true);
}

async function seedMessages(page: Page, chatId: string, from: number, to: number) {
  const positions = Array.from({ length: to - from + 1 }, (_, index) => from + index);
  const workers = Array.from({ length: SEED_CONCURRENCY }, async () => {
    for (let next = positions.shift(); next !== undefined; next = positions.shift()) {
      await postMessage(page, chatId, next);
    }
  });
  await Promise.all(workers);
}

const sidebarRow = (page: Page, title: string) =>
  page
    .getByRole('navigation', { name: 'Chats' })
    .getByRole('listitem')
    .filter({ has: page.getByTitle(title, { exact: true }) });

async function openChat(page: Page, title: string): Promise<void> {
  await sidebarRow(page, title).getByTitle(title, { exact: true }).click();
}

/** The query of one transcript request as the app sent it. */
interface TranscriptRequest {
  readonly limit: string | null;
  readonly order: string | null;
  readonly cursor: string | null;
}

/**
 * Stands between the page and the hub on the transcript route.
 *
 * - Every request is recorded as the app sent it, then forwarded with `limit`
 *   replaced by `pageSize`: the hub pages for real, only with fewer rows.
 * - While `holdOlder(true)`, a request for an older page (one with a cursor) is
 *   kept in flight until `release()`, and `requested()` says one is. The
 *   reader's view is then still while the page is fetched, so what moves when
 *   it lands is the prepend and nothing else.
 */
function shrinkTranscriptPages(page: Page, pageSize: number) {
  const asked: TranscriptRequest[] = [];
  let holding = false;
  let held: { route: Route; url: string } | null = null;
  const handler = async (route: Route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const url = new URL(route.request().url());
    asked.push({
      limit: url.searchParams.get('limit'),
      order: url.searchParams.get('order'),
      cursor: url.searchParams.get('cursor'),
    });
    url.searchParams.set('limit', String(pageSize));
    if (holding && url.searchParams.has('cursor')) {
      held = { route, url: url.toString() };
      return;
    }
    await route.continue({ url: url.toString() });
  };
  return {
    asked,
    install: () => page.route(TRANSCRIPT_PATTERN, handler),
    holdOlder(on: boolean) {
      holding = on;
    },
    requested: () => held !== null,
    async release() {
      const request = held;
      held = null;
      await request?.route.continue({ url: request.url });
    },
    uninstall: () => page.unroute(TRANSCRIPT_PATTERN, handler),
  };
}

type Transcript = ReturnType<typeof shrinkTranscriptPages>;

/**
 * Turns the wheel up until the transcript asks for an older page, or there is
 * none to ask for because the first message is already in view.
 */
async function scrollUpUntilRequested(page: Page, hold: Transcript): Promise<void> {
  for (let turn = 0; turn < MAX_WHEEL_TURNS && !hold.requested(); turn++) {
    const view = await readView(page);
    if (visibleLabels(view).includes(label(1))) return;
    if ((view?.scrollTop ?? 1) <= 0) break;
    const before = view?.scrollTop ?? 0;
    await wheel(page, -400);
    await expect
      .poll(
        async () => hold.requested() || ((await readView(page))?.scrollTop ?? before) !== before,
        {
          message: 'expected the wheel to move the transcript up',
          timeout: waitMs('the wheel to move the transcript up'),
        }
      )
      .toBe(true);
  }
  await expect
    .poll(async () => hold.requested() || visibleLabels(await readView(page)).includes(label(1)), {
      message:
        'expected an older page requested at the top of the loaded rows | received: no request',
      timeout: waitMs('an older page requested at the top of the loaded rows'),
    })
    .toBe(true);
}

/**
 * Waits until the transcript has stopped moving: its `scrollTop` unchanged for
 * eight frames in a row. One turn of the wheel is a scroll animation, not a
 * jump, and `scrollTop` has changed on its first frame; a row read before the
 * animation ends is still travelling, which would read as a prepended page
 * moving it.
 */
async function awaitStill(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          ({ selector, stillFrames, maxFrames }) =>
            new Promise<boolean>((resolve) => {
              const port = document.querySelector<HTMLElement>(selector);
              if (!port) return resolve(false);
              let last = port.scrollTop;
              let still = 0;
              let frames = 0;
              const tick = () => {
                still = port.scrollTop === last ? still + 1 : 0;
                last = port.scrollTop;
                if (still >= stillFrames) return resolve(true);
                if (++frames >= maxFrames) return resolve(false);
                requestAnimationFrame(tick);
              };
              requestAnimationFrame(tick);
            }),
          { selector: FEED, stillFrames: 8, maxFrames: 240 }
        ),
      {
        message: 'expected the transcript to stop moving after the wheel | received: still moving',
        timeout: waitMs('the transcript to stop moving after the wheel'),
      }
    )
    .toBe(true);
}

/** Starts recording where a row sits in the port on every frame; returns its stop. */
async function traceRow(page: Page, text: string): Promise<() => Promise<number[]>> {
  await page.evaluate(
    ({ selector, rowText }) => {
      const win = window as unknown as { __rowTops: number[]; __rowTraceOn: boolean };
      win.__rowTops = [];
      win.__rowTraceOn = true;
      const sample = () => {
        const port = document.querySelector<HTMLElement>(selector);
        const row = [...(port?.querySelectorAll<HTMLElement>('[data-index]') ?? [])].find(
          (element) => element.textContent?.includes(rowText)
        );
        if (port && row) {
          win.__rowTops.push(row.getBoundingClientRect().top - port.getBoundingClientRect().top);
        }
        if (win.__rowTraceOn) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    },
    { selector: FEED, rowText: text }
  );
  return () =>
    page.evaluate(
      () =>
        new Promise<number[]>((resolve) => {
          // Two more frames, so a correction that lands late is sampled too.
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              const win = window as unknown as { __rowTops: number[]; __rowTraceOn: boolean };
              win.__rowTraceOn = false;
              resolve(win.__rowTops);
            })
          );
        })
    );
}

/**
 * Signs up an account of the spec's own, in a context of its own, and finishes
 * its first-run setup so its pages open on the chat shell rather than on
 * `/welcome`. The suite's shared account is not used: this spec leaves a
 * chat of 30 messages behind, and another spec running in parallel (workers are not
 * limited outside CI) must neither see it in its chat list nor be seen by it.
 */
async function newSignedInContext(browser: Browser, run: string): Promise<BrowserContext> {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const signup = await context.request.post('/api/auth/sign-up/email', {
    data: {
      name: 'Transcript Paging',
      email: `transcript-paging-${run}@test.local`,
      password: SMOKE_PASSWORD,
    },
  });
  expect(signup.ok(), `expected signup: 2xx | received: ${signup.status()}`).toBe(true);
  const setup = await context.request.put('/api/settings/app', {
    data: {
      profileSettings: {
        default: {
          onboarding: { welcomeAcknowledged: true, skippedSteps: [], completedAt: Date.now() },
        },
      },
    },
  });
  expect(setup.ok(), `expected first-run setup: 2xx | received: ${setup.status()}`).toBe(true);
  return context;
}

test('a chat longer than a page opens on its newest messages and loads older ones on demand', async ({
  browser,
}, testInfo) => {
  // The body's waits all draw on SPEC_BUDGET_MS (see `waitMs`), so this is
  // above their sum by construction; the rest is signing up before it and
  // removing the chats after it, a few requests each.
  test.setTimeout(SPEC_BUDGET_MS + OUTSIDE_BUDGET_MS);
  const run = `${Date.now()}-${testInfo.repeatEachIndex}`;
  const context = await newSignedInContext(browser, run);
  const page = await context.newPage();
  const chatIds: string[] = [];
  try {
    budgetEndsAt = Date.now() + SPEC_BUDGET_MS;
    await readTranscriptNewestFirst(page, run, chatIds);
  } finally {
    // Soft, so a failed cleanup never hides the failure that led here. The
    // account itself stays: the hub runs on a throwaway home.
    const removed = await Promise.all(chatIds.map((id) => page.request.delete(`/api/chats/${id}`)));
    for (const response of removed) {
      expect
        .soft(response.ok(), `expected chat cleanup: 2xx | received: ${response.status()}`)
        .toBe(true);
    }
    await context.close();
  }
});

async function readTranscriptNewestFirst(
  page: Page,
  run: string,
  chatIds: string[]
): Promise<void> {
  const title = `Transcript paging ${run}`;
  const otherTitle = `Transcript paging other ${run}`;

  const chatId = await createChat(page, title);
  chatIds.push(chatId);
  chatIds.push(await createChat(page, otherTitle));
  await seedMessages(page, chatId, 1, TOTAL);

  const transcript = shrinkTranscriptPages(page, PAGE_SIZE);
  await transcript.install();
  await page.goto('/');
  await openChat(page, title);

  // The reader lands on the end of the conversation, not on its first page.
  await expectEdgeVisible(page, 'last', label(TOTAL), 'on open');
  const opened = await readView(page);
  expect(
    visibleLabels(opened).includes(label(1)),
    `expected first message loaded on open: no | received: ${label(1)} is in the viewport`
  ).toBe(false);
  // The app asks for its own page size, newest end first, and nothing older yet.
  const first = transcript.asked.find((request) => request.cursor === null);
  expect(
    `limit=${first?.limit} order=${first?.order}`,
    `expected the app's first transcript request: limit=${APP_PAGE_SIZE} order=desc | received: ${JSON.stringify(transcript.asked)}`
  ).toBe(`limit=${APP_PAGE_SIZE} order=desc`);
  expect(
    transcript.asked.filter((request) => request.cursor !== null).length,
    `expected older pages requested on open: 0 | received: ${JSON.stringify(transcript.asked)}`
  ).toBe(0);

  // Read back one page at a time. Each older page is held in flight while the
  // reader is still, so the row they were looking at before it lands is the
  // reference for where it must be after.
  let pagesPrepended = 0;
  transcript.holdOlder(true);
  while (!visibleLabels(await readView(page)).includes(label(1))) {
    await scrollUpUntilRequested(page, transcript);
    if (!transcript.requested()) break;
    await awaitStill(page);

    const anchor = (await readView(page))?.visible[0];
    if (!anchor) throw new Error('expected a row in the viewport | received: none');
    const stopTrace = await traceRow(page, anchor.text);
    await transcript.release();
    await expect
      .poll(
        async () =>
          (await readView(page))?.visible.find((row) => row.text === anchor.text)?.index ?? -1,
        {
          message: `expected ${anchor.text} to move down when an older page lands`,
          timeout: waitMs(`${anchor.text} to move down when an older page lands`),
        }
      )
      .toBeGreaterThan(anchor.index);

    const tops = await stopTrace();
    const jump = Math.max(...tops.map((top) => Math.abs(top - anchor.top)));
    expect(
      tops.length,
      `expected frames sampled for ${anchor.text}: > 0 | received: ${tops.length}`
    ).toBeGreaterThan(0);
    expect(
      jump,
      `expected ${anchor.text} to stay within ${MAX_JUMP_PX}px when older rows are prepended | received: moved ${jump}px (was ${anchor.top}px)`
    ).toBeLessThanOrEqual(MAX_JUMP_PX);
    pagesPrepended++;
    expect(
      pagesPrepended,
      `expected older pages prepended: <= ${OLDER_PAGES} | received: ${pagesPrepended}`
    ).toBeLessThanOrEqual(OLDER_PAGES);
  }
  transcript.holdOlder(false);
  expect(
    pagesPrepended,
    `expected older pages prepended before the first message: ${OLDER_PAGES} | received: ${pagesPrepended}`
  ).toBe(OLDER_PAGES);

  // Everything is loaded: each rendered row sits at the index its text says,
  // so a duplicate or a gap anywhere shows up as a row in the wrong place.
  await expectEdgeVisible(page, 'first', label(1), 'at the top');
  const reached = new Set<string>();
  for (let step = 0; step < MAX_WHEEL_TURNS; step++) {
    const view = await readView(page);
    for (const row of view?.rendered ?? []) {
      expect(
        row.text,
        `expected row ${row.index} to read ${label(row.index + 1)} | received: ${row.text}`
      ).toBe(label(row.index + 1));
      reached.add(row.text);
    }
    if (view && view.scrollTop + view.clientHeight >= view.scrollHeight - 1) break;
    const before = view?.scrollTop ?? 0;
    await wheel(page, 600);
    await expect
      .poll(async () => (await readView(page))?.scrollTop ?? before, {
        message: 'expected the wheel to move the transcript down',
        timeout: waitMs('the wheel to move the transcript down'),
      })
      .toBeGreaterThan(before);
  }
  expect(reached.size, `expected messages reached: ${TOTAL} | received: ${reached.size}`).toBe(
    TOTAL
  );

  // A message stored since the transcript loaded appears once it refetches. The
  // query goes stale after 30 s; the page's clock is moved past that rather than
  // waited for, and switching away and back is what refetches a stale query.
  await postMessage(page, chatId, TOTAL + 1);
  await page.evaluate(() => {
    const realNow = Date.now.bind(Date);
    Date.now = () => realNow() + 31_000;
  });
  await openChat(page, otherTitle);
  await openChat(page, title);
  await expectEdgeVisible(page, 'last', label(TOTAL + 1), 'after the refetch');
  await transcript.uninstall();
}
