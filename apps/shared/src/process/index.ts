/**
 * Starting a child process on the machine this code runs on.
 *
 * Both the hub and a runtime spawn children — `git`, a vendor CLI, an
 * installer — and both must spawn them the same way: hidden on Windows, and
 * without the parent's secrets in the environment. Neither rule is derivable
 * from a call site, and a child the hub started that ignores one is exactly as
 * wrong as one a runtime started.
 *
 * Framework-agnostic and free of Node builtins. The probe that has to read a
 * real PATH lives behind `@mangostudio/shared/process/host`.
 */

export * from './shell-env';
export * from './spawn-window';
