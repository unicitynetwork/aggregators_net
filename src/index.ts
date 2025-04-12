import dotenv from 'dotenv';
import { pino } from 'pino';

import { AggregatorGateway } from './AggregatorGateway.js';

dotenv.config();

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

async function main(): Promise<void> {
  logger.info('Starting Aggregator Gateway...');

  const gateway = await AggregatorGateway.create({
    aggregatorConfig: {
      chainId: process.env.CHAIN_ID ? parseInt(process.env.CHAIN_ID) : 1,
      version: process.env.VERSION ? parseInt(process.env.VERSION) : 1,
      forkId: process.env.FORK_ID ? parseInt(process.env.FORK_ID) : 1,
      port: process.env.PORT ? parseInt(process.env.PORT) : 80,
      sslCertPath: process.env.SSL_CERT_PATH ?? '',
      sslKeyPath: process.env.SSL_KEY_PATH ?? '',
    },
    highAvailability: {
      enabled: process.env.ENABLE_HIGH_AVAILABILITY === 'true',
      lockTtlSeconds: process.env.LOCK_TTL_SECONDS ? parseInt(process.env.LOCK_TTL_SECONDS) : 30,
      leaderHeartbeatInterval: process.env.LEADER_HEARTBEAT_INTERVAL
        ? parseInt(process.env.LEADER_HEARTBEAT_INTERVAL)
        : 10000,
      leaderElectionPollingInterval: process.env.LEADER_ELECTION_POLLING_INTERVAL
        ? parseInt(process.env.LEADER_ELECTION_POLLING_INTERVAL)
        : 5000,
    },
    alphabill: {
      useMock: process.env.USE_MOCK_ALPHABILL === 'true',
      privateKey: process.env.ALPHABILL_PRIVATE_KEY ?? '',
      tokenPartitionUrl: process.env.ALPHABILL_TOKEN_PARTITION_URL ?? 'http://localhost:9001/rpc',
      tokenPartitionId: process.env.ALPHABILL_TOKEN_PARTITION_ID
        ? parseInt(process.env.ALPHABILL_TOKEN_PARTITION_ID)
        : 2,
      networkId: process.env.ALPHABILL_NETWORK_ID ? parseInt(process.env.ALPHABILL_NETWORK_ID) : 3,
    },
    storage: {
      uri: process.env.MONGODB_URI ?? 'mongodb://localhost:27017/',
    },
  });
  logger.info('Aggregator Gateway started successfully');

  ['SIGINT', 'SIGTERM', 'SIGQUIT'].forEach((signal) => {
    process.on(signal, async () => {
      logger.info('Shutting down Aggregator Gateway...');
      await gateway.stop();
      process.exit(0);
    });
  });
}

main().catch((error) => {
  logger.error('Fatal error:', error);
  process.exit(1);
});
