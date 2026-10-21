import type { Connector } from '@mangostudio/shared/connectors';

/**
 * A connector the hub supplies to everyone (no owner) rather than one read from
 * this machine's config file or environment: the user cannot delete it from here.
 */
export function isReadOnlySharedConnector(connector: Connector): boolean {
  return (
    connector.userId === null &&
    connector.source !== 'config-file' &&
    connector.source !== 'environment'
  );
}
