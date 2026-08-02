/** Injectable platform inputs for resolving user-owned runtime and library paths. */
export interface PathEnv {
  readonly platform: string;
  readonly homeDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /**
   * Root a `workspace`-scoped library location resolves under. Reserved: absent
   * until workspace locations exist, and a resolver that needs it must return
   * null when it is missing rather than falling back to `homeDir`.
   */
  readonly workspaceRoot?: string;
}
