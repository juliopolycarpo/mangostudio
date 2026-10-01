import { tmpdir } from 'node:os';
import {
  type APIResponse,
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
 * first page oldest-first and never asked again, so a 130-message chat ended at
 * `msg-050` and nothing said anything was missing. What only a real browser can
 * prove is the part that is not data: that the view opens at the end, that a
 * page prepended above the reader does not move what they are looking at, and
 * that every message is reachable, once and in order, once everything is loaded.
 *
 * Waits are conditions (a row to be visible, a request to arrive), never
 * durations. The scroll is the wheel, not `scrollTop = 0`: only a gesture tells
 * the feed that the reader, not layout, is moving the view.
 */

const TOTAL = 130;
const PAGE_SIZE = 50;
const SEED_CONCURRENCY = 10;
const SMOKE_PASSWORD = 'smoke-pass-123';
/** The longest any single condition below is waited on. */
const WAIT_MS = 15_000;
/** Fifty rows of about 150 px are 19 turns of the wheel; this is the bound, not the pace. */
const MAX_WHEEL_TURNS = 60;
/** How often one message may be refused by the limiter before the spec gives up. */
const MAX_LIMITER_RETRIES = 3;
/** What the app itself may ask of the limiter between seeding and the end of the spec. */
const PAGE_LOAD_REQUESTS = 150;
/** A prepended page may not move the row the reader was looking at by more than this. */
const MAX_JUMP_PX = 4;
const BASE_TIMESTAMP = 1_700_000_000_000;
const OLDER_PAGES_PATTERN = '**/api/chats/*/messages?*';

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
 * is `expected`, and fails as `expected last message visible: msg-130 |
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
  }).toPass({ timeout: WAIT_MS });
}

/** Moves the pointer over the transcript and turns the wheel: a reader's gesture. */
async function wheel(page: Page, deltaY: number): Promise<void> {
  const box = await page.locator(FEED).boundingBox();
  if (!box) throw new Error(`expected transcript: visible | received: ${FEED} not found`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, deltaY);
}

/**
 * What the API's per-IP limiter last reported. This spec posts well over a
 * hundred messages, and the limiter is shared by every spec of the suite and by
 * the page itself: a burst that leaves nothing behind turns the next page load
 * into a 429 (the transcript fails to load and the chat shows its empty state),
 * in this spec or in whichever runs after it.
 */
const limiter = { remaining: Number.POSITIVE_INFINITY, resetsAtMs: 0 };

function noteLimiter(response: APIResponse): void {
  const headers = response.headers();
  const remaining = Number(headers['x-ratelimit-remaining']);
  const resetsAtMs = Number(headers['x-ratelimit-reset']) * 1000;
  if (Number.isNaN(remaining) || Number.isNaN(resetsAtMs)) return;
  // Concurrent responses arrive out of order: within one window the lowest count is the truth.
  limiter.remaining =
    resetsAtMs > limiter.resetsAtMs ? remaining : Math.min(limiter.remaining, remaining);
  limiter.resetsAtMs = Math.max(limiter.resetsAtMs, resetsAtMs);
}

/** Waits for the limiter's window to reopen when fewer than `requests` are left in it. */
async function awaitLimiterHeadroom(requests: number): Promise<void> {
  if (limiter.remaining >= requests) return;
  const reopensInMs = limiter.resetsAtMs - Date.now() + 250;
  if (reopensInMs > 0) await new Promise((resolve) => setTimeout(resolve, reopensInMs));
  limiter.remaining = Number.POSITIVE_INFINITY;
}

async function createChat(page: Page, title: string): Promise<string> {
  const created = await page.request.post('/api/chats', { data: { title } });
  noteLimiter(created);
  expect(created.ok(), `expected chat create: 2xx | received: ${created.status()}`).toBe(true);
  const { id } = (await created.json()) as { id: string };
  // A chat with no working directory opens a folder picker over the rail.
  const bound = await page.request.put(`/api/chats/${id}`, { data: { workdir: tmpdir() } });
  noteLimiter(bound);
  expect(bound.ok(), `expected workdir bind: 2xx | received: ${bound.status()}`).toBe(true);
  return id;
}

/**
 * Stores one message through the API, waiting out the per-IP limiter instead of
 * failing on it.
 */
async function postMessage(page: Page, chatId: string, position: number): Promise<void> {
  for (let refused = 0; refused <= MAX_LIMITER_RETRIES; refused++) {
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
    noteLimiter(response);
    if (response.ok()) return;
    if (response.status() !== 429) {
      throw new Error(`expected ${label(position)} stored: 2xx | received: ${response.status()}`);
    }
    // The limiter says when its window reopens; that is the condition waited on.
    const retryAfterSeconds = Number(response.headers()['retry-after'] ?? 1);
    await new Promise((resolve) => setTimeout(resolve, Math.max(1, retryAfterSeconds) * 1000));
  }
  throw new Error(
    `expected ${label(position)} stored within ${MAX_LIMITER_RETRIES} limiter windows | received: 429 each time`
  );
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

/**
 * Holds every request for an older page until `release()` is called, and says
 * when one is in flight. The reader's view is then still while the page is
 * fetched, so what moves when it lands is the prepend and nothing else.
 */
function holdOlderPages(page: Page) {
  let held: Route | null = null;
  const handler = (route: Route) => {
    if (!route.request().url().includes('cursor=')) return route.continue();
    held = route;
    return Promise.resolve();
  };
  return {
    install: () => page.route(OLDER_PAGES_PATTERN, handler),
    requested: () => held !== null,
    async release() {
      const route = held;
      held = null;
      await route?.continue();
    },
    uninstall: () => page.unroute(OLDER_PAGES_PATTERN, handler),
  };
}

type OlderPageHold = ReturnType<typeof holdOlderPages>;

/**
 * Turns the wheel up until the transcript asks for an older page, or there is
 * none to ask for because the first message is already in view.
 */
async function scrollUpUntilRequested(page: Page, hold: OlderPageHold): Promise<void> {
  for (let turn = 0; turn < MAX_WHEEL_TURNS && !hold.requested(); turn++) {
    const view = await readView(page);
    if (visibleLabels(view).includes(label(1))) return;
    if ((view?.scrollTop ?? 1) <= 0) break;
    const before = view?.scrollTop ?? 0;
    await wheel(page, -400);
    await expect
      .poll(
        async () => hold.requested() || ((await readView(page))?.scrollTop ?? before) !== before,
        { message: 'expected the wheel to move the transcript up', timeout: WAIT_MS }
      )
      .toBe(true);
  }
  await expect
    .poll(async () => hold.requested() || visibleLabels(await readView(page)).includes(label(1)), {
      message:
        'expected an older page requested at the top of the loaded rows | received: no request',
      timeout: WAIT_MS,
    })
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
 * 130-message chat behind, and another spec running in parallel (workers are not
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
  noteLimiter(signup);
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
  noteLimiter(setup);
  expect(setup.ok(), `expected first-run setup: 2xx | received: ${setup.status()}`).toBe(true);
  return context;
}

test('a 130-message chat opens on its newest messages and loads older ones on demand', async ({
  browser,
}, testInfo) => {
  // Above the sum of the waits that can really stack: two limiter windows
  // (before seeding and before opening, about a minute each), the open, three
  // older pages (a request and a landing each) and the refetch, every one of
  // them capped at WAIT_MS: 2 x 61 + 8 x 15 = 242 s. Each wheel turn between
  // them resolves in milliseconds, or fails by name at the cap.
  test.setTimeout(300_000);
  const run = `${Date.now()}-${testInfo.repeatEachIndex}`;
  const context = await newSignedInContext(browser, run);
  try {
    await readTranscriptNewestFirst(await context.newPage(), run);
  } finally {
    await context.close();
  }
});

async function readTranscriptNewestFirst(page: Page, run: string): Promise<void> {
  const title = `Transcript paging ${run}`;
  const otherTitle = `Transcript paging other ${run}`;

  const chatId = await createChat(page, title);
  await createChat(page, otherTitle);
  await awaitLimiterHeadroom(TOTAL + PAGE_LOAD_REQUESTS);
  await seedMessages(page, chatId, 1, TOTAL);
  await awaitLimiterHeadroom(PAGE_LOAD_REQUESTS);

  await page.goto('/');
  await openChat(page, title);

  // The reader lands on the end of the conversation, not on its first page.
  await expectEdgeVisible(page, 'last', label(TOTAL), 'on open');
  const opened = await readView(page);
  expect(
    opened?.rendered.length,
    `expected rows rendered on open: <= ${PAGE_SIZE} | received: ${opened?.rendered.length}`
  ).toBeLessThanOrEqual(PAGE_SIZE);
  expect(
    visibleLabels(opened).includes(label(1)),
    `expected first message loaded on open: no | received: ${label(1)} is in the viewport`
  ).toBe(false);

  // Read back one page at a time. Each older page is held in flight while the
  // reader is still, so the row they were looking at before it lands is the
  // reference for where it must be after.
  let pagesPrepended = 0;
  const hold = holdOlderPages(page);
  await hold.install();
  while (!visibleLabels(await readView(page)).includes(label(1))) {
    await scrollUpUntilRequested(page, hold);
    if (!hold.requested()) break;

    const anchor = (await readView(page))?.visible[0];
    if (!anchor) throw new Error('expected a row in the viewport | received: none');
    const stopTrace = await traceRow(page, anchor.text);
    await hold.release();
    await expect
      .poll(
        async () =>
          (await readView(page))?.visible.find((row) => row.text === anchor.text)?.index ?? -1,
        {
          message: `expected ${anchor.text} to move down when an older page lands`,
          timeout: WAIT_MS,
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
    expect(pagesPrepended, 'expected pages prepended: <= 3').toBeLessThanOrEqual(3);
  }
  await hold.uninstall();

  // Everything is loaded: each rendered row sits at the index its text says,
  // so a duplicate or a gap anywhere shows up as a row in the wrong place.
  await expectEdgeVisible(page, 'first', label(1), 'at the top');
  const reached = new Set<string>();
  for (let step = 0; step < 60; step++) {
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
        timeout: WAIT_MS,
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
}
