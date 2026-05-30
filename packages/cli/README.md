# @mangostudio/cli

Install [MangoStudio](https://github.com/juliopolycarpo/mangostudio) — an
AI-powered image generation and chat studio — as a single command.

## Install

```bash
npm install -g @mangostudio/cli
# or: bun add -g @mangostudio/cli
```

This pulls the prebuilt standalone binary for your platform (via a
platform-specific optional dependency) and puts `mangostudio` on your PATH.
No Node.js or Bun runtime is required to run it.

## Usage

`mangostudio` is a CLI that manages one local server:

```bash
mangostudio serve [port]   # run in the foreground (default port 3001)
mangostudio serve -d       # run in the background (logs to ~/.mango/logs/)
mangostudio status         # show the running instance
mangostudio stop           # graceful shutdown
mangostudio doctor         # environment diagnostics
```

Run `mangostudio` with no arguments for the full command list.

Configure it with environment variables:

| Variable         | Purpose                                                    |
| ---------------- | ---------------------------------------------------------- |
| `GEMINI_API_KEY` | Google Gemini API key (required)                           |
| `API_PORT`       | Port to listen on (default: `3001`)                        |
| `DATABASE_PATH`  | SQLite database path (default: `~/.mango/database.sqlite`) |
| `UPLOADS_DIR`    | Upload directory (default: `~/.mango/uploads`)             |

The database is created and migrated automatically on first run.

## Supported platforms

`linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, `win32-x64`,
`win32-arm64`. Other targets (including musl builds) are available as direct
downloads on the [releases page](https://github.com/juliopolycarpo/mangostudio/releases).

## License

MIT
