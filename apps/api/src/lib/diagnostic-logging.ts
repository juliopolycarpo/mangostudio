/**
 * Lets automation trim chatty diagnostic logs without changing production
 * behavior or weakening error handling.
 */
export function shouldEmitDiagnosticLogs(): boolean {
  return process.env.MANGOSTUDIO_DIAGNOSTIC_LOGS !== '0';
}
