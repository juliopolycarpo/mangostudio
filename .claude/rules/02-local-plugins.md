# Local Plugins

Private Claude Code marketplace under `.claude/marketplaces/mangostudio-local/`.
All plugins enabled in `.claude/settings.json` and shadow upstream `typescript-lsp` / `web-lsp`.

| Plugin                   | Binary                       | Handles                                                      | Surfaces                                                                                                                                       |
| ------------------------ | ---------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `mangostudio-tsgo-lsp`   | `tsgo` (`node_modules/.bin`) | `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs` | Full code intelligence: `hover`, `goToDefinition`, `findReferences`, `goToImplementation`, `documentSymbol`, `workspaceSymbol`, call hierarchy |
| `mangostudio-biome-lsp`  | `biome lsp-proxy`            | `.js/.ts/.jsx/.tsx`, `.json`, `.jsonc`, `.css`, `.html`      | Diagnostics and quick-fixes. Navigation methods return `Method not found` — expected                                                           |
| `mangostudio-dprint-lsp` | `dprint lsp`                 | `.md`, `.mdx`, `.toml`, `.yml`, `.yaml`                      | Formatting diagnostics only. No navigation methods                                                                                             |

## Hooks

- `SessionStart` / `CwdChanged` — `.claude/hooks/session-path.sh` prepends `node_modules/.bin` to `PATH`.
- `PostToolUse` on `Edit|Write|MultiEdit` — `.claude/hooks/auto-fix.sh` auto-formats the touched file.

## Troubleshooting

```bash
bun run check                              # toolchain sanity
node_modules/.bin/tsgo --version           # tsgo binary
node_modules/.bin/biome --version          # biome binary
node_modules/.bin/dprint --version         # dprint binary
```

If a binary is missing, run `bun install`. If a plugin is not loading, check `enabledPlugins` in `.claude/settings.json` and reload with `/reload-plugins`.
