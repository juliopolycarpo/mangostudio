/**
 * Raised when a machine's runtime does not advertise `features.library`, so
 * none of the library RPCs can be asked at all. Lives in `domain` for the same
 * reason `LibraryRequestError` does: the library service and the probing
 * service both raise it, and the probing service cannot import the library
 * service without closing a cycle.
 */

export class LibraryFeatureUnavailableError extends Error {
  readonly code = 'LIBRARY_FEATURE_UNAVAILABLE' as const;
  constructor(message: string) {
    super(message);
    this.name = 'LibraryFeatureUnavailableError';
  }
}
