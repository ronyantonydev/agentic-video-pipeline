/**
 * Minimal structured logger. No dependency - stderr for diagnostics,
 * stdout stays clean for machine-readable CLI output.
 *
 * When a project is attached, every line is also appended to
 * `projects/<name>/logs/run.log`. Terminal output scrolls away; a bug report
 * that says "shot 7 looks wrong" is unanswerable without a record of what
 * actually ran, in what order, with which decisions.
 *
 * The file always receives DEBUG-level detail regardless of `LOG_LEVEL`,
 * because the point of the file is to answer questions nobody knew to ask
 * when the run started.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;

const COLOR = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  reset: '\x1b[0m',
  bold: '\x1b[1m',
} as const;

function activeLevel(): LogLevel {
  const raw = (process.env['LOG_LEVEL'] ?? 'info').toLowerCase();
  return raw in LEVELS ? (raw as LogLevel) : 'info';
}

const useColor = process.stderr.isTTY && !process.env['NO_COLOR'];

/* ------------------------------------------------------------- file sink */

let logFile: string | null = null;

/**
 * Start mirroring to a project's log file.
 *
 * Appends rather than truncates: a resumed run is part of the same story as
 * the run that stopped, and losing the earlier half would defeat the point.
 */
export function attachProjectLog(projectRoot: string): void {
  try {
    const dir = join(projectRoot, 'logs');
    mkdirSync(dir, { recursive: true });
    logFile = join(dir, 'run.log');
    writeLine('---', `session started, pid ${process.pid}, node ${process.versions.node}`);
  } catch {
    // A logging failure must never stop a run. Terminal output continues.
    logFile = null;
  }
}

export function detachProjectLog(): void {
  logFile = null;
}

export function currentLogFile(): string | null {
  return logFile;
}

function writeLine(level: string, msg: string, meta?: Record<string, unknown>): void {
  if (!logFile) return;
  const tail = meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
  try {
    appendFileSync(logFile, `${new Date().toISOString()} ${level.padEnd(5)} ${msg}${tail}\n`);
  } catch {
    // Disk full, permissions, a deleted directory - none of it is worth
    // aborting a paid run over.
  }
}

/* ---------------------------------------------------------------- emit */

function emit(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
  // The file gets everything; the terminal respects LOG_LEVEL.
  writeLine(level, msg, meta);

  if (LEVELS[level] < LEVELS[activeLevel()]) return;

  const tag = level.toUpperCase().padEnd(5);
  const head = useColor ? `${COLOR[level]}${tag}${COLOR.reset}` : tag;
  const tail = meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
  process.stderr.write(`${head} ${msg}${tail}\n`);
}

export const log = {
  debug: (msg: string, meta?: Record<string, unknown>) => emit('debug', msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => emit('info', msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => emit('warn', msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => emit('error', msg, meta),

  /** Section header for human-facing CLI stages. */
  stage: (title: string) => {
    writeLine('stage', title);
    const bar = '='.repeat(Math.max(8, title.length + 4));
    const body = useColor ? `${COLOR.bold}${title}${COLOR.reset}` : title;
    process.stderr.write(`\n${bar}\n  ${body}\n${bar}\n`);
  },

  /** Money-related notice. Always shown regardless of level. */
  money: (msg: string, meta?: Record<string, unknown>) => {
    writeLine('money', msg, meta);
    const tail = meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
    const head = useColor ? `${COLOR.bold}\x1b[35m$$$  ${COLOR.reset}` : '$$$  ';
    process.stderr.write(`${head}${msg}${tail}\n`);
  },
};
