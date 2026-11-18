#!/bin/bash
# Cheap fakes for the commands the workflow's teardown and precheck loops run
# dozens of times: ss, sleep, and `docker|podman ps|rm`. Materialize this file
# as each of those names in a fake PATH, next to fake-smoke-workflow-command.ts
# installed as `fake-smoke-workflow-command`.
#
# Why this exists: a Bun script costs tens of milliseconds to start, and a run
# whose port never frees (the `ports` failure) walks every 20-iteration loop to
# the end, about 140 fake invocations. Under host load that start-up cost, not
# any wait the workflow asked for, ate the whole test budget. Bash handles the
# hot commands in a few milliseconds; everything else is handed to the Bun fake.
#
# `sleep` is the fake clock: it records the call and returns at once, so the
# loops advance by iteration count and never by wall time.
set -u

command="${0##*/}"
fake_dir="${0%/*}"

case "$command:${1:-}" in
  ss:* | sleep:* | docker:ps | docker:rm | podman:ps | podman:rm) ;;
  *)
    FAKE_SMOKE_WORKFLOW_COMMAND="$command" exec "$fake_dir/fake-smoke-workflow-command" "$@"
    ;;
esac

events="${FAKE_SMOKE_WORKFLOW_EVENTS:-}"
state="${FAKE_SMOKE_WORKFLOW_STATE:-}"
if [ -z "$events" ] || [ -z "$state" ]; then
  echo "Invalid fake workflow paths: events [$events], state [$state]; expected writable events and state paths" >&2
  exit 70
fi

args_json=""
for arg in "$@"; do
  escaped=${arg//\\/\\\\}
  escaped=${escaped//\"/\\\"}
  args_json+="${args_json:+,}\"$escaped\""
done
printf '{"command":"%s","args":[%s]}\n' "$command" "$args_json" >>"$events"

case "$command" in
  sleep) ;;
  docker | podman)
    if [ "$1" = rm ]; then
      rm -f -- "$state/${*: -1}"
    else
      filter=""
      previous=""
      for arg in "$@"; do
        if [ "$previous" = --filter ]; then filter="${arg/name=/}"; fi
        previous="$arg"
      done
      for entry in "$state"/*; do
        [ -e "$entry" ] || continue
        name="${entry##*/}"
        if [[ $name == *"$filter"* ]]; then echo "$name"; fi
      done
    fi
    ;;
  ss)
    filter_text="$*"
    names_13002=0
    names_13001=0
    [[ $filter_text == *13002* ]] && names_13002=1
    [[ $filter_text == *13001* ]] && names_13001=1
    fail="${FAKE_SMOKE_WORKFLOW_FAILURE:-}"
    # A container that is still up holds its published port, like docker-proxy.
    published=0
    for entry in "$state"/*-13002; do
      [ -e "$entry" ] && published=1
    done
    if { [ "$fail" = ports ] || [ "$published" = 1 ]; } && [ "$names_13002" = 1 ]; then
      echo 'LISTEN 0 128 127.0.0.1:13002 0.0.0.0:*'
    fi
    # docker-proxy can hold the port for a moment after `docker rm -f` returns:
    # the first two probes of 13002 still see it, every later one finds it free.
    if [ "$fail" = slow-port ] && [ "$names_13002" = 1 ]; then
      probes=0
      while IFS= read -r line; do
        if [[ $line == *'"command":"ss"'* && $line == *13002* ]]; then probes=$((probes + 1)); fi
      done <"$events"
      if [ "$probes" -le 2 ]; then echo 'LISTEN 0 128 127.0.0.1:13002 0.0.0.0:*'; fi
    fi
    # A native hub that outlived its smoke: only a filter naming 13001 sees it.
    if [ "$fail" = native-port ] && [ "$names_13001" = 1 ]; then
      echo 'LISTEN 0 128 127.0.0.1:13001 0.0.0.0:*'
    fi
    ;;
esac
exit 0
