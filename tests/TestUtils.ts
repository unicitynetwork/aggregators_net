import { Authenticator } from '@unicitylabs/commons/lib/api/Authenticator.js';
import { RequestId } from '@unicitylabs/commons/lib/api/RequestId.js';
import { DataHasher } from '@unicitylabs/commons/lib/hash/DataHasher.js';
import { HashAlgorithm } from '@unicitylabs/commons/lib/hash/HashAlgorithm.js';
import { SigningService } from '@unicitylabs/commons/lib/signing/SigningService.js';
import { HexConverter } from '@unicitylabs/commons/lib/util/HexConverter.js';
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';
import { v4 as uuidv4 } from 'uuid';
import mongoose from 'mongoose';

import { AggregatorGateway, IGatewayConfig } from '../src/AggregatorGateway.js';
import { AggregatorRecord } from '../src/records/AggregatorRecord.js';
import { Commitment } from '../src/commitment/Commitment.js';
import { MockValidationService } from './mocks/MockValidationService.js';
import logger from '../src/logger.js';

export interface IReplicaSetMember {
  _id: number;
  name: string;
  health: number;
  state: number;
  stateStr: string;
}

export interface IReplicaSetStatus {
  ok: number;
  members?: IReplicaSetMember[];
}

export interface IReplicaSet {
  containers: StartedTestContainer[];
  uri: string;
}

// Default signing key for tests
export const DEFAULT_SIGNING_KEY = '1DE87F189C3C9E42F93C90C95E2AC761BE9D0EB2FD1CA0FF3A9CE165C3DE96A9';

// Create a reusable signing service
export const getTestSigningService = (): SigningService => {
  return new SigningService(HexConverter.decode(DEFAULT_SIGNING_KEY));
};

/**
 * Sets up a MongoDB replica set for testing.
 *
 * @param containerNamePrefix Optional prefix for container names (default: 'mongo')
 * @returns The replica set information
 */
export async function setupReplicaSet(containerNamePrefix: string = 'mongo'): Promise<IReplicaSet> {
  const ports = [27017, 27018, 27019];

  logger.info(`Starting MongoDB containers on ports: ${ports.join(', ')}`);

  const containers = await Promise.all(
    ports.map((port) =>
      new GenericContainer('mongo:8')
        .withName(`${containerNamePrefix}${port}`)
        .withNetworkMode('host')
        .withCommand(['mongod', '--replSet', 'rs0', '--port', `${port}`, '--bind_ip', 'localhost'])
        .withWaitStrategy(Wait.forLogMessage('Waiting for connections').withStartupTimeout(120000))
        .start(),
    ),
  );

  logger.info('Initializing replica set...');
  const initResult = await containers[0].exec([
    'mongosh',
    '--quiet',
    '--eval',
    `
        config = {
            _id: "rs0",
            members: [
                { _id: 0, host: "localhost:${ports[0]}" },
                { _id: 1, host: "localhost:${ports[1]}" },
                { _id: 2, host: "localhost:${ports[2]}" }
            ]
        };
        rs.initiate(config);
        `,
  ]);
  logger.info('Initiate result:', initResult.output);

  // Wait and verify replica set is ready
  logger.info('Waiting for replica set initialization...');
  let isReady = false;
  let lastStatus = '';
  const maxAttempts = 30;
  let attempts = 0;
  const startTime = Date.now();

  while (!isReady && attempts < maxAttempts) {
    try {
      const status = await containers[0].exec([
        'mongosh',
        '--port',
        `${ports[0]}`,
        '--quiet',
        '--eval',
        'if (rs.status().ok) { print(JSON.stringify(rs.status())); } else { print("{}"); }',
      ]);

      let rsStatus: IReplicaSetStatus;
      try {
        rsStatus = JSON.parse(status.output);
      } catch (e) {
        logger.info('Invalid JSON response:', status.output);
        logger.debug(e);
        rsStatus = { ok: 0 };
      }

      if (rsStatus.members?.some((m: IReplicaSetMember) => m.stateStr === 'PRIMARY')) {
        const primaryNode = rsStatus.members.find((m) => m.stateStr === 'PRIMARY')!;
        const electionTime = (Date.now() - startTime) / 1000;
        logger.info(`Replica set primary elected after ${electionTime.toFixed(1)}s`);
        logger.info('Initial primary node:', primaryNode.name);
        isReady = true;
      } else {
        const currentStatus = rsStatus.members?.map((m) => m.stateStr).join(',') || '';
        if (currentStatus !== lastStatus) {
          logger.info('Current replica set status:', currentStatus);
          lastStatus = currentStatus;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
        attempts++;
      }
    } catch (error) {
      logger.info('Error checking replica status:', error);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      attempts++;
    }
  }

  if (!isReady) {
    throw new Error('Replica set failed to initialize');
  }

  const portStrings = ports.map((p) => `localhost:${p}`);
  return {
    containers,
    uri: `mongodb://${portStrings.join(',')}/test?replicaSet=rs0`,
  };
}

/**
 * Generates test commitments with random data for testing.
 *
 * @param count Number of commitments to generate
 * @param signingService Optional signing service (uses default if not provided)
 * @returns Array of generated commitments
 */
export async function generateTestCommitments(count: number, signingService?: SigningService): Promise<Commitment[]> {
  const commitments: Commitment[] = [];
  const signer = signingService || getTestSigningService();

  for (let i = 0; i < count; i++) {
    const randomId = uuidv4();
    const randomBytes = new TextEncoder().encode(`random-state-${randomId}-${Date.now()}-${i}`);
    const stateHash = await new DataHasher(HashAlgorithm.SHA256).update(randomBytes).digest();

    const txRandomBytes = new TextEncoder().encode(`tx-${randomId}-${Date.now()}-${i}`);
    const transactionHash = await new DataHasher(HashAlgorithm.SHA256).update(txRandomBytes).digest();

    const requestId = await RequestId.create(signer.publicKey, stateHash);
    const authenticator = await Authenticator.create(signer, transactionHash, stateHash);

    commitments.push(new Commitment(requestId, transactionHash, authenticator));
  }

  return commitments;
}

/**
 * Simple delay function for tests.
 *
 * @param ms Milliseconds to delay
 * @returns Promise that resolves after the delay
 */
export const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sends a commitment to a specific port via JSON-RPC.
 *
 * @param port The port to send the commitment to
 * @param commitment The commitment to send
 * @returns Promise<boolean> indicating success
 */
export async function sendCommitment(port: number, commitment: AggregatorRecord): Promise<boolean> {
  try {
    const response = await fetch(`http://localhost:${port}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'submit_commitment',
        params: {
          requestId: commitment.requestId.toJSON(),
          transactionHash: commitment.transactionHash.toJSON(),
          authenticator: commitment.authenticator.toJSON(),
        },
        id: 1,
      }),
    });

    if (response.status !== 200) {
      return false;
    }

    const responseData = await response.json();
    if (responseData.error || !responseData.result || responseData.result.status !== 'SUCCESS') {
      return false;
    }

    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Gets the SMT root hash from a gateway's health endpoint.
 *
 * @param port The port to query
 * @returns Promise<string | null> The root hash or null if unavailable
 */
export async function getRootHash(port: number): Promise<string | null> {
  try {
    const response = await fetch(`http://localhost:${port}/health`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    if (response.status === 200) {
      const data = await response.json();
      return data.smtRootHash || null;
    }
  } catch (error) {
    // Ignore errors during root hash retrieval
  }
  return null;
}

/**
 * Gets health information from a gateway.
 *
 * @param port The port to query
 * @returns Promise<any> The health data or null if unavailable
 */
export async function getHealth(port: number): Promise<any> {
  try {
    const response = await fetch(`http://localhost:${port}/health`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    if (response.status === 200) {
      return await response.json();
    }
  } catch (error) {
    // Ignore errors during health check
  }
  return null;
}

/**
 * Waits for all target ports to converge to the same SMT root hash.
 *
 * @param targetPorts Array of ports to check
 * @param maxAttempts Maximum number of attempts (default: 30)
 * @param delayMs Delay between attempts in milliseconds (default: 1000)
 * @returns Promise with convergence result
 */
export async function waitForRootHashConvergence(
  targetPorts: number[], 
  maxAttempts: number = 30, 
  delayMs: number = 1000
): Promise<{ success: boolean; rootHash: string | null }> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const rootHashes = await Promise.all(targetPorts.map(port => getRootHash(port)));
    const validHashes = rootHashes.filter(hash => hash !== null);
    
    if (validHashes.length === targetPorts.length) {
      const uniqueHashes = new Set(validHashes);
      if (uniqueHashes.size === 1) {
        return { success: true, rootHash: validHashes[0] };
      }
    }

    await delay(delayMs);
  }

  return { success: false, rootHash: null };
}

/**
 * Finds the leader gateway from an array of gateways.
 *
 * @param gateways Array of AggregatorGateway instances
 * @returns The leader gateway or null if none found
 */
export function findLeader(gateways: AggregatorGateway[]): AggregatorGateway | null {
  return gateways.find(gateway => gateway && gateway.isLeader()) || null;
}

/**
 * Gets all follower gateways from an array of gateways.
 *
 * @param gateways Array of AggregatorGateway instances
 * @returns Array of follower gateways
 */
export function getFollowers(gateways: AggregatorGateway[]): AggregatorGateway[] {
  return gateways.filter(gateway => gateway && !gateway.isLeader());
}

/**
 * Waits for leader election to complete among the provided gateways.
 *
 * @param gateways Array of AggregatorGateway instances
 * @param maxAttempts Maximum number of polling attempts (default: 30)
 * @param delayMs Delay between attempts in milliseconds (default: 1000)
 * @returns Promise that resolves when a leader is elected
 */
export async function waitForLeaderElection(
  gateways: AggregatorGateway[], 
  maxAttempts: number = 30, 
  delayMs: number = 1000
): Promise<void> {
  let hasLeader = false;
  let attempts = 0;

  while (!hasLeader && attempts < maxAttempts) {
    attempts++;
    await delay(delayMs);

    if (gateways.some(gateway => gateway && gateway.isLeader())) {
      hasLeader = true;
      logger.info(`Leader detected after ${attempts} polling attempts`);
    }
  }

  if (!hasLeader) {
    throw new Error('Failed to elect a leader within timeout');
  }
}

/**
 * Creates a test commitment (AggregatorRecord) for testing.
 *
 * @param index Optional index for unique data generation
 * @param signingService Optional signing service (uses default if not provided)
 * @returns Promise<AggregatorRecord> A test commitment
 */
export async function createTestCommitment(index: number = 0, signingService?: SigningService): Promise<AggregatorRecord> {
  const commitments = await generateTestCommitments(1, signingService);
  const commitment = commitments[0];
  return new AggregatorRecord(commitment.requestId, commitment.transactionHash, commitment.authenticator);
}

/**
 * Creates a test RequestId for testing.
 *
 * @param signingService Optional signing service (uses default if not provided)
 * @returns Promise<RequestId> A test request ID
 */
export async function createTestRequestId(signingService?: SigningService): Promise<RequestId> {
  const signer = signingService || getTestSigningService();
  const randomData = new TextEncoder().encode(`test-${Date.now()}-${Math.random()}`);
  const stateHash = await new DataHasher(HashAlgorithm.SHA256).update(randomData).digest();
  return await RequestId.create(signer.publicKey, stateHash);
}

/**
 * Creates a standard gateway configuration for testing.
 *
 * @param port The port for the gateway
 * @param serverId The server ID
 * @param mongoUri The MongoDB connection URI
 * @param options Optional configuration overrides
 * @returns IGatewayConfig A gateway configuration
 */
export function createGatewayConfig(
  port: number, 
  serverId: string, 
  mongoUri: string,
  options: Partial<IGatewayConfig> = {}
): IGatewayConfig {
  return {
    aggregatorConfig: {
      port,
      serverId,
      blockCreationWaitTime: 2000,
      ...options.aggregatorConfig,
    },
    highAvailability: {
      enabled: true,
      lockTtlSeconds: 10,
      leaderHeartbeatInterval: 2000,
      leaderElectionPollingInterval: 1000,
      ...options.highAvailability,
    },
    alphabill: {
      useMock: true,
      privateKey: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      ...options.alphabill,
    },
    storage: {
      uri: mongoUri,
      ...options.storage,
    },
    validationService: options.validationService || new MockValidationService(),
    ...options,
  };
}

/**
 * Clears all collections in the current MongoDB database.
 *
 * @returns Promise<void>
 */
export async function clearDatabase(): Promise<void> {
  if (!mongoose.connection.db) {
    logger.warn('No database connection available, skipping database clear');
    return;
  }

  await mongoose.connection.db.dropDatabase();
  logger.info('Database cleared');
}

/**
 * Sets up a cluster of gateways for testing.
 *
 * @param ports Array of ports for the gateways
 * @param mongoUri MongoDB connection URI
 * @param serverIdPrefix Prefix for server IDs (default: 'server')
 * @returns Promise with gateways and ports
 */
export async function setupCluster(
  ports: number[], 
  mongoUri: string,
  serverIdPrefix: string = 'server'
): Promise<{ gateways: AggregatorGateway[], ports: number[] }> {
  const gateways: AggregatorGateway[] = [];

  // Clear database
  await clearDatabase();
  
  // Create gateways
  for (let i = 0; i < ports.length; i++) {
    const config = createGatewayConfig(ports[i], `${serverIdPrefix}-${i + 1}`, mongoUri);
    const gateway = await AggregatorGateway.create(config);
    gateways.push(gateway);
  }

  // Wait for leader election
  await waitForLeaderElection(gateways);

  // Additional settling time
  await delay(2000);

  return { gateways, ports };
}

/**
 * Cleans up a cluster of gateways.
 *
 * @param gateways Array of gateways to stop
 * @returns Promise<void>
 */
export async function cleanupCluster(gateways: AggregatorGateway[]): Promise<void> {
  for (const gateway of gateways) {
    if (gateway) {
      await gateway.stop();
    }
  }
}
