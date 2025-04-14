import { performance } from 'perf_hooks';

import { MongoDBContainer, StartedMongoDBContainer } from '@testcontainers/mongodb';
import { Authenticator } from '@unicitylabs/commons/lib/api/Authenticator.js';
import { RequestId } from '@unicitylabs/commons/lib/api/RequestId.js';
import { DataHash } from '@unicitylabs/commons/lib/hash/DataHash.js';
import { HashAlgorithm } from '@unicitylabs/commons/lib/hash/HashAlgorithm.js';
import { Signature } from '@unicitylabs/commons/lib/signing/Signature.js';
import axios from 'axios';
import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';

import { AggregatorGateway, IGatewayConfig } from '../../src/AggregatorGateway.js';
import { Commitment } from '../../src/commitment/Commitment.js';
import logger from '../../src/logger.js';
import { SubmitCommitmentStatus } from '../../src/SubmitCommitmentResponse.js';

async function generateTestCommitments(count: number): Promise<Commitment[]> {
  const commitments: Commitment[] = [];

  for (let i = 0; i < count; i++) {
    const idStr = `request-${i}-${uuidv4()}`;
    const stateHashBytes = new TextEncoder().encode(idStr);
    const stateHash = new DataHash(HashAlgorithm.SHA256, stateHashBytes);
    const requestId = await RequestId.create(new Uint8Array(32), stateHash);

    const txStr = `tx-${i}-${uuidv4()}`;
    const txHashBytes = new TextEncoder().encode(txStr);
    const transactionHash = new DataHash(HashAlgorithm.SHA256, txHashBytes);

    const publicKey = new Uint8Array(32);

    const sigBytes = new Uint8Array(65);
    for (let j = 0; j < 64; j++) {
      sigBytes[j] = Math.floor(Math.random() * 256);
    }
    sigBytes[64] = 0;
    const signature = new Signature(sigBytes.slice(0, 64), sigBytes[64]);

    const authenticator = new Authenticator(publicKey, 'mock-algo', signature, stateHash);

    commitments.push(new Commitment(requestId, transactionHash, authenticator));
  }

  return commitments;
}

async function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// TODO fix test
describe.skip('Aggregator Request Performance Benchmark', () => {
  jest.setTimeout(300000); // 5 minutes max for the test

  let gateway: AggregatorGateway;
  let mongoContainer: StartedMongoDBContainer;
  let mongoUri: string;

  beforeAll(async () => {
    logger.info('\n=========== STARTING PERFORMANCE BENCHMARK ===========');

    mongoContainer = await new MongoDBContainer('mongo:7').start();
    mongoUri = mongoContainer.getConnectionString();
    logger.info(`Connecting to MongoDB test container, using connection URI: ${mongoUri}`);

    const testConfig: IGatewayConfig = {
      aggregatorConfig: {
        chainId: 1,
        version: 1,
        forkId: 1,
        port: 9876,
      },
      alphabill: {
        useMock: true,
      },
      highAvailability: {
        enabled: false,
      },
      storage: {
        uri: mongoUri + '?directConnection=true',
      },
    };

    logger.info('Starting AggregatorGateway...');
    gateway = await AggregatorGateway.create(testConfig);

    await new Promise((resolve) => setTimeout(resolve, 3000));
    logger.info('AggregatorGateway started successfully');

    try {
      const response = await axios.get('http://localhost:9876/health');
      logger.info('Gateway health check:', response.data);
    } catch (error) {
      console.warn('Failed to check gateway health:', (error as Error).message);
    }
  });

  afterAll(async () => {
    logger.info('\nCleaning up test resources...');

    if (gateway) {
      logger.info('Stopping AggregatorGateway...');
      await gateway.stop();
    }

    if (mongoose.connection.readyState !== 0) {
      logger.info('Closing MongoDB connection...');
      await mongoose.connection.close();
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));

    if (mongoContainer) {
      logger.info('Stopping MongoDB container...');
      await mongoContainer.stop();
    }

    logger.info('=========== FINISHED PERFORMANCE BENCHMARK ===========\n');
  });

  it('should process a large batch of commitments efficiently', async () => {
    const requestCount = 1000;
    const batchSize = 120;

    const startGenerateTime = performance.now();
    const commitments = await generateTestCommitments(requestCount);
    const generateTime = performance.now() - startGenerateTime;
    logger.info(`Generated ${commitments.length} commitments in ${generateTime.toFixed(2)}ms`);

    const baseUrl = `http://localhost:9876`;

    const startTime = performance.now();
    let successCount = 0;
    let failCount = 0;
    const submittedRequestIds = new Set<string>();
    const processingResults = new Map<
      string,
      {
        submitted: boolean;
        processed: boolean;
        timestamp: string;
        objectId: string;
      }
    >();

    // Submit commitments in batches to avoid overwhelming the server
    logger.info(`Submitting ${requestCount} commitments in batches of ${batchSize}...`);
    for (let i = 0; i < commitments.length; i += batchSize) {
      const batch = commitments.slice(i, i + batchSize);

      const batchPromises = batch.map((commitment, index) => {
        const requestId = commitment.requestId.toDto();

        return axios
          .post(baseUrl, {
            jsonrpc: '2.0',
            method: 'submit_commitment',
            params: {
              requestId: requestId,
              transactionHash: commitment.transactionHash.toDto(),
              authenticator: commitment.authenticator.toDto(),
            },
            id: i + index + 1,
          })
          .then((response) => {
            if (response.data && response.data.status === SubmitCommitmentStatus.SUCCESS) {
              successCount++;
              submittedRequestIds.add(requestId);
              processingResults.set(requestId, {
                submitted: true,
                processed: false,
                timestamp: new Date().toISOString(),
                objectId: '',
              });
              return true;
            } else {
              console.error(`Failed response for commitment ${i + index}:`, response.data);
              failCount++;
              return false;
            }
          })
          .catch((error) => {
            console.error(`Exception submitting commitment ${i + index}:`, error.message);
            failCount++;
            return false;
          });
      });

      await Promise.all(batchPromises);
    }

    const submissionTime = performance.now() - startTime;
    logger.info(
      `${requestCount} commitments submitted in ${submissionTime.toFixed(2)}ms (${(submissionTime / requestCount).toFixed(2)}ms per commitment)`,
    );

    // Add a check for any remaining pending commitments
    // Wait a bit more to ensure all pending blocks are processed
    await new Promise((resolve) => setTimeout(resolve, 5000));
  });
});
