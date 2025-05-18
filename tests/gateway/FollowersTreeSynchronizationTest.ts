import axios from 'axios';
import mongoose from 'mongoose';

import { AggregatorGateway } from '../../src/AggregatorGateway.js';
import { Commitment } from '../../src/commitment/Commitment.js';
import logger from '../../src/logger.js';
import { generateTestCommitments, setupReplicaSet, IReplicaSet, delay } from '../TestUtils.js';

// Timestamp-formatted test logger for better readability
const testLog = (message: string) => {
  const timestamp = new Date().toISOString().substring(11, 23);
  process.stdout.write(`[${timestamp}] [TEST] ${message}\n`);
};

interface ServerHealthInfo {
  gatewayIndex: number;
  port: number;
  serverId: string;
  rootHash: string;
  status: number;
}

describe('Followers Tree Synchronization Tests', () => {
  const gateways: AggregatorGateway[] = [];
  const ports = [3101, 3102, 3103];
  let replicaSet: IReplicaSet;
  let mongoUri: string;

  jest.setTimeout(180000);

  beforeAll(async () => {
    logger.info('=========== STARTING FOLLOWER SYNCHRONIZATION TESTS ===========');
    replicaSet = await setupReplicaSet('follower-sync-test-');
    mongoUri = replicaSet.uri;
    logger.info(`Connecting to MongoDB replica set at ${mongoUri}`);
  });

  afterAll(async () => {
    logger.info('Stopping all gateways...');
    for (const gateway of gateways) {
      await gateway.stop();
    }

    await delay(1000);

    if (mongoose.connection.readyState !== 0) {
      logger.info('Closing MongoDB connection...');
      await mongoose.connection.close();
    }

    await delay(1000);

    if (replicaSet?.containers) {
      logger.info('Stopping replica set containers...');
      for (const container of replicaSet.containers) {
        await container.stop();
      }
    }

    logger.info('=========== FINISHED FOLLOWER SYNCHRONIZATION TESTS ===========');
  });

  beforeEach(async () => {
    logger.info('Stopping existing gateway instances before test...');
    for (let i = gateways.length - 1; i >= 0; i--) {
      if (gateways[i]) {
        await gateways[i].stop();
        gateways.splice(i, 1);
      }
    }

    if (mongoose.connection.readyState === 1) {
      await clearAllCollections();
      logger.info('Database reset complete');
    }

    logger.info('Starting fresh gateway instances...');
    const gatewayConfiguration = {
      highAvailability: {
        enabled: true,
        lockTtlSeconds: 10,
        leaderHeartbeatInterval: 2000,
        leaderElectionPollingInterval: 3000,
      },
      alphabill: {
        useMock: true,
      },
      storage: {
        uri: mongoUri,
      },
    };

    for (let i = 0; i < 3; i++) {
      const gateway = await AggregatorGateway.create({
        aggregatorConfig: {
          port: ports[i],
          serverId: `sync-test-server-${i + 1}-${Date.now()}`,
          blockCreationWaitTime: 2000,
        },
        ...gatewayConfiguration,
      });
      gateways.push(gateway);
      logger.info(`Gateway ${i + 1} started on port ${ports[i]}`);
    }

    await waitForLeaderElection(gateways);
  });

  it.only('Should synchronize SMT across all follower nodes when leader processes commitments', async () => {
    const originalLogLevel = logger.level;
    logger.level = 'error';

    try {
      testLog('===== TEST: FOLLOWER SMT SYNCHRONIZATION WITH HIGH VOLUME =====');

      const initialLeaderIndex = findLeaderIndex(gateways);
      expect(initialLeaderIndex).not.toBe(-1);
      testLog(`Initial leader: Gateway ${initialLeaderIndex + 1}`);

      const totalCommitments = 1000;
      const batchSize = 100;
      const totalBatches = Math.ceil(totalCommitments / batchSize);

      testLog(`Generating ${totalCommitments} test commitments...`);
      const allCommitments = await generateTestCommitments(totalCommitments);
      testLog(`Generated ${allCommitments.length} test commitments`);

      const initialHealth = await getHealthStatusForAll(ports);
      logServerRootHashes('Initial root hashes before processing:', initialHealth);
      const initialRootHash = initialHealth.length > 0 ? initialHealth[0].rootHash : undefined;

      testLog(`Sending commitments in ${totalBatches} batches of ${batchSize}...`);
      const startTime = Date.now();
      let processedCount = 0;

      for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
        const batchStart = batchIndex * batchSize;
        const batchEnd = Math.min(batchStart + batchSize, totalCommitments);
        const currentBatch = allCommitments.slice(batchStart, batchEnd);

        await sendCommitmentsRoundRobin(currentBatch, ports);
        processedCount += currentBatch.length;

        if (batchIndex % 2 === 0 || batchIndex === totalBatches - 1) {
          const elapsedSeconds = (Date.now() - startTime) / 1000;
          const processedPercent = ((processedCount / totalCommitments) * 100).toFixed(1);
          testLog(
            `Progress: ${processedCount}/${totalCommitments} commitments (${processedPercent}%) in ${elapsedSeconds.toFixed(1)}s`,
          );
        }

        if (batchIndex % 5 === 0) {
          await delay(100);
        }
      }

      testLog(`All ${totalCommitments} commitments sent. Waiting for root hash convergence...`);

      const rootHashConvergence = await waitForRootHashConvergence(ports, initialRootHash, 10, 1000);
      expect(rootHashConvergence.success).toBe(true);

      // Also verify that the hash has changed from the initial state
      expect(rootHashConvergence.hashChanged).toBe(true);

      testLog('===== TEST COMPLETED =====');
    } finally {
      logger.level = originalLogLevel;
    }
  });

  it('Should maintain SMT synchronization during leader failover', async () => {
    const originalLogLevel = logger.level;
    logger.level = 'error';

    try {
      testLog('===== TEST: FOLLOWER SMT SYNCHRONIZATION DURING FAILOVER =====');

      const initialLeaderIndex = findLeaderIndex(gateways);
      expect(initialLeaderIndex).not.toBe(-1);
      const initialLeader = gateways[initialLeaderIndex];
      testLog(`Initial leader: Gateway ${initialLeaderIndex + 1}`);

      const commitmentCount = 50;
      testLog(`Generating ${commitmentCount} additional test commitments...`);
      const commitments = await generateTestCommitments(commitmentCount);
      testLog(`Generated ${commitments.length} test commitments`);

      testLog('Sending first half of commitments...');
      await sendCommitmentsRoundRobin(commitments.slice(0, commitmentCount / 2), ports);

      testLog('Waiting for leader to process first batch of commitments...');
      await delay(5000);

      const initialHealth = await getHealthStatusForAll(ports);
      logServerRootHashes('Initial root hashes before failover:', initialHealth);

      const leaderInfo = initialHealth.find((h) => h.gatewayIndex === initialLeaderIndex + 1);
      if (!leaderInfo) {
        throw new Error(`Could not find leader info for gateway index ${initialLeaderIndex + 1}`);
      }
      const initialRootHash = leaderInfo.rootHash;
      testLog(`Current leader's root hash before failover: ${initialRootHash}`);

      testLog(`Stopping the current leader (Gateway ${initialLeaderIndex + 1})...`);
      await initialLeader.stop();

      const activeGateways = gateways.filter((_, index) => index !== initialLeaderIndex);
      const remainingPorts = ports.filter((_, i) => i !== initialLeaderIndex);

      testLog(`Waiting for new leader election among remaining gateways ${remainingPorts.join(', ')}...`);
      let newLeaderFound = false;
      let attempts = 0;
      const maxAttempts = 15;
      let newLeaderIndex = -1;
      const leaderElectionStartTime = Date.now();

      while (!newLeaderFound && attempts < maxAttempts) {
        await delay(1000);
        attempts++;

        for (let i = 0; i < activeGateways.length; i++) {
          if (activeGateways[i].isLeader()) {
            newLeaderFound = true;
            newLeaderIndex = i;
            const electionTime = (Date.now() - leaderElectionStartTime) / 1000;
            testLog(`New leader elected: active gateway ${i} in ${electionTime.toFixed(1)}s`);
            break;
          }
        }
      }

      expect(newLeaderFound).toBe(true);
      expect(newLeaderIndex).not.toBe(-1);

      testLog('Sending second half of commitments to remaining nodes...');
      await sendCommitmentsRoundRobin(commitments.slice(commitmentCount / 2), remainingPorts);

      testLog('Waiting for new leader to process second batch of commitments...');

      const rootHashConvergence = await waitForRootHashConvergence(remainingPorts, initialRootHash, 10, 1000);

      expect(rootHashConvergence.success).toBe(true);

      if (!rootHashConvergence.hashChanged) {
        testLog(`ERROR: Root hash did not change after processing new commitments.`);
        testLog(`Initial hash: ${initialRootHash}`);
        testLog(`Current hash: ${rootHashConvergence.rootHash}`);
      }

      expect(rootHashConvergence.hashChanged).toBe(true);

      testLog('===== TEST COMPLETED =====');
    } finally {
      logger.level = originalLogLevel;
    }
  });

  async function getHealthStatusForAll(targetPorts: number[]): Promise<ServerHealthInfo[]> {
    const responses = await Promise.all(
      targetPorts.map((port, idx) =>
        axios.get(`http://localhost:${port}/health`).catch((e) => {
          testLog(`Failed to get health from port ${port}: ${e.message}`);
          return { status: 0, data: null };
        }),
      ),
    );

    return responses
      .map((response, idx) => {
        const originalPortIndex = ports.indexOf(targetPorts[idx]);
        return {
          gatewayIndex: originalPortIndex + 1,
          port: targetPorts[idx],
          serverId: response.data?.serverId || 'unknown',
          rootHash: response.data?.smtRootHash || 'unknown',
          status: response.status,
        };
      })
      .filter((info) => info.status === 200);
  }

  function logServerRootHashes(message: string, serverInfos: ServerHealthInfo[]): void {
    testLog(message);
    serverInfos.forEach((info) => {
      testLog(`  Gateway ${info.gatewayIndex} (port ${info.port}, ${info.serverId}): ${info.rootHash}`);
    });
  }

  async function waitForRootHashConvergence(
    targetPorts: number[],
    initialRootHash?: string,
    maxAttempts = 10,
    checkInterval = 1000,
  ): Promise<{ success: boolean; rootHash?: string; hashChanged: boolean }> {
    let allHashesMatch = false;
    let attempts = 0;
    const convergenceStartTime = Date.now();
    let rootHashChanged = false;

    testLog('Checking for SMT root hash convergence...');

    while ((!allHashesMatch || !rootHashChanged) && attempts < maxAttempts) {
      const healthInfo = await getHealthStatusForAll(targetPorts);

      if (healthInfo.length !== targetPorts.length) {
        testLog('Not all gateways are responding, waiting...');
        await delay(checkInterval);
        attempts++;
        continue;
      }

      const firstHash = healthInfo[0]?.rootHash;
      allHashesMatch = healthInfo.every((item) => item.rootHash === firstHash);

      // Check if the root hash is different from the initial hash (if provided)
      if (initialRootHash && firstHash) {
        rootHashChanged = initialRootHash !== firstHash;

        if (allHashesMatch && !rootHashChanged) {
          testLog(`Root hash has not changed yet (still ${firstHash}). Waiting for new commitments to be processed...`);
        }
      } else {
        rootHashChanged = true;
      }

      if (allHashesMatch && rootHashChanged) {
        const convergenceTime = (Date.now() - convergenceStartTime) / 1000;
        testLog(`All gateways have converged to the same SMT root hash in ${convergenceTime.toFixed(1)}s`);
        logServerRootHashes('Final root hashes by server:', healthInfo);

        if (initialRootHash && firstHash) {
          testLog(`Root hash changed: ${initialRootHash} → ${firstHash}`);
        }

        return { success: true, rootHash: firstHash, hashChanged: rootHashChanged };
      } else {
        const elapsedTime = (Date.now() - convergenceStartTime) / 1000;
        testLog(
          `Root hashes don't match yet or haven't changed. Waiting... (attempt ${attempts + 1}/${maxAttempts}, elapsed: ${elapsedTime.toFixed(1)}s)`,
        );
        if (attempts % 5 === 0) {
          logServerRootHashes('Current hashes by server:', healthInfo);
        }
        await delay(checkInterval);
        attempts++;
      }
    }

    return { success: false, hashChanged: rootHashChanged };
  }
});

async function waitForLeaderElection(gateways: AggregatorGateway[]): Promise<void> {
  let hasLeader = false;
  const maxAttempts = 15;
  let attempts = 0;

  while (!hasLeader && attempts < maxAttempts) {
    attempts++;
    await delay(1000);

    if (gateways.some((gateway) => gateway.isLeader())) {
      hasLeader = true;
      logger.info(`Leader detected after ${attempts} polling attempts`);
    }
  }

  if (!hasLeader) {
    throw new Error('Failed to elect a leader');
  }
}

function findLeaderIndex(gateways: AggregatorGateway[]): number {
  return gateways.findIndex((gateway) => gateway.isLeader());
}

async function sendCommitmentsRoundRobin(commitments: Commitment[], ports: number[]): Promise<void> {
  const commitmentsByPort: { [port: number]: Commitment[] } = {};

  ports.forEach((port) => {
    commitmentsByPort[port] = [];
  });

  commitments.forEach((commitment, index) => {
    const portIndex = index % ports.length;
    const port = ports[portIndex];
    commitmentsByPort[port].push(commitment);
  });

  const sendPromises = ports.map((port) => {
    const portCommitments = commitmentsByPort[port];
    if (portCommitments.length === 0) return Promise.resolve();

    const commitmentPromises = portCommitments.map((commitment) =>
      axios
        .post(`http://localhost:${port}/`, {
          jsonrpc: '2.0',
          method: 'submit_commitment',
          params: {
            requestId: commitment.requestId.toDto(),
            transactionHash: commitment.transactionHash.toDto(),
            authenticator: commitment.authenticator.toDto(),
          },
          id: Math.floor(Math.random() * 1000000),
        })
        .catch((error) => {
          testLog(`Error sending commitment to port ${port}: ${error.message}`);
        }),
    );

    return Promise.all(commitmentPromises);
  });

  await Promise.all(sendPromises);
}

async function clearAllCollections(): Promise<void> {
  logger.info('Clearing all collections...');

  if (!mongoose.connection.db) {
    logger.warn('No database connection available, skipping collection clear');
    return;
  }

  const collections = await mongoose.connection.db.collections();

  for (const collection of collections) {
    await collection.deleteMany({});
  }

  logger.info('All collections cleared');
}
