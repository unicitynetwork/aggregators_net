import { AggregatorGateway } from './AggregatorGateway.js';
import logger from './logger.js';

async function main(): Promise<void> {
  logger.info('Starting Aggregator Gateway...');

  const gateway = await AggregatorGateway.create({
    aggregatorConfig: {
      chainId: process.env.CHAIN_ID ? parseInt(process.env.CHAIN_ID) : undefined,
      version: process.env.VERSION ? parseInt(process.env.VERSION) : undefined,
      forkId: process.env.FORK_ID ? parseInt(process.env.FORK_ID) : undefined,
      initialBlockHash: process.env.INITIAL_BLOCK_HASH ?? undefined,
      port: process.env.PORT ? parseInt(process.env.PORT) : undefined,
      sslCertPath: process.env.SSL_CERT_PATH ?? undefined,
      sslKeyPath: process.env.SSL_KEY_PATH ?? undefined,
      concurrencyLimit: process.env.CONCURRENCY_LIMIT ? parseInt(process.env.CONCURRENCY_LIMIT) : undefined,
    },
    highAvailability: {
      enabled: process.env.DISABLE_HIGH_AVAILABILITY !== 'true',
      lockTtlSeconds: process.env.LOCK_TTL_SECONDS ? parseInt(process.env.LOCK_TTL_SECONDS) : undefined,
      leaderHeartbeatInterval: process.env.LEADER_HEARTBEAT_INTERVAL
        ? parseInt(process.env.LEADER_HEARTBEAT_INTERVAL)
        : undefined,
      leaderElectionPollingInterval: process.env.LEADER_ELECTION_POLLING_INTERVAL
        ? parseInt(process.env.LEADER_ELECTION_POLLING_INTERVAL)
        : undefined,
    },
    alphabill: {
      useMock: process.env.USE_MOCK_ALPHABILL === 'true',
      privateKey: process.env.ALPHABILL_PRIVATE_KEY ?? '',
      tokenPartitionUrl: process.env.ALPHABILL_TOKEN_PARTITION_URL,
      tokenPartitionId: process.env.ALPHABILL_TOKEN_PARTITION_ID
        ? parseInt(process.env.ALPHABILL_TOKEN_PARTITION_ID)
        : undefined,
      networkId: process.env.ALPHABILL_NETWORK_ID ? parseInt(process.env.ALPHABILL_NETWORK_ID) : undefined,
    },
    storage: {
      uri: process.env.MONGODB_URI,
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

process.on('unhandledRejection', (err) => {
  logger.error('UNHANDLED PROMISE REJECTION:', err);
});
