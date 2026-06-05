import { shouldEmitDiagnosticLogs } from './diagnostic-logging';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogMetadata = Record<string, unknown>;

export interface DiagnosticLogger {
  debug(event: string, metadata?: LogMetadata): void;
  info(event: string, metadata?: LogMetadata): void;
  warn(event: string, metadata?: LogMetadata): void;
  error(event: string, metadata?: LogMetadata): void;
}

interface LogEntry {
  level: LogLevel;
  scope: string;
  event: string;
  ts: number;
  metadata: LogMetadata;
}

/**
 * Creates a gated structured diagnostic logger for one subsystem.
 * Usage: const logger = createDiagnosticLogger('auth'); logger.warn('request');
 */
export function createDiagnosticLogger(scope: string): DiagnosticLogger {
  return {
    debug: (event, metadata) => logDiagnostic('debug', scope, event, metadata),
    info: (event, metadata) => logDiagnostic('info', scope, event, metadata),
    warn: (event, metadata) => logDiagnostic('warn', scope, event, metadata),
    error: (event, metadata) => logDiagnostic('error', scope, event, metadata),
  };
}

/**
 * Emits one structured diagnostic log entry when diagnostics are enabled.
 * Usage: logDiagnostic('warn', 'request', 'received', { method: 'GET' });
 */
export function logDiagnostic(
  level: LogLevel,
  scope: string,
  event: string,
  metadata: LogMetadata = {}
): void {
  if (!shouldEmitDiagnosticLogs()) return;
  writeLog({ level, scope, event, ts: Date.now(), metadata: normalizeMetadata(metadata) });
}

function normalizeMetadata(metadata: LogMetadata): LogMetadata {
  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => [key, normalizeValue(value)])
  );
}

function normalizeValue(value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (typeof value === 'bigint') return value.toString();
  return value;
}

function writeLog(entry: LogEntry): void {
  const line = JSON.stringify(entry);
  if (entry.level === 'error') {
    console.error(line);
    return;
  }
  console.warn(line);
}
