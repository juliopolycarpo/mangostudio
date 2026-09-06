/**
 * Text imports of the two install scripts, embedded into the hub binary so
 * `mangostudio upgrade` runs the same bytes the release ships. Only
 * `modules/updates/infrastructure/embedded-installers.ts` may import them.
 */
declare module '*.sh' {
  const text: string;
  export default text;
}

declare module '*.ps1' {
  const text: string;
  export default text;
}
