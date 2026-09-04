# Environment Manager

MangoStudio can tell a non-expert what their machine is missing, install or update it with one
click on Linux, macOS and Windows, and make sure the toolchain it chose is the one every spawned
process actually runs with: the shell tool, the terminal, vendor agent CLIs and the installers
themselves. The surface lives under **Environments** and describes whichever machine the
`environmentId` search param names; the hub's own machine is `local`.

## Where things run

| Concern                                                                 | Owner                    |
| ----------------------------------------------------------------------- | ------------------------ |
| Detecting toolchains, version managers and agent CLIs                   | Runtime (`apps/runtime`) |
| Building the environment a spawned process starts with (`spawn-env.ts`) | Runtime (`apps/runtime`) |
| Storing and validating the per-environment toolchain selection          | Hub (`apps/api`)         |
| Recipes, guards, audit rows, prerequisite findings, the setup checklist | Hub (`apps/api`)         |
| Rendering cards, the picker and the checklist                           | Frontend                 |

## Setup checklist

Environments → Overview opens with a **Setup** section for people who do not know what a
version manager is. Each row is a finding with the remedy that clears it:

- Git installed (on Windows, `git.install.windows` runs `winget install --id Git.Git`);
- a Node LTS that is neither below MangoStudio's floor nor past its support window;
- Bun, marked optional;
- at least one agent CLI installed **and signed in**;
- the hub running as a user service, on the Local environment only.

Nothing here adds an endpoint. The section reads the same queries the Toolchains, Agents and
This machine tabs already own, so the checklist cannot disagree with `mangostudio doctor`.

## Toolchain selection

Every environment carries a selection, `{ node: 'auto' | <path>, bun: 'auto' | <path> }`,
stored in `environment_toolchains` keyed by `(userId, environmentId)`. The Local environment is
virtual, so `local` is a sentinel key here exactly as it is for install runs, and there is no
foreign key to `environments`. Deleting an environment removes its row in the same transaction.

- `PUT /api/environments/:id/toolchain` writes one or both fields. A path is accepted only when
  the environment's own probe reported an installation at exactly that path; anything else is
  a 422 that names the expected values and the received one. An environment that cannot be
  probed answers 503.
- Every listed environment includes its `toolchain`; absent reads as `auto` for both.
- The Toolchains tab offers **Use this version** on every Node and Bun installation and **Back
  to automatic** once one is pinned; the effective line says what spawned processes run with.

The hub resolves the selection and sends it on every spawn method — `shell.run`,
`install.run`, `terminal.open` and `external-agent.open`. The runtime's `spawn-env.ts` builds
the base environment once per spawn: at most one directory per runtime is put first on `PATH`,
plus `NVM_DIR`, `FNM_DIR` or `BUN_INSTALL` when the directory came from that manager and the
variable was not already set. Each consumer then applies its own secret policy on top.

`auto` means "what a login shell would see", computed without executing any profile: nvm's
`default` alias (including `lts/*` chains and the listing-based aliases `node`, `stable` and a
bare major), then fnm's `default` alias, then the well-known directories the scanner already
knows. On Windows that includes `%ProgramFiles%\nodejs`, because the Node MSI edits the machine
`PATH` and a runtime that is already running never sees that edit. A selection is omitted for
a runtime whose manifest does not advertise `features.toolchain`; such a peer keeps its own
`PATH` exactly as before.

## What the scanner knows

Each installation carries a `pathSource`: `nvm`, `fnm` and `volta` come from the
version-manager classification (fnm's Windows default root `%APPDATA%\fnm` and macOS root are
recognised without `FNM_DIR`); `bun` is Bun's own installer; `winget` is not visible by path,
because winget's MSI and the nodejs.org MSI both land in `Program Files\nodejs`, so a Windows
probe asks `winget list --id OpenJS.NodeJS.LTS --exact` once per scan and marks the match. A
probe that times out leaves the installation as `system`; the exit-code allowlist on the winget
recipes makes an install offered on top of a winget Node harmless.

`git`, `fnm` and `winget` are probed as runtimes (`winget` only on Windows targets). fnm is also
a version manager with the same status shape as nvm: managed versions, the `default` alias, the
current version and LTS status per version. Cursor's CLI is found under its current binary name
`agent` as well as the older `cursor-agent`.

A `prerequisite-missing` finding names a recipe this machine would offer and the tool it needs
but does not have. Nothing installs winget itself, so its remedy is a link to App Installer on
the Microsoft Store, rendered with the copy-only shape rather than a run button. A remedy is a
bare URL and never a sentence: it is interpolated into a localized finding message, so prose put
there would reach a pt-BR reader in English, and the frontend only renders a remedy as a
followable link when the whole value is a URL.

## Recipes

The recipe table is described in [`environment-installs.md`](../architecture/environment-installs.md).
What matters for this page:

- **Windows Node** defaults to winget's `OpenJS.NodeJS.LTS` (install and upgrade; the `.LTS`
  package tracks the current LTS *line*, so an upgrade crosses majors when Node promotes a new
  one). **fnm** is the second, helper-managed Node manager: installed through winget on Windows,
  driven on every platform through `fnm install` and `fnm default` only — never `fnm use`, which
  needs a shell hook a service-launched runtime would not see. Every other Node installation
  (nvm-windows, Volta, a nodejs.org MSI, Scoop, mise) is detected, never managed: the card lists
  it with its source and its update action is copy-only.
- **Update and uninstall** exist for Bun, Claude Code, Codex and Cursor. A recipe MangoStudio runs
  must have a vendor-documented shape; Codex and Cursor do not document an uninstall, so those two
  are listed as copy-only commands with the reason beside them. A runnable uninstall is offered
  only when the binary that actually runs is one the recipe's own `writes` cover — the file it
  deletes, or a file inside a directory it deletes. A Homebrew Bun or a package-managed `claude` is
  detected and updated, never uninstalled from here, because that step would remove a different
  installation (or none) and still report success. Copy-only uninstalls stay visible whatever the
  provenance: they remove nothing themselves. Bun's uninstall removes the **default** root
  (`~/.bun`) and proves a `bin/bun` is inside it first; `$BUN_INSTALL` is deliberately not expanded,
  because it is a prefix rather than the Bun directory and a machine pointing it at a shared
  location would turn the step into a delete of that whole tree. Tracked in #1011.
- **Chains**: "Install Node" on a POSIX machine without nvm runs nvm first, then Node, then sets
  the default, with one confirmation listing every step and one console per step. On Windows the
  default chain is one step; the fnm alternative is three.

## CLI mirror

`mangostudio env install <recipe>` and `mangostudio env update <recipe>` call the same install
service and stream the same log to the terminal, and `mangostudio env toolchain` reads or writes
the same selection as the picker, for people on SSH. See [`cli.md`](../reference/cli.md).

## Deferred

Node managers beyond winget LTS and fnm (nvm-windows v2 once it has a winget id, a POSIX
`fnm.install`, detect-only classification for Scoop and mise) are tracked in
[#1011](https://github.com/juliopolycarpo/mangostudio/issues/1011).
