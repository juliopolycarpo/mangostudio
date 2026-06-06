import { ERROR_CODES } from '@mangostudio/shared/errors';

export class ConnectorNotFoundError extends Error {
  readonly code = ERROR_CODES.NOT_FOUND;
  readonly status = 404;

  constructor() {
    super('Connector not found.');
    this.name = 'ConnectorNotFoundError';
  }
}

export class ConnectorOwnershipError extends Error {
  readonly code = ERROR_CODES.OWNERSHIP;
  readonly status = 403;

  constructor() {
    super('Cannot delete a shared connector.');
    this.name = 'ConnectorOwnershipError';
  }
}
