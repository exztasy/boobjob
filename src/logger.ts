export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const SEVERITY: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export interface Logger {
  debug(message: string, ...details: unknown[]): void;
  info(message: string, ...details: unknown[]): void;
  warn(message: string, ...details: unknown[]): void;
  error(message: string, ...details: unknown[]): void;
}

export function isLogLevel(value: string): value is LogLevel {
  return value in SEVERITY;
}

export function createLogger(level: LogLevel = 'info'): Logger {
  const threshold = SEVERITY[level];
  const emit =
    (name: Exclude<LogLevel, 'silent'>, sink: (...args: unknown[]) => void) =>
    (message: string, ...details: unknown[]): void => {
      if (SEVERITY[name] < threshold) return;
      sink(`${new Date().toISOString()} ${name.toUpperCase().padEnd(5)} ${message}`, ...details);
    };

  return {
    debug: emit('debug', console.debug),
    info: emit('info', console.info),
    warn: emit('warn', console.warn),
    error: emit('error', console.error),
  };
}
