/** Injectable platform inputs for resolving user-owned runtime and library paths. */
export interface PathEnv {
  readonly platform: string;
  readonly homeDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}
