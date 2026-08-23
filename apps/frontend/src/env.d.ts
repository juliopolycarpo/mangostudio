/**
 * Ambient module declarations for non-TS imports the bundler resolves.
 *
 * `vite/client` used to supply these (plus an `import.meta.env` shape). Under
 * `Bun.build()` an imported asset still resolves to its emitted URL, and
 * `import.meta.env` is typed by Bun's own ambient types — only the asset and
 * CSS module shapes need declaring here.
 */

declare module '*.png' {
  const url: string;
  export default url;
}

declare module '*.css' {}
