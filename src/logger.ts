import { createLogger, format, transports, Logger } from 'winston';
import path from 'path';

const combinedLogFilePath = path.join(__dirname, process.env.LOG_FILE ?? 'aggregator.log');
const errorLogFilePath = path.join(__dirname, process.env.ERROR_LOG_FILE ?? 'aggregator-error.log');

const logger: Logger = createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  transports: [
    new transports.Console({
      format: format.combine(
        format.timestamp(),
        format.colorize(),
        format.simple(),
        format.align(),
        format.printf((info) => `[${info.timestamp}] ${info.level}: ${info.message}`)
      )
    }),
    new transports.File({
      format: format.combine(
        format.timestamp(),
        format.json(),
      ),
      filename: combinedLogFilePath,
    }),
    new transports.File({
      level: 'error',
      format: format.combine(
        format.timestamp(),
        format.json(),
      ),
      filename: errorLogFilePath,
    }),
  ]
});

export default logger;
