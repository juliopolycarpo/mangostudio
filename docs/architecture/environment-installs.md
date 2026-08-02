# Environment Install Security

MangoStudio can install or update supported runtimes and agent CLIs from its authenticated API.
This is an intentionally narrow execution surface: requests select a code-owned recipe rather
than supplying a command.

## Enabling Installs

Environment installs are disabled by default. Enable them with either:

```toml
[environments]
installs_enabled = true
```

or:

```sh
MANGO_ENV_INSTALLS_ENABLED=true
```

Enable this only for a MangoStudio process running on the same machine as its user. The setting
does not override the local-surface checks below.

## Guard Model

Every recipe preview reports whether execution is allowed and, when it is not, every reason that
blocked it. Which conditions apply depends on which machine the install would run on, because the
two questions are genuinely different.

### The hub's own machine (`local`)

- The server binds to a loopback address, unless it is a standalone binary launched by the user.
- The request's socket peer is loopback. Forwarded client-IP headers are never trusted for this
  decision.
- The process is not running in a container. `/.dockerenv` and `MANGO_CONTAINER` both block
  installs; the result is resolved once into `environments.container` by
  `apps/api/src/lib/config.ts`, so it is visible wherever configuration is reported.
- Environment installs are explicitly enabled.

### Any other environment

The loopback checks are **not reused**. They ask "is the person driving this hub sitting at the
machine that would be written to", and for a remote environment the answer is no by construction —
applying them would refuse every remote install for a reason that names the wrong machine.

What replaces them:

- Environment installs are explicitly enabled (the same global switch).
- The environment carries `allowInstalls`, a per-environment opt-in stored in the `environments`
  table and off on arrival. It is a column rather than part of the transport config because it is
  the hub's policy about a machine, not part of how to reach one.

**Two gates, intersected, and a refusal always names which side said no.**
`environment-not-trusted` and `disabled` are different switches in different places; someone who
flips one has to be told when the other is still closed. The toggle lives on the environment's card
under Environments.

Blocked recipes remain useful: the response includes a shell command the user can review, copy,
and run themselves — on the machine it names.

## Recipe Boundary

Recipe IDs, platforms, expected writes, network use, timeouts, environment overrides, and argv
builders are code constants in
`apps/api/src/modules/environments/domain/install-recipes.ts`. The API accepts only the closed
recipe-ID union.

Most recipes accept no input. The two nvm version operations accept only `lts`, `latest`, or one
to three numeric version components. The value is revalidated at the recipe boundary and passed
as a positional argument to constant shell source; it is never interpolated into that source.
nvm is loaded directly from its detected `nvm.sh`, so the user's login profile is not executed.

## Downloaded Installers

Official script installers have a prepare step before execution:

1. Fetch the code-owned HTTPS URL through `apps/api/src/lib/safe-fetch.ts`, allowing only HTTPS
   redirects. Every hop, including the first, is checked against the same address policy used for
   provider base URLs, so a hijacked installer host cannot redirect the server onto a loopback,
   private, unique-local, or link-local endpoint.
2. Stream the response through a size bound before allocating the complete body.
3. Reject empty or implausibly small responses, oversized responses, HTML, and content without a
   shell shebang.
4. Store the bytes in a temporary file and return the resolved origin URL, byte size, and SHA-256
   digest for confirmation.
5. Bind that temporary artifact to the authenticated user, recipe, and validated input for ten
   minutes. Starting a different request cannot reuse it.
6. Execute the local file as `bash <file>` or `sh <file>` and remove it when the run finishes.

MangoStudio never pipes a live network response into a shell.

## Where Execution Happens

The hub decides *whether*; the runtime does the spawning. `install.run` carries an argv the hub
already built from a code-defined recipe — nothing is interpolated on the far side — and the child's
output travels back on the `install.output` `evt` stream keyed by the run id. The hub relays those
frames onto the SSE stream a browser reads, so the browser contract is unchanged in shape; only the
host that produced the bytes moved.

Two records, two owners, deliberately: the audit row, the recipe resolution, the TTL and the
decision to run at all stay hub-side, while the bounded raw log is written on the machine that
produced it. Cancellation crosses as `install.cancel` rather than a signal, because the child
belongs to the other side.

Recipes are platform-checked against the **runtime's** platform, not the hub's. A Linux recipe is
offerable from a Windows hub when the environment is a WSL distribution; that is the point.

## Execution Limits

The runtime uses `Bun.spawn(argv)` with stdin disabled and stdout/stderr piped. It forwards only
the runtime path/home/temp/XDG variables, proxy variables, and the small set of code-owned
recipe overrides needed by nvm — read from *its* environment, not the hub's. Connector tokens, API
keys, GitHub tokens, and other credential variables are withheld.

Each run has:

- a recipe-specific timeout followed by `SIGKILL`;
- explicit cancellation through the cancel endpoint, and only that. A run outlives the request
  that started it, so closing the page or dropping the log stream never kills an installer
  mid-write;
- a combined one-MiB output and log-file cap with a truncation event;
- one active process per recipe ID, with same-user duplicate requests attaching to that run;
- raw line-by-line SSE output, followed by refreshed runtime, version-manager, or agent status;
- a user-scoped audit record containing the exact argv, timestamps, terminal status, exit code,
  and truncation state.

Audit metadata is stored in `environment_install_runs` on the hub. Bounded logs are written by the
machine that ran the installer: `~/.mango/logs/installs/<runId>.log` on the hub's own machine, and
under the runtime's own home elsewhere.

## Shell Profiles and Recovery

MangoStudio does not directly edit `.bashrc`, `.zshrc`, or another shell startup file. An official
third-party installer may do so as part of its documented behavior. The automatic nvm recipe
sets `PROFILE=/dev/null` to suppress that mutation. Bun and nvm recipe previews instead return
their canonical profile lines, whether the complete block is already present, and the profile
paths where it was detected. This lets the UI offer an inspectable copy action without returning
unrelated profile contents or modifying a file.

Third-party installers are not transactional. Cancellation, timeout, or failure can leave a
partial tool installation, and MangoStudio does not claim to roll it back. The audit record and
bounded raw log are the source of truth for diagnosis and recovery with the tool's own
instructions.

A run is `running` only while the process that spawned it holds it in memory. If the server stops
mid-install, the row is settled as `interrupted` on the next read — not `failed`, because the
installer may well have completed. The replay of a finished run always ends with a terminal
event, so a reconnecting client never waits on a stream that has nothing left to send.

## API Surface

- `GET /api/environments/install/recipes` previews recipes and guard results. Takes an optional
  `environmentId` query parameter; omitted means the hub's own machine.
- `POST /api/environments/install/prepare` fetches and inspects a script installer. Takes an
  optional `environmentId` in the body.
- `POST /api/environments/install` starts or attaches to a run. Takes an optional `environmentId`
  in the body.
- `GET /api/environments/install/:runId/log` streams run events as SSE.
- `POST /api/environments/install/:runId/cancel` requests cancellation.
- `GET /api/environments/install/runs` returns the authenticated user's audit history.
