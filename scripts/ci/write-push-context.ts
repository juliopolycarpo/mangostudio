#!/usr/bin/env bun
import { writeFileSync } from 'node:fs';

import { parseCanaryPushContext } from '../lib/canary-promotion';
import { requiredEnv } from '../lib/runner';

const context = {
  repository: requiredEnv('REPO'),
  event: requiredEnv('EVENT_NAME'),
  ref: requiredEnv('EVENT_REF'),
  before: process.env.PUSH_BEFORE ?? '',
  after: process.env.PUSH_AFTER ?? '',
};
if (context.event === 'push' && context.ref === 'refs/heads/main') {
  parseCanaryPushContext(JSON.stringify(context), context.repository, requiredEnv('SOURCE_SHA'));
}
writeFileSync('ci-push-context.json', `${JSON.stringify(context, null, 2)}\n`);
