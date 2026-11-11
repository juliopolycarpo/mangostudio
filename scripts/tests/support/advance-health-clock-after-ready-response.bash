# Keep real curl I/O while controlling the shell clock used for admission.
: "${MANGO_TEST_HEALTH_READY_MARKER:?expected a path for the completed response}"
unset SECONDS
SECONDS=0

sleep() {
  # The retry advances one clock tick without waiting for the scheduler.
  if [ "$1" = '1' ]; then
    SECONDS=$((SECONDS + 1))
  else
    command sleep "$@"
  fi
}

curl() {
  command curl "$@" || return "$?"
  : > "$MANGO_TEST_HEALTH_READY_MARKER"
}

advance_health_clock_after_ready_response() {
  if [ -f "$MANGO_TEST_HEALTH_READY_MARKER" ]; then
    SECONDS=3
  fi
}

# Observe the completed response in the parent shell after curl's substitution.
set -T
trap advance_health_clock_after_ready_response DEBUG
