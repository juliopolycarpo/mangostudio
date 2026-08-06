/**
 * The two commands the hub runs over ssh to make a machine dial in by itself.
 *
 * They are the whole backend surface onboarding adds: everything else it does —
 * pushing the binary, recording consent, probing — already exists and is called
 * unchanged. Both follow this module's standing rule that a script is a
 * code-defined constant and every value travels as argv (`$1`…) or on stdin,
 * so nothing a user typed is ever concatenated into shell text.
 */

/**
 * Resolves the runtime path into `$1` and expands a leading `~/` the way the
 * login shell would for an ssh launch. Shared with the `setup` invocation so a
 * custom path is expanded identically by every command the hub sends.
 */
// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion on the target, not a JS placeholder
export const RESOLVE_RUNTIME_PATH = 'p="$1"; case "$p" in "~/"*) p="$HOME/${p#"~/"}" ;; esac; ';

/**
 * How long the bootstrap lets `connect` run before stopping it, in whole
 * seconds. It only has to outlast a cold binary start writing two files; the
 * service unit is what keeps the process alive afterwards.
 */
const CONNECT_BOOTSTRAP_SECONDS = 8;

/** How long a `TERM` gets to be honoured before the bootstrap stops asking. */
const CONNECT_STOP_SECONDS = 5;

/**
 * Runs `connect` just long enough for it to store the hub URL and the pairing
 * token, then stops it.
 *
 * `connect` never returns on its own — it dials and serves until killed — but
 * it writes `hubUrl` and the credential *before* its first dial, and those two
 * files are exactly what `service install --mode connect` refuses without. So
 * the bootstrap is a bounded run, not a supervised one.
 *
 * Three details are load-bearing:
 *
 * - **The token arrives on stdin**, never in argv: a command line is readable by
 *   every process on the machine.
 * - **`exec 3<&0` then `<&3`.** A background command in a shell without job
 *   control gets `/dev/null` on stdin (POSIX 2.9.3.1), and a plain `<&0` does
 *   not reliably override it — dash still substitutes `/dev/null`, so the token
 *   silently never arrives. Duplicating onto another descriptor first does.
 * - **The loop exits early when the process dies.** A refused token or a pending
 *   consent makes `connect` exit within a second, and breaking out lets its own
 *   status and stderr propagate instead of being masked by the timed kill.
 * - **The stop is bounded and ends in `kill -9`.** `wait` on a process that does
 *   not act on `TERM` blocks for as long as that process feels like running,
 *   which would turn a bootstrap into a hang and then a timeout. Nothing may
 *   outlive this run either: an orphaned `connect` would redial on the same
 *   credential and fight the service unit for the socket.
 * - **Its output goes to a file, replayed on stderr at the end.** `ssh` closes
 *   the channel when the last holder of the command's pipes lets go, not when
 *   the command exits — so a backgrounded process (or anything it spawned)
 *   writing to the inherited descriptors keeps the session open long after this
 *   script is done. Redirecting first, replaying last, keeps every diagnostic
 *   and still returns promptly.
 */
export function buildConnectBootstrapCommand(
  binaryPath: string,
  hubEndpoint: string
): { readonly script: string; readonly args: readonly string[] } {
  return {
    script: `${RESOLVE_RUNTIME_PATH}
log=$(mktemp 2>/dev/null || echo "/tmp/mangostudio-connect.$$")
exec 3<&0
"$p" connect --hub "$2" --token - <&3 >"$log" 2>&1 &
pid=$!
exec 3<&-
n=0
while [ "$n" -lt ${CONNECT_BOOTSTRAP_SECONDS} ]; do
  kill -0 "$pid" 2>/dev/null || break
  n=$((n + 1))
  sleep 1
done
if kill -0 "$pid" 2>/dev/null; then
  kill "$pid" 2>/dev/null
  n=0
  while [ "$n" -lt ${CONNECT_STOP_SECONDS} ]; do
    kill -0 "$pid" 2>/dev/null || break
    n=$((n + 1))
    sleep 1
  done
  kill -9 "$pid" 2>/dev/null
  status=0
else
  wait "$pid"
  status=$?
fi
cat "$log" >&2
rm -f "$log"
exit "$status"`,
    args: [binaryPath, hubEndpoint],
  };
}

/**
 * Installs the user-level service that keeps `connect` running.
 *
 * A non-interactive ssh session has no session bus, and `systemctl --user`
 * cannot be asked anything without one — so the runtime refuses with a typed
 * error naming the `XDG_RUNTIME_DIR` prefix. This applies that prefix up front
 * rather than making the user read the refusal and paste the fix back.
 *
 * `DBUS_SESSION_BUS_ADDRESS` is set **only when the bus socket is actually
 * there**. Exporting it unconditionally would satisfy the runtime's
 * session-bus check with an address nothing is listening on, trading a precise
 * refusal that names its own fix for whatever systemd says about a socket that
 * does not exist. Both variables are left alone when the session already
 * carries them; on macOS neither is consulted and the launchd path ignores them.
 *
 * `--mode connect` stays in the script text because it is a constant: this
 * command exists only for the paired end state, which is a `connect` unit by
 * definition.
 */
export function buildServiceInstallCommand(binaryPath: string): {
  readonly script: string;
  readonly args: readonly string[];
} {
  return {
    script: `${RESOLVE_RUNTIME_PATH}
u=$(id -u)
: "\${XDG_RUNTIME_DIR:=/run/user/$u}"
export XDG_RUNTIME_DIR
if [ -z "\${DBUS_SESSION_BUS_ADDRESS:-}" ] && [ -S "$XDG_RUNTIME_DIR/bus" ]; then
  DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
  export DBUS_SESSION_BUS_ADDRESS
fi
exec "$p" service install --mode connect`,
    args: [binaryPath],
  };
}
