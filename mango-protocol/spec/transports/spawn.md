# Transport: spawn

A launcher starts a child process and speaks [stdio](stdio.md) through its pipes. SSH, WSL and
container launches are this transport with a different argv in front: the far process still
reads stdin and writes stdout, and nothing about framing, handshake or teardown changes.

## Launching

- The command is an argv array, never a shell string. Arguments that come from configuration
  or from a user are data at every layer.
- The child's environment is sanitised: a launcher passes an explicit allowlist (`PATH`,
  `HOME`, locale, temp dirs) plus what the application adds on purpose, and strips
  secret-shaped variables (`*_TOKEN`, `*_SECRET`, `*_KEY`, `*PASSWORD*`) unless the application
  adds them back explicitly.
- stdout is the frame stream; stdin is the frame stream in the other direction; stderr is
  captured into a bounded tail (16 KiB is the reference size).
- **stderr is bytes, and is decoded as UTF-8 lossily.** A child writes whatever its logger and
  its runtime's own diagnostics produce, and a tail cut at a byte budget routinely ends mid
  sequence. A launcher MUST NOT refuse a child, or lose the rest of a tail, because some of it
  did not decode: undecodable bytes become the replacement character and the tail is reported
  anyway. The tail exists to be pasted into a bug report; it is never parsed.
- The launcher waits for the child's `hello` with a timeout. The reference budgets are 5 seconds
  for a local child and 20 seconds through a wrapper that has to open a network connection or
  start a container first.

## Failure to start

The launcher reports one message that names the next step, built from what it can observe: the
spawn error code (`ENOENT`, `EACCES`), the exit status if the child already exited, and the
stderr tail. A wrapper that knows more than the launcher (that `ssh` reports every failure of
its own as exit `255`, that a login shell says `127` for a missing command) supplies its own
classifier; the launcher exposes the observations and does not guess.

## Termination

The sequence starts when the launcher closes the port and equally when the port closes on its
own (a refused line, a child that ended its stdout): the launcher owns the child's lifetime
either way.

1. Close the child's stdin. A conforming peer treats end of file as the session ending and
   exits on its own.
2. After a grace period (2 seconds reference), send `SIGTERM`.
3. After a second grace period, send `SIGKILL`.
4. Resolve once the child has exited, or after a bounded deadline (2 seconds reference, timed
   from the last kill request), so a shutdown is delayed by an unkillable child but never
   blocked by one. A launcher that gives up reports that the child had not exited; it does not
   invent an exit status.

Windows has no POSIX signals: step 2 and 3 collapse into terminating the process. Descendants
the child spawned are not reached; the child's own cancellation path is what reaps them.

## SSH preset

The SDK ships the argv for launching a peer over the system `ssh` client:

```text
ssh -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15
    -o ServerAliveCountMax=3 -o StrictHostKeyChecking=yes
    -o ControlMaster=no -o ControlPath=none -o RemoteCommand=none
    [-o IdentitiesOnly=yes -i <identityFile>] [-p <port>]
    -T -- <[user@]host> '<remotePath>' <remoteArgs…>
```

Every option is load-bearing:

- `BatchMode=yes`: nothing on the launching side can answer a prompt; a connection that would
  ask must fail instead of hanging until the handshake times out.
- `StrictHostKeyChecking=yes`, set explicitly: an unknown host key is refused, never accepted;
  the first trust decision belongs to a person at a terminal.
- `ControlMaster=no`, `ControlPath=none`: multiplexing is unsupported on Windows OpenSSH and
  ambient configuration could otherwise enable it under a long-lived pipe.
- `RemoteCommand=none`: a `RemoteCommand` in the user's ssh configuration collides with the
  command placed after the destination (`Cannot execute command-line and remote command.`), so
  the preset forces it off rather than inherit it.
- `-T`: no pseudo-terminal, because stdout carries frames a tty would translate.
- `--` ends option parsing before the destination, and the preset refuses a host or user
  beginning with `-`, so a host spelled `-oProxyCommand=…` cannot become an option.
- The remote path is single-quoted because `ssh` joins everything after the destination with
  spaces and hands it to the target's login shell. A leading `~/` is left outside the quotes so
  the shell expands it.

Targets are POSIX hosts. The launching side may be any platform with an `ssh` client on `PATH`.
