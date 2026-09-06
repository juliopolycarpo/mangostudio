# Remote runtimes (connect and serve)

## Onboard a new machine

**Environments → Add environment → “Set up a new machine…”** walks a box you can
reach over SSH from nothing to a working environment. Everything it does is
something the environment card can also do one button at a time; the flow exists
because doing them in the right order, once, is the hard part.

You need: a host you can already `ssh` into (its key in your `known_hosts` —
MangoStudio will not accept an unknown one for you), and Linux or macOS on the
far side. Windows is not an SSH target; pair it from its own card instead.

### The one decision

| End state    | How MangoStudio reaches it                         | Needs                              |
| ------------ | -------------------------------------------------- | ---------------------------------- |
| **Over SSH** | Starts the runtime with your ssh client, each time | Nothing else                       |
| **Paired**   | The machine dials MangoStudio and stays connected  | `server.publicUrl`, a user service |

Pick **paired** for a box behind a router or firewall, or when MangoStudio moves
between networks. Pick **SSH** when neither is true — there is no service to keep
alive and nothing runs on that machine in between.

The paired flow stops at this step if `publicUrl` is unset, because the machine
would have nowhere to dial. Set it under `[server]` in `config.toml` (or
`PUBLIC_URL`) and come back.

### What runs on the machine

The SSH end state pushes the runtime and then runs `setup` with the permissions
you chose. The paired end state does four things over one ssh channel:

1. pushes the matching runtime into `~/.mango/runtime/remote/` and publishes
   `current`, verifying the release checksum first;
2. runs `setup` with your permissions, recorded on that machine;
3. runs `connect --hub <publicUrl> --token -` once, long enough to store the hub
   URL and a pairing token, then stops it — **the token is piped in on stdin and
   is in no command line on either side**;
4. runs `service install --mode connect`, with `XDG_RUNTIME_DIR` supplied
   because a non-interactive ssh session has none (see
   [No session bus](#no-session-bus-ssh-one-liners)).

Your ssh credentials are used for that run and are not stored: after it, the
machine reaches MangoStudio rather than the other way round. That is also why
re-entering the flow for a half-onboarded paired machine asks for them again.

### When step 4 does not work

`service install` is the step most likely to fail, and it fails for local
reasons — linger needing root, a distro without a user session bus. The flow
treats that as a **degraded success** and says so: the machine is provisioned,
consented and holds a working credential, and one of these finishes it there.

```bash
# after fixing whatever the console reported
~/.mango/runtime/remote/current/mangostudio-runtime service install --mode connect
# or, to run it now without a service
~/.mango/runtime/remote/current/mangostudio-runtime connect
```

Neither needs flags — the hub URL and token are already stored. The full path is
not decoration: the flow installs into the managed slot and never puts the
binary on `PATH`, so a bare `mangostudio-runtime` is `command not found` on a
machine this flow onboarded.

### Leaving early, and coming back

There are no wizard tables. The environment row is the only thing the flow
creates, and every step is safe to repeat: a push with matching bytes is a
no-op, `setup` is re-runnable, `service install` converges. Closing the flow
leaves a normal environment card with its usual actions, and reopening it works
out the first unfinished step from the runtime's own health, its consent, and
whether anything has been probed.

### Auditing it afterwards

Everything above ran on your machine on your credentials. To see what was
recorded there, on that machine:

```bash
cd ~/.mango/runtime/remote/current
./mangostudio-runtime health              # slot, version, digest, profile, permissions
./mangostudio-runtime setup --slot remote # review or narrow the permissions
./mangostudio-runtime service status      # paired machines only
./mangostudio-runtime audit --since 24h   # if the slot records one
```

The summary at the end of the flow prints these with the runtime's own reported
path already filled in, so copying them from there needs no `cd`.

## Connect and serve

Dial-in environments keep a `mangostudio-runtime` process on another machine.
Two transports share one `remote` slot under `~/.mango/runtime/remote/`:

- **connect** — the runtime dials your hub (`mangostudio-runtime connect`).
- **serve** — the hub dials the runtime (`mangostudio-runtime serve`).

Both read pairing or serve credentials from `credentials.json` and non-secret
settings from `runtime.json`. A user-level service can keep either mode running
across logout and reboot without leaving a terminal open.

## Service commands

```bash
mangostudio-runtime service install --mode connect
mangostudio-runtime service install --mode serve
mangostudio-runtime service uninstall
mangostudio-runtime service status [--json]
mangostudio-runtime service start
mangostudio-runtime service stop
mangostudio-runtime service restart
```

`install` writes a **user** unit (no root for the unit itself):

| OS      | Unit location                                                 |
| ------- | ------------------------------------------------------------- |
| Linux   | `~/.config/systemd/user/mangostudio-runtime.service`          |
| macOS   | `~/Library/LaunchAgents/com.mangostudio.runtime.plist`        |
| Windows | Scheduled Task `MangoStudio runtime` (Task Scheduler owns it) |

The unit runs `~/.mango/runtime/remote/current/mangostudio-runtime` with only the
subcommand (`connect` or `serve`) — no hub URL, listen address, or tokens on the
command line. Configure those first:

- **connect** — run `connect` once so `hubUrl` and a pairing token are stored.
- **serve** — run `serve --listen <host:port>` once so `serveListen` and a serve
  token are stored.

`install` refuses when setup is still `pending` or the chosen mode was never
configured, and names the missing step.

### The binary has to live in the slot

`current` is published by an install — `mangostudio-runtime install`, a push over
ssh, a WSL provision, or an upgrade from the environment card. A binary you
downloaded by hand and ran from your home directory works fine for `setup`,
`connect` and `serve`, but it never puts anything in the slot on its own, so
`current` does not exist yet.

`service install` refuses in that state rather than writing a unit that would
fail to start at every boot, and `doctor` reports the same gap as a `fail`. Both
name the command that fixes it:

```bash
mangostudio-runtime install          # copies this binary into ~/.mango/runtime/remote
mangostudio-runtime setup --slot remote
mangostudio-runtime connect --hub wss://hub.example.com/api/runtime
mangostudio-runtime service install
```

`install` keeps the version it replaced, because a running service is still
executing out of it, and removes everything older.

`status --json` returns a stable document for environment cards (`schemaVersion`,
`installed`, `enabled`, `running`, optional `linger` and `execUsesCurrent`).

### Linux: systemd user units and linger

After writing the unit, the CLI runs:

```bash
systemctl --user daemon-reload
systemctl --user enable --now mangostudio-runtime.service
loginctl enable-linger "$USER"
```

User services stop when you log out unless **linger** is enabled for your
account. The CLI attempts `loginctl enable-linger` automatically. When that
needs root, it prints the exact line to run:

```bash
sudo loginctl enable-linger $USER
```

`Restart=on-failure` lets a completed runtime self-update (exit code `75`) come
back on the binary behind `current`.

#### No session bus (SSH one-liners)

`systemctl --user` and `loginctl` need `XDG_RUNTIME_DIR` and
`DBUS_SESSION_BUS_ADDRESS`. A non-interactive `ssh host command` often omits
both, and service commands refuse with a distinct error. Prefix the command:

```bash
XDG_RUNTIME_DIR=/run/user/$(id -u) mangostudio-runtime service status
```

Use a login shell or export `DBUS_SESSION_BUS_ADDRESS` when your distro requires
it.

#### No systemd

Linux without systemd user services is unsupported — there is no alternate
user-level supervisor in the CLI. Install and manage the unit yourself or keep
the process in `tmux`/`screen`.

### macOS: launchd LaunchAgent

The CLI uses modern verbs only:

```bash
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.mangostudio.runtime.plist
launchctl kickstart -k gui/$UID/com.mangostudio.runtime
launchctl bootout gui/$UID/com.mangostudio.runtime   # uninstall
```

`KeepAlive` restarts the job after crashes with a throttle interval.

### Windows: from a download to a supervised runtime

Windows is not an SSH target, so nothing pushes a runtime there for you. The
whole flow runs on the machine itself, from the `mangostudio-runtime.exe` you
downloaded:

```powershell
.\mangostudio-runtime.exe install
mangostudio-runtime setup --slot remote
$env:MANGOSTUDIO_RUNTIME_TOKEN='<token from the environment card>'
mangostudio-runtime connect --hub wss://hub.example.com/api/runtime
mangostudio-runtime service install --mode connect
```

`install` copies the binary into `%USERPROFILE%\.mango\runtime\remote\<version>\`
and points `current` at it as a **directory junction**, which needs no elevation
and no Developer Mode. A file symlink would need one of the two, and a `.cmd`
shim would put `cmd.exe` between the supervisor and the runtime.

From then on the environment card can upgrade it in place like any other peer:
new bytes land in a new version directory beside the running one, the junction
moves, and the runtime exits `75` for its supervisor to restart. The version it
came from is kept until the upgrade after that, because Windows will not delete a
directory holding a running executable.

`service install` registers a per-user **Scheduled Task** named
`MangoStudio runtime` through PowerShell — no admin, and the same preconditions
as Linux and macOS: setup answered, the chosen mode configured, and a binary
published at `current`.

```powershell
mangostudio-runtime service status --json
```

What the CLI registers:

- **Trigger** `-AtLogOn` for the current user. There is no Windows analogue of
  linger: the task starts when you sign in and runs in that session, so a machine
  nobody has logged into is not serving.
- **Principal** `-LogonType Interactive -RunLevel Limited` — the task borrows the
  interactive session's token, so no password is stored and none has to be
  re-entered after a password change.
- **Settings** no execution time limit (the default three days would stop the
  runtime on the fourth), `-MultipleInstances IgnoreNew`, `-StartWhenAvailable`,
  the battery flags, and `-RestartCount 3 -RestartInterval 1 minute`. That last
  pair is what brings the runtime back on new bytes after a live update: the
  wrapper propagates the runtime's exit code, and `75` is a failure as far as
  Task Scheduler is concerned. One minute is its minimum interval, so expect the
  card to show the peer disconnected for about that long after a commit.
- **Action** a hidden `powershell.exe` wrapper that invokes the binary. The
  wrapper is where a unit's environment, working directory and log redirection
  would be set; the runtime's unit asks for none of the three, so it is a bare
  invocation.

Task Scheduler captures no output of its own, and the runtime's task does not
redirect any, so there is no Windows equivalent of
`journalctl --user -u mangostudio-runtime.service`. Use `mangostudio-runtime health`
and the environment card on the hub to tell whether it is connected.

`service status` reads the task back with `Get-ScheduledTask` and reports the same
`installed` / `enabled` / `running` triple as the other platforms; `running` means
the task state is `Running`. `uninstall` stops and unregisters it.

## Doctor

`mangostudio-runtime doctor` checks the user service **only** for the `remote`
slot when connect or serve is configured. Hub-spawned stdio, WSL, and SSH
runtimes are not expected to have a unit; doctor skips them instead of reporting
“not installed” as a defect.

For in-scope slots, doctor reports installed, enabled, running, linger (Linux),
whether the unit still references `current`, and whether a binary is actually
reachable through it.

Where `service install` cannot help, doctor does not name it as the fix:

- **No user-level supervisor** — Linux without systemd, or a platform with no
  backend at all: one warning saying to supervise the runtime yourself, with no
  command to run. Windows is not in this bucket any more; doctor names
  `service install` there exactly as it does on Linux and macOS.
- **No session bus** — systemctl can be asked nothing, so doctor says it could
  not read the service and gives you the `XDG_RUNTIME_DIR` prefix rather than
  reporting a running unit as missing.
- **Any other supervisor error** — doctor reports what the supervisor said
  instead of calling an unreadable unit "not installed".

## See also

- [`docs/reference/cli.md`](../reference/cli.md) — full `mangostudio-runtime` flags
- [`docs/architecture/hub-runtime.md`](../architecture/hub-runtime.md) — slot layout and `current`
