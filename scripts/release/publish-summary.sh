#!/usr/bin/env bash
# Render a per-channel publish status table into the GitHub step summary, naming
# the job to re-run for any channel that did not succeed. Each argument is
# "<job-id>=<result>" where result is a needs.<job>.result value (success,
# failure, cancelled, skipped). Used by release.yml and canary.yml so a partial
# failure is obvious and a maintainer can re-run just the failed job.
#
# Usage: TITLE="Release 0.1.0" publish-summary.sh "docker=success" "npm-publish=failure"
set -euo pipefail

summary="${GITHUB_STEP_SUMMARY:-/dev/stdout}"
title="${TITLE:-Publish summary}"

{
  echo "## ${title}"
  echo
  echo "| Channel | Status |"
  echo "| --- | --- |"
} >>"$summary"

failed=0
for pair in "$@"; do
  job="${pair%%=*}"
  result="${pair#*=}"
  case "$result" in
    success) status="✅ success" ;;
    skipped) status="⏭️ skipped" ;;
    cancelled) status="🚫 cancelled" ;;
    *)
      status="❌ ${result} — re-run the \`${job}\` job"
      failed=1
      ;;
  esac
  echo "| \`${job}\` | ${status} |" >>"$summary"
done

if [ "$failed" = "1" ]; then
  {
    echo
    echo "> One or more channels failed. Re-run only the failed job(s) above —"
    echo "> already-published channels are idempotent and skip on re-run."
  } >>"$summary"
fi
