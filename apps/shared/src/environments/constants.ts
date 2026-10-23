/** Environment identity and limits shared by schemas and lightweight consumers. */

export const LOCAL_ENVIRONMENT_ID = 'local' as const;

/**
 * Name the hub reports for the machine it runs on. Not user copy: it is the
 * environment's name in the API the same way a remote's stored name is, and
 * surfaces that render it inside a translated sentence resolve it from
 * {@link LOCAL_ENVIRONMENT_ID} through i18n instead of printing this.
 */
export const LOCAL_ENVIRONMENT_NAME = 'Local' as const;

/**
 * How many mounts one environment may declare.
 *
 * A bound rather than a policy: each entry is an argv pair the hub constructs,
 * and an unbounded list is an unbounded command line. Eight is well past what
 * "the project, and maybe its cache" needs.
 */
export const CONTAINER_MAX_MOUNTS = 8;
