import { performance } from 'perf_hooks';

import { Authenticator } from '@unicitylabs/commons/lib/api/Authenticator.js';
import { RequestId } from '@unicitylabs/commons/lib/api/RequestId.js';
import { DataHasher } from '@unicitylabs/commons/lib/hash/DataHasher.js';
import { HashAlgorithm } from '@unicitylabs/commons/lib/hash/HashAlgorithm.js';
import { SigningService } from '@unicitylabs/commons/lib/signing/SigningService.js';
import { HexConverter } from '@unicitylabs/commons/lib/util/HexConverter.js';
import axios, { AxiosError } from 'axios';
import mongoose from 'mongoose';
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';
import { v4 as uuidv4 } from 'uuid';

import { AggregatorGateway, IGatewayConfig } from '../../src/AggregatorGateway.js';
import { Commitment } from '../../src/commitment/Commitment.js';
import logger from '../../src/logger.js';
import { SubmitCommitmentStatus } from '../../src/SubmitCommitmentResponse.js';

// Test configuration constants
const TEST_REQUEST_COUNT = 1000;
const TEST_BATCH_SIZE = 50;
const MAX_RETRY_ATTEMPTS = 3;
const CONCURRENCY_LIMIT = 150;
const INITIAL_BACKOFF_MS = 1000;
const BATCH_DELAY_MS = 500;
const SERVER_PORT = 9876;
const SIGNING_KEY = '1DE87F189C3C9E42F93C90C95E2AC761BE9D0EB2FD1CA0FF3A9CE165C3DE96A9';
const WAIT_FOR_BLOCK_PROCESSING_MS = 5000;
const SUMMARY_INTERVAL = 100; // Log summary every N requests during submission

// MongoDB test configuration
const MONGO_PORTS = [27017, 27018, 27019];

// Types
interface IReplicaSetMember {
  _id: number;
  name: string;
  health: number;
  state: number;
  stateStr: string;
}

interface IReplicaSetStatus {
  ok: number;
  members?: IReplicaSetMember[];
}

interface IReplicaSet {
  containers: StartedTestContainer[];
  uri: string;
}

interface ProcessingResult {
  submitted: boolean;
  processed: boolean;
  timestamp: string;
  objectId: string;
}

interface RateLimitedCommitment {
  commitment: Commitment;
  index: number;
}

interface SubmissionContext {
  baseUrl: string;
  successCount: number;
  failCount: number;
  submittedRequestIds: Set<string>;
  rateLimitedCommitments: RateLimitedCommitment[];
  processingResults: Map<string, ProcessingResult>;
  attemptedCount: number; // Track attempted submissions
}

// Original log level backup
let originalLogLevel: string;

// Create a signing service for use in all tests
const unicitySigningService = new SigningService(HexConverter.decode(SIGNING_KEY));

// Helper function to submit a commitment
async function submitCommitment(commitment: Commitment, index: number, context: SubmissionContext): Promise<boolean> {
  const requestId = commitment.requestId.toDto();

  context.attemptedCount++; // Increment attempted count

  // Log progress at regular intervals
  if (context.attemptedCount % SUMMARY_INTERVAL === 0) {
    logger.level = 'info';
    logger.info(
      `Progress: Attempted ${context.attemptedCount}/${TEST_REQUEST_COUNT} commitments (${context.successCount} successful, ${context.failCount} failed, ${context.rateLimitedCommitments.length} rate-limited)`,
    );
    logger.level = 'error';
  }

  try {
    const response = await axios.post(context.baseUrl, {
      jsonrpc: '2.0',
      method: 'submit_commitment',
      params: {
        requestId: requestId,
        transactionHash: commitment.transactionHash.toDto(),
        authenticator: commitment.authenticator.toDto(),
      },
      id: index + 1,
    });

    if (response.data && response.data.status === SubmitCommitmentStatus.SUCCESS) {
      context.successCount++;
      context.submittedRequestIds.add(requestId);
      context.processingResults.set(requestId, {
        submitted: true,
        processed: false,
        timestamp: new Date().toISOString(),
        objectId: '',
      });

      return true;
    } else {
      logger.error(`Failed response for commitment ${index}:`, response.data);
      context.failCount++;
      return false;
    }
  } catch (error) {
    const axiosError = error as AxiosError;

    // Determine if this error is retryable
    const isRetryable =
      // Rate limited (429)
      axiosError.response?.status === 429 ||
      // Server errors (5xx)
      (axiosError.response?.status && axiosError.response.status >= 500) ||
      // Network errors (ECONNRESET, ETIMEDOUT, etc.)
      !axiosError.response ||
      // Timeouts and other aggregation errors
      error instanceof AggregateError ||
      // Any other network-related error
      axiosError.code === 'ECONNABORTED' ||
      axiosError.code === 'ETIMEDOUT';

    if (isRetryable) {
      const errorType = axiosError.response?.status
        ? `HTTP ${axiosError.response.status}`
        : error instanceof AggregateError
          ? 'AggregateError'
          : axiosError.code || 'Unknown error';

      logger.warn(`Retryable error (${errorType}) when submitting commitment ${index} - will retry later`);
      context.rateLimitedCommitments.push({ commitment, index });
      return false;
    } else {
      logger.error(`Non-retryable exception submitting commitment ${index}: ${error}`);
      context.failCount++;
      return false;
    }
  }
}

// Generate test commitments
async function generateTestCommitments(count: number): Promise<Commitment[]> {
  const commitments: Commitment[] = [];

  logger.info(`Generating ${count} test commitments...`);
  const startTime = performance.now();

  for (let i = 0; i < count; i++) {
    const randomId = uuidv4();
    const randomBytes = new TextEncoder().encode(`random-state-${randomId}-${Date.now()}-${i}`);
    const stateHash = await new DataHasher(HashAlgorithm.SHA256).update(randomBytes).digest();

    const txRandomBytes = new TextEncoder().encode(`tx-${randomId}-${Date.now()}-${i}`);
    const transactionHash = await new DataHasher(HashAlgorithm.SHA256).update(txRandomBytes).digest();

    const requestId = await RequestId.create(unicitySigningService.publicKey, stateHash);
    const authenticator = await Authenticator.create(unicitySigningService, transactionHash, stateHash);

    commitments.push(new Commitment(requestId, transactionHash, authenticator));

    // Log progress for large commitment generation
    if ((i + 1) % 1000 === 0) {
      const elapsed = performance.now() - startTime;
      const rate = (i + 1) / (elapsed / 1000);
      logger.info(`Generated ${i + 1} commitments (${rate.toFixed(2)}/sec)`);
    }
  }

  const generateTime = performance.now() - startTime;
  logger.info(
    `Generated ${commitments.length} commitments in ${generateTime.toFixed(2)}ms (${(generateTime / count).toFixed(2)}ms per commitment)`,
  );

  return commitments;
}

// Setup MongoDB replica set
async function setupReplicaSet(): Promise<IReplicaSet> {
  const containers = await Promise.all(
    MONGO_PORTS.map((port) =>
      new GenericContainer('mongo:7')
        .withName(`mongo${port}-benchmark`)
        .withNetworkMode('host')
        .withCommand(['mongod', '--replSet', 'rs0', '--port', `${port}`, '--bind_ip', 'localhost'])
        .withStartupTimeout(120000)
        .withWaitStrategy(Wait.forLogMessage('Waiting for connections'))
        .start(),
    ),
  );

  logger.info(`Started MongoDB containers on ports: ${MONGO_PORTS.join(', ')}`);
  logger.info('Initializing replica set...');
  const initResult = await containers[0].exec([
    'mongosh',
    '--quiet',
    '--eval',
    `
        config = {
            _id: "rs0",
            members: [
                { _id: 0, host: "localhost:27017" },
                { _id: 1, host: "localhost:27018" },
                { _id: 2, host: "localhost:27019" }
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
        '27017',
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

  return {
    containers,
    uri: `mongodb://localhost:${MONGO_PORTS[0]},localhost:${MONGO_PORTS[1]},localhost:${MONGO_PORTS[2]}/test?replicaSet=rs0`,
  };
}

// Verify block records by counting unique request IDs
async function verifyBlockRecords(gateway: AggregatorGateway, expectedCount: number): Promise<boolean> {
  logger.info('Verifying block records...');
  const blockRecordsStorage = gateway.getRoundManager().getBlockRecordsStorage();

  // Get all block numbers
  const latestBlock = await blockRecordsStorage.getLatest();
  if (!latestBlock) {
    logger.error('No blocks found!');
    return false;
  }

  const startBlockNumber = 1n;
  const endBlockNumber = latestBlock.blockNumber;

  logger.info(`Found blocks from ${startBlockNumber} to ${endBlockNumber}`);

  // Track unique request IDs
  const uniqueRequestIds = new Set<string>();
  let totalRequestIds = 0;

  // Process each block
  for (let blockNumber = startBlockNumber; blockNumber <= endBlockNumber; blockNumber++) {
    const blockRecords = await blockRecordsStorage.get(blockNumber);

    if (blockRecords) {
      const requestIdCount = blockRecords.requestIds.length;
      totalRequestIds += requestIdCount;

      // Add each request ID to the set
      for (const requestId of blockRecords.requestIds) {
        uniqueRequestIds.add(requestId.toDto());
      }

      logger.info(`Block ${blockNumber}: ${requestIdCount} request IDs, cumulative unique: ${uniqueRequestIds.size}`);
    } else {
      logger.warn(`Block ${blockNumber} not found!`);
    }
  }

  logger.info(`Block record verification complete:`);
  logger.info(`- Total blocks: ${endBlockNumber}`);
  logger.info(`- Total request IDs found: ${totalRequestIds}`);
  logger.info(`- Unique request IDs: ${uniqueRequestIds.size}`);
  logger.info(`- Expected unique request IDs: ${expectedCount}`);

  const success = uniqueRequestIds.size === expectedCount;
  if (!success) {
    logger.error(
      `Verification FAILED: Expected ${expectedCount} unique request IDs, but found ${uniqueRequestIds.size}`,
    );
  } else {
    logger.info('Verification SUCCESSFUL: All expected request IDs were found in blocks');
  }

  return success;
}

describe('Aggregator Request Performance Benchmark', () => {
  jest.setTimeout(300000); // 5 minutes max for the test

  let gateway: AggregatorGateway;
  let replicaSet: IReplicaSet;
  let mongoUri: string;

  beforeAll(async () => {
    logger.info('=========== STARTING PERFORMANCE BENCHMARK ===========');

    // Save original log level and set to ERROR to reduce noise
    originalLogLevel = logger.level;
    logger.level = 'info'; // Keep info for benchmark metrics

    replicaSet = await setupReplicaSet();
    mongoUri = replicaSet.uri;
    logger.info(`Connecting to MongoDB replica set, using connection URI: ${mongoUri}`);

    const testConfig: IGatewayConfig = {
      aggregatorConfig: {
        chainId: 1,
        version: 1,
        forkId: 1,
        port: SERVER_PORT,
        concurrencyLimit: CONCURRENCY_LIMIT,
      },
      alphabill: {
        useMock: true,
      },
      highAvailability: {
        enabled: false,
      },
      storage: {
        uri: mongoUri,
      },
    };

    logger.info('Starting AggregatorGateway...');
    gateway = await AggregatorGateway.create(testConfig);

    await new Promise((resolve) => setTimeout(resolve, 3000));
    logger.info('AggregatorGateway started successfully');

    try {
      const response = await axios.get(`http://localhost:${SERVER_PORT}/health`);
      logger.info('Gateway health check:', response.data);
    } catch (error) {
      logger.warn('Failed to check gateway health:', (error as Error).message);
    }

    // Now set logger to ERROR for the actual test (will be reset in afterAll)
    logger.info('Setting log level to ERROR for the test duration');
    logger.level = 'error';
  });

  afterAll(async () => {
    // Restore original log level
    logger.level = originalLogLevel;
    logger.info('=========== CLEANING UP PERFORMANCE BENCHMARK ===========');

    if (gateway) {
      logger.info('Stopping AggregatorGateway...');
      await gateway.stop();
    }

    if (mongoose.connection.readyState !== 0) {
      logger.info('Closing MongoDB connection...');
      await mongoose.connection.close();
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));

    if (replicaSet) {
      logger.info('Stopping MongoDB replica set containers...');
      for (const container of replicaSet.containers) {
        try {
          await container.stop();
        } catch (e) {
          logger.error('Error stopping container:', e);
        }
      }
    }

    logger.info('=========== FINISHED PERFORMANCE BENCHMARK ===========');
  });

  it('should process a large batch of commitments efficiently', async () => {
    // Temporarily restore info level for the test output
    logger.level = 'info';

    // Generate commitments
    const startGenerateTime = performance.now();
    const commitments = await generateTestCommitments(TEST_REQUEST_COUNT);
    const generateTime = performance.now() - startGenerateTime;
    logger.info(`Generated ${commitments.length} commitments in ${generateTime.toFixed(2)}ms`);

    // Set back to error level for the submission phase
    logger.level = 'error';

    // Setup submission context
    const baseUrl = `http://localhost:${SERVER_PORT}`;
    const context: SubmissionContext = {
      baseUrl,
      successCount: 0,
      failCount: 0,
      submittedRequestIds: new Set<string>(),
      rateLimitedCommitments: [],
      processingResults: new Map<string, ProcessingResult>(),
      attemptedCount: 0,
    };

    // Start submission
    logger.level = 'info'; // Temporarily restore info logging for test metrics
    logger.info(`Starting submission of ${TEST_REQUEST_COUNT} commitments...`);
    logger.level = 'error'; // Back to error level for the actual submission

    const startTime = performance.now();

    // Initial submission of all commitments
    for (let i = 0; i < commitments.length; i += TEST_BATCH_SIZE) {
      const batchNumber = Math.floor(i / TEST_BATCH_SIZE) + 1;
      const batchStartTime = performance.now();

      const batch = commitments.slice(i, i + TEST_BATCH_SIZE);
      const batchPromises = batch.map((commitment, idx) => submitCommitment(commitment, i + idx, context));
      await Promise.all(batchPromises);

      const batchEndTime = performance.now();
      const batchDuration = batchEndTime - batchStartTime;

      // Log batch timing
      logger.level = 'info';
      logger.info(
        `Batch ${batchNumber}/${Math.ceil(commitments.length / TEST_BATCH_SIZE)}: processed ${batch.length} commitments in ${batchDuration.toFixed(2)}ms (${(batchDuration / batch.length).toFixed(2)}ms per commitment)`,
      );
      logger.level = 'error';
    }

    // Handle retries for rate-limited requests with exponential backoff
    if (context.rateLimitedCommitments.length > 0) {
      logger.level = 'info';
      logger.info(`Retrying ${context.rateLimitedCommitments.length} rate-limited requests...`);
      logger.level = 'error';

      for (let retry = 0; retry < MAX_RETRY_ATTEMPTS; retry++) {
        if (context.rateLimitedCommitments.length === 0) break;

        // Exponential backoff - wait longer between each retry attempt
        const backoffMs = INITIAL_BACKOFF_MS * Math.pow(2, retry);

        logger.level = 'info';
        logger.info(
          `Retry attempt ${retry + 1}/${MAX_RETRY_ATTEMPTS} - waiting ${backoffMs}ms before retrying ${context.rateLimitedCommitments.length} requests`,
        );
        logger.level = 'error';

        await new Promise((resolve) => setTimeout(resolve, backoffMs));

        // Process in smaller batches for retries to avoid hitting rate limits again
        const retryBatchSize = Math.max(10, Math.floor(TEST_BATCH_SIZE / (retry + 2)));
        const currentBatch = [...context.rateLimitedCommitments];
        context.rateLimitedCommitments.length = 0; // Clear the array, will be refilled with failures

        // Process in smaller batches with delay between each batch
        for (let i = 0; i < currentBatch.length; i += retryBatchSize) {
          const retryBatchNumber = Math.floor(i / retryBatchSize) + 1;
          const retryBatchStartTime = performance.now();

          const batch = currentBatch.slice(i, i + retryBatchSize);
          const batchPromises = batch.map(({ commitment, index }) => submitCommitment(commitment, index, context));
          await Promise.all(batchPromises);

          const retryBatchEndTime = performance.now();
          const retryBatchDuration = retryBatchEndTime - retryBatchStartTime;

          // Log retry batch timing
          logger.level = 'info';
          logger.info(
            `Retry ${retry + 1} - Batch ${retryBatchNumber}/${Math.ceil(currentBatch.length / retryBatchSize)}: processed ${batch.length} commitments in ${retryBatchDuration.toFixed(2)}ms (${(retryBatchDuration / batch.length).toFixed(2)}ms per commitment)`,
          );
          logger.level = 'error';

          // Small delay between batches during retry
          if (i + retryBatchSize < currentBatch.length) {
            await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
          }
        }

        if (context.rateLimitedCommitments.length === 0) {
          logger.level = 'info';
          logger.info(`All retries successful on attempt ${retry + 1}`);
          logger.level = 'error';
          break;
        }
      }

      // After all retries, if we still have rate-limited requests, count them as failures
      if (context.rateLimitedCommitments.length > 0) {
        logger.level = 'info';
        logger.warn(
          `${context.rateLimitedCommitments.length} requests still failed after ${MAX_RETRY_ATTEMPTS} retry attempts`,
        );
        logger.level = 'error';
        context.failCount += context.rateLimitedCommitments.length;
      }
    }

    const submissionTime = performance.now() - startTime;

    // Restore info level for results
    logger.level = 'info';
    logger.info('----- SUBMISSION RESULTS -----');
    logger.info(
      `${TEST_REQUEST_COUNT} commitments attempted in ${submissionTime.toFixed(2)}ms (${(submissionTime / TEST_REQUEST_COUNT).toFixed(2)}ms per commitment)`,
    );
    logger.info(
      `Success: ${context.successCount}, Failed: ${context.failCount}, Rate Limited: ${context.rateLimitedCommitments.length}`,
    );

    // Calculate throughput
    const tps = (context.successCount / (submissionTime / 1000)).toFixed(2);
    logger.info(`Submission throughput: ${tps} requests per second`);

    // Wait for block processing
    logger.info(`Waiting ${WAIT_FOR_BLOCK_PROCESSING_MS / 1000} seconds for all blocks to be processed...`);
    await new Promise((resolve) => setTimeout(resolve, WAIT_FOR_BLOCK_PROCESSING_MS));

    // Verify blocks were processed
    const roundManager = gateway.getRoundManager();
    const processedCount = roundManager.getCommitmentCount();

    logger.info('----- PROCESSING RESULTS -----');
    logger.info(`Processed commitment count from RoundManager: ${processedCount}`);
    expect(processedCount).toBe(context.successCount);

    // Calculate and display the success rate
    const successRate = (context.successCount / TEST_REQUEST_COUNT) * 100;
    logger.info(`Commitment processing success rate: ${successRate.toFixed(2)}%`);

    if (processedCount < context.successCount) {
      logger.warn(
        `Some commitments were not processed: Submitted ${context.successCount}, Processed ${processedCount}`,
      );
    }

    // Verify all commitments were stored in blocks
    const verificationResult = await verifyBlockRecords(gateway, context.successCount);
    expect(verificationResult).toBe(true);

    logger.info('----- BENCHMARK COMPLETE -----');
  });
});
