// Leveled console logging for the script runners.
// Plain ANSI colors only — these are user-facing CLI messages, not structured logs.

export const RESET = '\x1b[0m';
export const BOLD = '\x1b[1m';
export const RED = '\x1b[31m';
export const GREEN = '\x1b[32m';
export const YELLOW = '\x1b[33m';
export const CYAN = '\x1b[36m';
export const DIM = '\x1b[2m';

export function log(msg: string): void {
  console.log(msg);
}
export function info(msg: string): void {
  console.log(`${CYAN}${msg}${RESET}`);
}
export function success(msg: string): void {
  console.log(`${GREEN}${BOLD}${msg}${RESET}`);
}
export function warn(msg: string): void {
  console.log(`${YELLOW}${msg}${RESET}`);
}
export function error(msg: string): void {
  console.error(`${RED}${BOLD}${msg}${RESET}`);
}
export function dim(msg: string): void {
  console.log(`${DIM}${msg}${RESET}`);
}
export function header(msg: string): void {
  console.log(`\n${BOLD}${msg}${RESET}`);
}
