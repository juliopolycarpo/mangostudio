#!/usr/bin/env bun

import {
  canaryCargoVersion,
  canaryReleaseVersion,
  rootReleaseVersion,
} from '../lib/release-version';
import { error } from '../lib/runner';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function resolveIdentity(): {
  readonly version: string;
  readonly channel: string;
  readonly cargoVersion: string;
} {
  const event = requiredEnv('EVENT_NAME');
  const sha = requiredEnv('SOURCE_SHA').toLowerCase();
  if (!/^[a-f0-9]{7,64}$/.test(sha)) throw new Error(`Invalid SOURCE_SHA: ${sha}`);

  if (event === 'push') {
    return {
      version: canaryReleaseVersion(sha),
      channel: 'canary',
      cargoVersion: canaryCargoVersion(),
    };
  }

  const suffix = `g${sha.slice(0, 7)}`;
  if (event === 'pull_request') {
    const prNumber = requiredEnv('PR_NUMBER');
    if (!/^\d+$/.test(prNumber)) throw new Error(`Invalid PR_NUMBER: ${prNumber}`);
    return {
      version: `${rootReleaseVersion()}-pr.${prNumber}.${suffix}`,
      channel: 'pr',
      cargoVersion: canaryCargoVersion(),
    };
  }

  return {
    version: `${rootReleaseVersion()}-ci.${suffix}`,
    channel: 'ci',
    cargoVersion: canaryCargoVersion(),
  };
}

try {
  const identity = resolveIdentity();
  process.stdout.write(
    `version=${identity.version}\nchannel=${identity.channel}\ncargo_version=${identity.cargoVersion}\n`
  );
} catch (caught) {
  error(caught instanceof Error ? caught.message : String(caught));
  process.exit(1);
}
