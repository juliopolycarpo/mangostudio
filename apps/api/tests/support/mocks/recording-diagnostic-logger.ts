/**
 * A diagnostic logger that keeps what it was given, so a test can assert a
 * failure was logged without depending on `MANGOSTUDIO_DIAGNOSTIC_LOGS`.
 */

import type { DiagnosticLogger, LogLevel, LogMetadata } from '../../../src/lib/logger';

export interface RecordedLogEntry {
  readonly level: LogLevel;
  readonly event: string;
  readonly metadata: LogMetadata;
}

/**
 * @example
 * const logger = new RecordingDiagnosticLogger();
 * logger.warn('failed', { error });
 * expect(logger.events('warn')).toEqual(['failed']);
 */
export class RecordingDiagnosticLogger implements DiagnosticLogger {
  readonly entries: RecordedLogEntry[] = [];

  debug(event: string, metadata: LogMetadata = {}): void {
    this.entries.push({ level: 'debug', event, metadata });
  }

  info(event: string, metadata: LogMetadata = {}): void {
    this.entries.push({ level: 'info', event, metadata });
  }

  warn(event: string, metadata: LogMetadata = {}): void {
    this.entries.push({ level: 'warn', event, metadata });
  }

  error(event: string, metadata: LogMetadata = {}): void {
    this.entries.push({ level: 'error', event, metadata });
  }

  /** The events logged at one level, in order. */
  events(level: LogLevel): string[] {
    return this.entries.filter((entry) => entry.level === level).map((entry) => entry.event);
  }
}
