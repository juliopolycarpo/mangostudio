/** A real module with two exports, for tests of `module-mocks.ts` to fake and restore. */
export function subjectGreeting(): string {
  return 'real greeting';
}

export function subjectFarewell(): string {
  return 'real farewell';
}
