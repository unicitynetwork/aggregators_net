import { pino } from 'pino';

const transport = pino.transport({
  targets: [
    {
      level: process.env.LOG_LEVEL ?? 'info',
      target: 'pino/file',
      options: {
        destination: process.env.LOG_FILE ?? 'aggregator.log',
        sync: false,
      },
    },
    {
      level: process.env.LOG_LEVEL ?? 'info',
      target: 'pino-pretty',
      options: {},
    },
  ],
});

const logger = pino({}, transport);

export default logger;
