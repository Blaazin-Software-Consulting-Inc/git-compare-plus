/**
 * Logger — structured logging facade for the extension.
 *
 * Why: the comparison logic in `compare.ts` must stay free of the `vscode` module so it can be
 * unit-tested in plain Node. It depends on this narrow `Logger` interface instead; the extension
 * host supplies an implementation backed by a VS Code `LogOutputChannel` (see `createChannelLogger`).
 *
 * Contract: `message` is a constant string per event; variable data goes in `fields`, which are
 * serialized as one JSON object on the same line. The output channel adds the timestamp and level
 * and honours the user's "Developer: Set Log Level" setting, so DEBUG lines cost nothing by default.
 */

/** Structured key/value data attached to a log line. Values must be JSON-serializable. */
export type LogFields = Readonly<Record<string, unknown>>;

/** Minimal structured logger used by every module in this extension. */
export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, error: unknown, fields?: LogFields): void;
}

/**
 * The subset of `vscode.LogOutputChannel` this module writes to. Declared locally so the
 * formatter can be tested without the `vscode` runtime module.
 */
export interface LogSink {
  debug(line: string): void;
  info(line: string): void;
  warn(line: string): void;
  error(line: string): void;
}

/**
 * Build a `Logger` that writes one line per event to `sink`.
 *
 * @param sink - typically the extension's `LogOutputChannel`.
 * @param component - source identifier stamped on every line (module or class name).
 * @returns a logger; errors are expanded into `error.name` / `error.message` / `error.stack` fields.
 */
export function createChannelLogger(sink: LogSink, component: string): Logger {
  const format = (message: string, fields?: LogFields): string =>
    `${message} ${safeStringify({ component, ...fields })}`;

  return {
    debug: (message, fields) => sink.debug(format(message, fields)),
    info: (message, fields) => sink.info(format(message, fields)),
    warn: (message, fields) => sink.warn(format(message, fields)),
    error: (message, error, fields) =>
      sink.error(format(message, { ...fields, error: describeError(error) })),
  };
}

/** Normalize anything thrown into the `{ name, message, stack }` shape required on error lines. */
export function describeError(error: unknown): { name: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { name: 'NonError', message: String(error) };
}

// A log call must never throw — a circular structure or BigInt in `fields` would otherwise
// take down the command that was trying to report a problem.
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '{"logFormatError":true}';
  }
}
