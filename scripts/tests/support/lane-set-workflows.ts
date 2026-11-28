// Workflow text shared by the policy tests that pin the light lane set's wiring.

// GitHub expression opener, assembled out of band so the literal `${{` never
// appears in a plain string (Bun's no-template-curly-in-string would flag it).
const EXPR = '$' + '{{';

/**
 * The `matrix.os` line of a job that runs on Ubuntu alone in the light lane set
 * and on all three hosted OSes otherwise. Cargo Shim's `workspace` job and
 * Protocol CI's `rust` and `interop` jobs use it verbatim.
 */
export const LANE_SET_OS_MATRIX = `os: ${EXPR} fromJSON(needs.changes.outputs.lane_set == 'light' && '["ubuntu-latest"]' || '["ubuntu-latest","macos-latest","windows-latest"]') }}`;

/** The step that asks scripts/ci/lane-mode.ts for the run's lane set. */
export const LANE_SET_STEP_RUN =
  'run: bun ./scripts/ci/lane-mode.ts "$RUNNER_TEMP/changed-files" >> "$GITHUB_OUTPUT"';

/** Environment every lane-set step receives: event facts only, never `github.actor`. */
export const LANE_SET_STEP_ENV = [
  `EVENT_NAME: ${EXPR} github.event_name }}`,
  `PR_AUTHOR: ${EXPR} github.event.pull_request.user.login }}`,
  `HEAD_REPO: ${EXPR} github.event.pull_request.head.repo.full_name }}`,
  `BASE_REPO: ${EXPR} github.repository }}`,
  `PR_NUMBER: ${EXPR} github.event.pull_request.number }}`,
  `GH_TOKEN: ${EXPR} github.token }}`,
] as const;
