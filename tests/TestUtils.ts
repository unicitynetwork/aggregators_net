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
import { IJsonRpcResponse } from '../src/router/JsonRpcUtils.js';

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

export interface IApiResponse {
  status: number;
  data: IJsonRpcResponse;
}

// Default signing key for tests
export const DEFAULT_SIGNING_KEY = '1DE87F189C3C9E42F93C90C95E2AC761BE9D0EB2FD1CA0FF3A9CE165C3DE96A9';

// Create a reusable signing service
export const getTestSigningService = (): SigningService => {
  return new SigningService(HexConverter.decode(DEFAULT_SIGNING_KEY));
};

/**
 * Clears all collections in the current MongoDB database for test isolation.
 */
export async function clearAllCollections(): Promise<void> {
  try {
    if (mongoose.connection.db) {
      const collections = await mongoose.connection.db.collections();
      for (const collection of collections) {
        try {
          await collection.deleteMany({});
        } catch (error) {
          logger.error(`Error clearing collection ${collection.collectionName}: ${error}`);
        }
      }
      logger.info('Cleared all collections for test isolation');
    }
  } catch (error) {
    logger.error(`Error during database cleanup ${error}`);
  }
}

/**
 * Connects to the global shared MongoDB replica set that was started in globalSetup.
 * 
 * @param clearCollections Whether to clear all collections after connecting (default: true)
 * @returns The MongoDB URI
 */
export async function connectToSharedMongo(clearCollections: boolean = true): Promise<string> {
  const mongoUri = (global as any).__MONGO_URI__;
  
  if (!mongoUri) {
    throw new Error('Global MongoDB instance not found. Make sure globalSetup is configured in Jest.');
  }
  
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(mongoUri);
    logger.info(`Connected to shared MongoDB at ${mongoUri}`);
  }
  
  if (clearCollections) {
    await clearAllCollections();
  }
  
  return mongoUri;
}

/**
 * Disconnects from MongoDB but keeps the shared instance running for other tests.
 */
export async function disconnectFromSharedMongo(): Promise<void> {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
    logger.info('Disconnected from shared MongoDB');
  }
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
 * @returns Promise<IJsonRpcResponse> The JSON-RPC response
 */
export async function sendCommitment(port: number, commitment: Commitment, id: number): Promise<IApiResponse> {
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
      id: id,
    }),
  });

  return {
    status: response.status,
    data: await response.json(),
  };
}

export async function sendGetInclusionProof(port: number, requestId: RequestId, id: number): Promise<IApiResponse> {
  const response = await fetch(`http://localhost:${port}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'get_inclusion_proof',
      params: {
        requestId: requestId.toJSON(),
      },
      id: id,
    }),
  });
  return {
    status: response.status,
    data: await response.json(),
  };
}

/**
 * Gets the current block height via JSON-RPC.
 *
 * @param port The port to send the request to
 * @param id The JSON-RPC request ID
 * @returns Promise<IApiResponse> The JSON-RPC response
 */
export async function getBlockHeight(port: number, id: number): Promise<IApiResponse> {
  const response = await fetch(`http://localhost:${port}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'get_block_height',
      params: {},
      id: id,
    }),
  });
  return {
    status: response.status,
    data: await response.json(),
  };
}

/**
 * Gets a block by number via JSON-RPC.
 *
 * @param port The port to send the request to
 * @param blockNumber The block number (as string) or "latest"
 * @param id The JSON-RPC request ID
 * @returns Promise<IApiResponse> The JSON-RPC response
 */
export async function getBlock(port: number, blockNumber: string, id: number): Promise<IApiResponse> {
  const response = await fetch(`http://localhost:${port}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'get_block',
      params: {
        blockNumber: blockNumber,
      },
      id: id,
    }),
  });
  return {
    status: response.status,
    data: await response.json(),
  };
}

/**
 * Gets block commitments by block number via JSON-RPC.
 *
 * @param port The port to send the request to
 * @param blockNumber The block number (as string)
 * @param id The JSON-RPC request ID
 * @returns Promise<IApiResponse> The JSON-RPC response
 */
export async function getBlockCommitments(port: number, blockNumber: string, id: number): Promise<IApiResponse> {
  const response = await fetch(`http://localhost:${port}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'get_block_commitments',
      params: {
        blockNumber: blockNumber,
      },
      id: id,
    }),
  });
  return {
    status: response.status,
    data: await response.json(),
  };
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
    bft: {
      useMock: true,
      privateKey: DEFAULT_SIGNING_KEY,
      ...options.bft,
    },
    storage: {
      uri: mongoUri,
      ...options.storage,
    },
    validationService: options.validationService || new MockValidationService(),
  };
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

  await clearAllCollections();
  
  for (let i = 0; i < ports.length; i++) {
    const config = createGatewayConfig(ports[i], `${serverIdPrefix}-${i + 1}`, mongoUri);
    const gateway = await AggregatorGateway.create(config);
    gateways.push(gateway);
  }

  await waitForLeaderElection(gateways);
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
