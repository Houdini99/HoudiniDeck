import { styleText } from 'node:util';

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const COLORS: Record<Level, Parameters<typeof styleText>[0]> = {
  debug: 'gray',
  info: 'cyan',
  warn: 'yellow',
  error: 'red',
};
const threshold = LEVELS[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? LEVELS.info;
const tty = process.stdout.isTTY;

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export function createLogger(tag: string): Logger {
  const write = (level: Level, args: unknown[]) => {
    if (LEVELS[level] < threshold) return;
    const time = new Date().toTimeString().slice(0, 8);
    const label = level.toUpperCase().padEnd(5);
    const prefix = tty ? `${styleText('gray', time)} ${styleText(COLORS[level], label)} ${styleText('bold', `[${tag}]`)}` : `${label} [${tag}]`;
    (level === 'error' || level === 'warn' ? console.error : console.log)(prefix, ...args);
  };
  return {
    debug: (...a) => write('debug', a),
    info: (...a) => write('info', a),
    warn: (...a) => write('warn', a),
    error: (...a) => write('error', a),
  };
}

/** Logger that swallows everything; handy in tests. */
export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
