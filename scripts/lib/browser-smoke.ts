export const BROWSER_SMOKE_BROWSER = 'chromium';

export const BROWSER_SMOKE_SETUP_COMMAND = [
  'bunx',
  'playwright',
  'install',
  '--with-deps',
  BROWSER_SMOKE_BROWSER,
] as const;

export const BROWSER_SMOKE_TEST_COMMAND = ['bunx', 'playwright', 'test'] as const;
