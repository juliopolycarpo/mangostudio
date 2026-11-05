#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';

import { renderCanaryPromotionSummary } from '../lib/canary-promotion-summary';
import { requiredEnv } from '../lib/runner';

const summary = renderCanaryPromotionSummary(
  JSON.parse(requiredEnv('CANARY_NEEDS_JSON')),
  requiredEnv('WORKFLOW_REVISION'),
  requiredEnv('CANARY_RUN_URL')
);
appendFileSync(requiredEnv('GITHUB_STEP_SUMMARY'), summary);
