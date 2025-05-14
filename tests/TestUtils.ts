import { Authenticator } from '@unicitylabs/commons/lib/api/Authenticator.js';
import { RequestId } from '@unicitylabs/commons/lib/api/RequestId.js';
import { DataHasher } from '@unicitylabs/commons/lib/hash/DataHasher.js';
import { HashAlgorithm } from '@unicitylabs/commons/lib/hash/HashAlgorithm.js';
import { SigningService } from '@unicitylabs/commons/lib/signing/SigningService.js';
import { HexConverter } from '@unicitylabs/commons/lib/util/HexConverter.js';
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';
import { v4 as uuidv4 } from 'uuid';

import { Commitment } from '../src/commitment/Commitment.js';
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
        .withStartupTimeout(120000)
        .withWaitStrategy(Wait.forLogMessage('Waiting for connections'))
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
