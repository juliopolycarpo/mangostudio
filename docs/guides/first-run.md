# First run

Everything below is optional. MangoStudio works if you skip all of it — the
setup flow exists so that nobody has to *guess* what to configure first, not to
gate the application behind a form.

## From an installed binary to a browser

```bash
mangostudio setup
```

One command takes a fresh install to a working hub:

1. generates and stores a `BETTER_AUTH_SECRET` if none is configured;
2. asks whether to install the background service (see below);
3. starts the hub, or reuses one that is already running;
4. opens it in a browser and prints the address.

A hub that is already serving is never restarted. A state file left behind by a
crashed one is cleared and replaced.

**On a machine with no display** — over SSH, in a container, on a headless
server — nothing pretends to open a browser. The address is printed along with a
port-forward line:

```
MangoStudio is running at http://localhost:3001
No browser can be opened from here. Open that address on this machine, or
forward the port: ssh -L 3001:localhost:3001 <this-host>
```

**In a script**, `--service` or `--no-service` is required. Installing a service
unit is a change to the machine that outlives the command, so with nobody at the
keyboard the answer is refused rather than assumed in either direction:

```bash
mangostudio setup --no-service --no-open
```

`--no-open` prints the URL instead of opening anything.

## The setup flow in the browser

The first time you sign in, MangoStudio opens **Setup** instead of the chat
page. It has six steps, all of which can be skipped, and none of which is the
only way to do what it does.

| Step           | What it asks                                                    |
| -------------- | --------------------------------------------------------------- |
| **Welcome**    | Nothing. It says where things run and what you are choosing.    |
| **Folder**     | Which project the agent reads and edits.                        |
| **Toolchain**  | Whether Node or Bun is on the machine, and installs one if not. |
| **Agents**     | Who answers: a model with your API key, or an agent CLI here.   |
| **Always on**  | Whether the hub should survive logout and reboot.               |
| **First chat** | One real question, in the folder you chose.                     |

Progress belongs to your account, not to the browser: closing the tab and
coming back resumes where you were, on any device.

### What "resume" actually means

The flow does not remember which step you were on. It reads what the machine
says *now* and opens at the first question still unanswered. So:

- delete the folder you chose, and it reopens at **Folder**;
- sign an agent CLI out, and it reopens at **Agents**;
- install Node from somewhere else, and **Toolchain** is simply done.

A request that has not answered yet reads as *Checking*, never as *not done* —
a slow network cannot drag you backwards through steps you finished.

### Skipping

**Skip for now** marks one step as skipped and moves on. **Skip setup** records
the whole flow as finished and takes you to the page you were originally
heading for. Neither sends a message or creates a chat.

To go through it again: **Settings → General → Run setup again**. That clears
the progress record and nothing else — your chats, your vendor sign-ins and
your machine settings stay exactly as they are.

## Steps that cannot be done from where you are

Two steps depend on *where the browser is*, not on the account:

- **Always on** installs a service unit for the hub's own process. If you opened
  MangoStudio from another computer — or the platform has no per-user service
  manager — the step says so and gives you the command to run there instead.
- **Agents** offers the agent CLIs installed on the machine you chose. Those
  sign in with the vendor's own account, in a terminal on that machine;
  MangoStudio never sees those credentials and never asks for them.

## A second person on the same hub

Agent CLI sign-ins on the Local machine belong to the operating-system account
the hub runs as. Once a second MangoStudio account exists on the same hub, those
sign-ins stop being offered — they are not the second person's to use, and
MangoStudio will not pretend they are by sharing one vendor account between two
users.

The second person's options are to use a model provider key, or to add a machine
of their own from **Environments**, which gives them their own isolated agent
sign-ins. The setup flow says this in the **Agents** step rather than showing a
runner that every send would refuse.

## The first chat

The last step creates one chat in the folder you chose, pointed at the runner
you chose, and sends the message in the box. It is always an explicit click —
nothing is sent by arriving at the step.

Two things it deliberately will not do:

- **Create a second chat.** The chat reference is saved the moment creation
  returns, before anything is sent. Reloading mid-flight reopens that chat.
- **Send the same prompt twice.** Before sending, it re-reads the transcript; a
  prompt that is already there means the send was accepted and only the answer
  was lost, so it waits rather than asking again.

A chat existing is not evidence that anything answered. The step is only done
once the transcript actually carries a reply — or once you skip it.

If the runner is an agent CLI you have not used before, the third-party notice
appears here, and the workspace-trust question appears the first time a vendor
is pointed at a folder. Both are the same dialogs the composer raises, answered
once.
