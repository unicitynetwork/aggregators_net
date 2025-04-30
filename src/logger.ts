import path from 'path';

import { createLogger, format, transports, Logger } from 'winston';

const combinedLogFilePath = path.join(__dirname, process.env.LOG_FILE ?? 'aggregator.log');
const errorLogFilePath = path.join(__dirname, process.env.ERROR_LOG_FILE ?? 'aggregator-error.log');
const logFormat = process.env.LOG_FORMAT?.toLowerCase() === 'json' ? 'json' : 'simple';
const enableFileLogging = process.env.LOG_TO_FILE?.toLowerCase() === 'true';

// Custom format to rename message to msg
const renameMessage = format((info) => {
  info.msg = info.message;
  delete info.message;
  return info;
});

const logger: Logger = createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  transports: [
    new transports.Console({
      format: format.combine(
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
      ),
    }),
    ...(enableFileLogging ? [
      new transports.File({
        format: format.combine(
          format.timestamp({ alias: 'time' }),
          renameMessage(),
          format.json()
        ),
        filename: combinedLogFilePath,
      }),
      new transports.File({
        level: 'error',
        format: format.combine(
          format.timestamp({ alias: 'time' }),
          renameMessage(),
          format.json()
        ),
        filename: errorLogFilePath,
      }),
    ] : []),
  ],
});

export default logger;
