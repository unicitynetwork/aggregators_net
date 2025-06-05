import { performance } from 'perf_hooks';

import { SubmitCommitmentStatus } from '@unicitylabs/commons/lib/api/SubmitCommitmentResponse.js';
import { SigningService } from '@unicitylabs/commons/lib/signing/SigningService.js';
import { HexConverter } from '@unicitylabs/commons/lib/util/HexConverter.js';
import axios, { AxiosError } from 'axios';
import mongoose from 'mongoose';

import { AggregatorGateway, IGatewayConfig } from '../../src/AggregatorGateway.js';
import { Commitment } from '../../src/commitment/Commitment.js';
import logger from '../../src/logger.js';
import { delay, generateTestCommitments, setupReplicaSet } from '../TestUtils.js';
import type { IReplicaSet } from '../TestUtils.js';

// Test configuration constants
const TEST_REQUEST_COUNT = 1000;
const TEST_BATCH_SIZE = 50;
const MAX_RETRY_ATTEMPTS = 3;
const CONCURRENCY_LIMIT = 150;
const INITIAL_BACKOFF_MS = 1000;
const BATCH_DELAY_MS = 500;
const SERVER_PORT = 9876;
const WAIT_FOR_BLOCK_PROCESSING_MS = 5000;
const SUMMARY_INTERVAL = 100; // Log summary every N requests during submission

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

// Helper function to submit a commitment
async function submitCommitment(commitment: Commitment, index: number, context: SubmissionContext): Promise<boolean> {
  const requestId = commitment.requestId.toJSON();

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
        transactionHash: commitment.transactionHash.toJSON(),
        authenticator: commitment.authenticator.toJSON(),
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
      // Service Unavailable (503)
      axiosError.response?.status === 503 ||
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
        uniqueRequestIds.add(requestId.toJSON());
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

    replicaSet = await setupReplicaSet('mongo-benchmark');
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
        privateKey: HexConverter.encode(SigningService.generatePrivateKey()),
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

    await delay(3000);
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

    await delay(1000);

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

        await delay(backoffMs);

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
            await delay(BATCH_DELAY_MS);
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
    await delay(WAIT_FOR_BLOCK_PROCESSING_MS);

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
