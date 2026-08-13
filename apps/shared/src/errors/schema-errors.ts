/**
 * JSON-pointer locations for TypeBox schema violations.
 *
 * TypeBox reports Ajv-shaped errors: `required` and `additionalProperties` both
 * point at the *container* and name the offending keys in `params`, rather than
 * pointing at the property itself. Rendering `instancePath` alone would collapse
 * `/config/extra` into `/`, which is the difference between a maintainer reading
 * a red CI job and finding the bad key, and re-reading the whole payload by eye.
 *
 * These helpers exist so every consumer renders the same pointer. The rejected
 * value is deliberately never included: these strings reach logs and API error
 * bodies, and a rejected payload can carry credentials.
 */

import type { TLocalizedValidationError } from 'typebox/error';

/** The single key a container-level violation is actually about, if there is one. */
const offendingProperty = (error: TLocalizedValidationError): string | undefined => {
  if (error.keyword === 'required') return error.params.requiredProperties[0];
  if (error.keyword === 'additionalProperties') return error.params.additionalProperties[0];
  return undefined;
};

/**
 * The failing location as a JSON pointer, narrowed to the offending property
 * where the error names one. The document root renders as `/`.
 */
export const schemaErrorPointer = (error: TLocalizedValidationError): string => {
  const property = offendingProperty(error);
  const pointer = property ? `${error.instancePath}/${property}` : error.instancePath;
  return pointer || '/';
};

/**
 * `<pointer>: <message>` for the first violation in an exhaustive error list.
 *
 * Call this only after `Value.Check` has already failed; `Value.Errors` walks
 * the whole value and is wasted work on a payload that passes.
 */
export const describeSchemaError = (
  errors: readonly TLocalizedValidationError[],
  fallback: string
): string => {
  const first = errors.at(0);
  return first ? `${schemaErrorPointer(first)}: ${first.message}` : fallback;
};
