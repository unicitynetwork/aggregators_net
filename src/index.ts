import dotenv from 'dotenv';

import { AggregatorGateway } from './AggregatorGateway.js';

dotenv.config();

async function main(): Promise<void> {
  console.log('Starting Aggregator Gateway...');

  const gateway = new AggregatorGateway({
    port: process.env.PORT ? parseInt(process.env.PORT) : 80,
    sslCertPath: process.env.SSL_CERT_PATH || '',
    sslKeyPath: process.env.SSL_KEY_PATH || '',
    mongoUri: process.env.MONGODB_URI || 'mongodb://localhost:27017/',
    enableHA: process.env.ENABLE_HIGH_AVAILABILITY === 'true',
    useAlphabillMock: process.env.USE_MOCK_ALPHABILL === 'true',
    alphabillPrivateKey: process.env.ALPHABILL_PRIVATE_KEY || '',
    alphabillTokenPartitionUrl: process.env.ALPHABILL_TOKEN_PARTITION_URL || '',
    alphabillTokenPartitionId: process.env.ALPHABILL_TOKEN_PARTITION_ID || '',
    alphabillNetworkId: process.env.ALPHABILL_NETWORK_ID || '',
    lockTtlSeconds: process.env.LOCK_TTL_SECONDS ? parseInt(process.env.LOCK_TTL_SECONDS) : 30,
    leaderHeartbeatIntervalMs: process.env.LEADER_HEARTBEAT_INTERVAL_MS
      ? parseInt(process.env.LEADER_HEARTBEAT_INTERVAL_MS)
      : 10000,
    leaderElectionPollingIntervalMs: process.env.LEADER_ELECTION_POLLING_INTERVAL_MS
      ? parseInt(process.env.LEADER_ELECTION_POLLING_INTERVAL_MS)
      : 5000,
  });

  try {
    await gateway.init();
    await gateway.start();

    console.log('Aggregator Gateway started successfully');

    ['SIGINT', 'SIGTERM', 'SIGQUIT'].forEach((signal) => {
      process.on(signal, async () => {
        console.log('Shutting down Aggregator Gateway...');
        await gateway.stop();
        process.exit(0);
      });
    });
  } catch (error) {
    console.error('Error starting Aggregator Gateway:', error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
