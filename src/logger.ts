import path from 'path';

import { createLogger, format, transports, Logger } from 'winston';
import Transport from 'winston-transport';

const combinedLogFilePath = path.join(__dirname, process.env.LOG_FILE ?? 'aggregator.log');
const errorLogFilePath = path.join(__dirname, process.env.ERROR_LOG_FILE ?? 'aggregator-error.log');
const logFormat = process.env.LOG_FORMAT?.toLowerCase() === 'json' ? 'json' : 'simple';
const enableFileLogging = process.env.LOG_TO_FILE?.toLowerCase() === 'true';

const isTestEnvironment = process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID !== undefined;

// Custom transport that writes directly to stdout/stderr without Jest interference
class DirectConsoleTransport extends Transport {
  log(info: any, callback: () => void) {
    setImmediate(() => {
      this.emit('logged', info);
    });

    const message = `${info.time} ${info.level.toUpperCase()} ${info.msg}\n`;
    
    if (info.level === 'error') {
      process.stderr.write(message);
    } else {
      process.stdout.write(message);
    }

    callback();
  }
}

// Custom format to rename message to msg
const renameMessage = format((info) => {
  info.msg = info.message;
  delete info.message;
  return info;
});

// Simple format for tests without stack traces
const testFormat = format.combine(
  format.timestamp({ alias: 'time' }),
  renameMessage(),
);

// Production format with stack traces
const productionFormat = format.combine(
  format.timestamp({ alias: 'time' }),
  renameMessage(),
  logFormat === 'json'
    ? format.json()
    : format.combine(
        format.simple(),
        format.errors({ stack: true }),
        format.printf(({ time, level, msg, stack }) => {
          const text = `${time} ${level.toUpperCase()} ${msg}`;
          return stack ? text + '\n' + stack : text;
        }),
      ),
);

const logger: Logger = createLogger({
  level: isTestEnvironment ? 'info' : (process.env.LOG_LEVEL ?? 'info'),
  transports: [
    // Use custom transport for tests to avoid Jest console capturing
    isTestEnvironment 
      ? new DirectConsoleTransport({ format: testFormat })
      : new transports.Console({ format: productionFormat }),
    ...(enableFileLogging
      ? [
          new transports.File({
            format: format.combine(format.timestamp({ alias: 'time' }), renameMessage(), format.json()),
            filename: combinedLogFilePath,
          }),
          new transports.File({
            level: 'error',
            format: format.combine(format.timestamp({ alias: 'time' }), renameMessage(), format.json()),
            filename: errorLogFilePath,
          }),
        ]
      : []),
  ],
});

export default logger;
