#!/usr/bin/env bash
# Render a per-channel publish status table into the GitHub step summary, naming
# the job to re-run for any channel that did not succeed. Each argument is
# "<job-id>=<result>" where result is a needs.<job>.result value (success,
# failure, cancelled, skipped). Used by release.yml and canary.yml so a partial
# failure is obvious and a maintainer can re-run just the failed job.
#
# Optional auth/provenance env (never print tokens):
#   NPM_PUBLISH_AUTH, NPM_PUBLISH_PROVENANCE, NPM_CHANNEL_NAME, CARGO_PUBLISH_AUTH
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

has_auth_section=0
if [ -n "${NPM_PUBLISH_AUTH:-}" ] || [ -n "${NPM_PUBLISH_PROVENANCE:-}" ] || [ -n "${CARGO_PUBLISH_AUTH:-}" ]; then
  has_auth_section=1
fi

if [ "$has_auth_section" = "1" ]; then
  {
    echo
    echo "### Auth and provenance"
    echo
    echo "| Channel | Auth | Provenance |"
    echo "| --- | --- | --- |"
  } >>"$summary"

  if [ -n "${NPM_PUBLISH_AUTH:-}" ] || [ -n "${NPM_PUBLISH_PROVENANCE:-}" ]; then
    echo "| \`${NPM_CHANNEL_NAME:-npm-publish}\` | ${NPM_PUBLISH_AUTH:-—} | ${NPM_PUBLISH_PROVENANCE:-—} |" >>"$summary"
  fi
  if [ -n "${CARGO_PUBLISH_AUTH:-}" ]; then
    echo "| \`cargo-publish\` | ${CARGO_PUBLISH_AUTH} | — |" >>"$summary"
  fi
fi

if [ "$failed" = "1" ]; then
  {
    echo
    echo "> One or more channels failed. Re-run only the failed job(s) above —"
    echo "> already-published channels are idempotent and skip on re-run."
  } >>"$summary"
fi
