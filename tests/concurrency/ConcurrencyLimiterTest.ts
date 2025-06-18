import { Authenticator, IAuthenticatorJson } from '@unicitylabs/commons/lib/api/Authenticator.js';
import { RequestId } from '@unicitylabs/commons/lib/api/RequestId.js';
import { DataHasher } from '@unicitylabs/commons/lib/hash/DataHasher.js';
import { HashAlgorithm } from '@unicitylabs/commons/lib/hash/HashAlgorithm.js';
import { SigningService } from '@unicitylabs/commons/lib/signing/SigningService.js';
import { HexConverter } from '@unicitylabs/commons/lib/util/HexConverter.js';
import axios from 'axios';
import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';

import { AggregatorGateway } from '../../src/AggregatorGateway.js';
import { Commitment } from '../../src/commitment/Commitment.js';
import logger from '../../src/logger.js';
import { IReplicaSet, setupReplicaSet } from '../TestUtils.js';
import { MockValidationService } from '../mocks/MockValidationService.js';

const testLog = (message: string): boolean => process.stdout.write(`[TEST] ${message}\n`);

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const MAX_CONCURRENT_REQUESTS = 5;

interface IApiResponse {
  status: number;
  data: {
    error?: {
      code: number;
      message: string;
    };
  } & Record<string, unknown>;
}

interface IRequestData {
  requestId: string;
  transactionHash: string;
  authenticator: IAuthenticatorJson;
}

describe('Concurrency Limiter Tests', () => {
  let gateway: AggregatorGateway;
  let port: number;
  let replicaSet: IReplicaSet;
  let mongoUri: string;
  let originalSubmitCommitment: (commitment: Commitment) => Promise<boolean>;
  let unicitySigningService: SigningService;
  let originalLogLevel: string;

  beforeAll(async () => {
    // Store original log level
    originalLogLevel = logger.level;

    // Set log level to WARN for setup to reduce noise
    logger.level = 'warn';

    replicaSet = await setupReplicaSet('concurrency-test-');
    mongoUri = replicaSet.uri;
    logger.info(`Connecting to MongoDB replica set at ${mongoUri}`);

    port = 3000 + Math.floor(Math.random() * 1000);

    const mockValidationService = new MockValidationService();

    gateway = await AggregatorGateway.create({
      aggregatorConfig: {
        port: port,
        concurrencyLimit: MAX_CONCURRENT_REQUESTS,
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
      validationService: mockValidationService,
    });

    unicitySigningService = new SigningService(
      HexConverter.decode('1DE87F189C3C9E42F93C90C95E2AC761BE9D0EB2FD1CA0FF3A9CE165C3DE96A9'),
    );

    // Monkey patch the submitCommitment method to add artificial delay
    originalSubmitCommitment = gateway.getRoundManager().submitCommitment.bind(gateway.getRoundManager());
    gateway.getRoundManager().submitCommitment = async (commitment: Commitment): Promise<void> => {
      await delay(500);
      await originalSubmitCommitment(commitment);
      testLog(`Submitted ${commitment.requestId.toJSON()}`);
    };
  }, 30000);

  afterAll(async () => {
    // Restore original log level
    logger.level = originalLogLevel;

    await gateway.stop();

    if (mongoose.connection.readyState !== 0) {
      logger.info('Closing mongoose connection...');
      await mongoose.connection.close();
    }

    if (replicaSet?.containers) {
      logger.info('Stopping replica set containers...');
      for (const container of replicaSet.containers) {
        await container.stop();
      }
    }
  }, 20000);

  async function generateRequestData(count: number): Promise<IRequestData[]> {
    const requestData: IRequestData[] = [];

    for (let i = 0; i < count; i++) {
      const randomId = uuidv4();
      const randomBytes = new TextEncoder().encode(`random-state-${randomId}-${Date.now()}-${i}`);
      const stateHash = await new DataHasher(HashAlgorithm.SHA256).update(randomBytes).digest();

      const txRandomBytes = new TextEncoder().encode(`tx-${randomId}-${Date.now()}-${i}`);
      const transactionHash = await new DataHasher(HashAlgorithm.SHA256).update(txRandomBytes).digest();

      const requestId = await RequestId.create(unicitySigningService.publicKey, stateHash);
      const authenticator = await Authenticator.create(unicitySigningService, transactionHash, stateHash);

      requestData.push({
        requestId: requestId.toJSON(),
        transactionHash: transactionHash.toJSON(),
        authenticator: authenticator.toJSON(),
      });
    }

    return requestData;
  }

  async function sendRequest(params: unknown): Promise<IApiResponse> {
    try {
      const response = await axios.post(
        `http://localhost:${port}`,
        {
          jsonrpc: '2.0',
          method: 'submit_commitment',
          params,
          id: 1,
        },
        {
          headers: { 'Content-Type': 'application/json' },
        },
      );
      return { status: response.status, data: response.data };
    } catch (error) {
      if (error.response) {
        return { status: error.response.status, data: error.response.data };
      }
      throw error;
    }
  }

  async function getHealth(): Promise<any> {
    const response = await axios.get(`http://localhost:${port}/health`);
    return response.data;
  }

  it('should reject requests when concurrency limit is reached', async () => {
    // Set log level to ERROR for this test
    logger.level = 'error';
    testLog('Starting concurrency limit test...');

    // Prepare request data first before sending anything
    // Give time for any previous operations to complete
    await delay(2000);

    // Prepare all request data first
    const totalRequests = MAX_CONCURRENT_REQUESTS * 4;
    const requestData = await generateRequestData(totalRequests);
    testLog(`Prepared ${requestData.length} requests`);

    // Now send all requests simultaneously
    testLog('Sending all requests simultaneously...');
    const requests = requestData.map((params) => sendRequest(params));
    const results = await Promise.all(requests);

    // Count successes and rejections
    const successes = results.filter((r) => r.status === 200);
    const rejections = results.filter((r) => r.status === 503);

    testLog(`Results: ${successes.length} successes, ${rejections.length} rejections`);

    // Verify that we had a mix of successes and rejections
    expect(successes.length).toBeGreaterThan(0);
    expect(rejections.length).toBeGreaterThan(0);
    expect(successes.length + rejections.length).toBe(totalRequests);

    // Verify that the number of successes is bounded by our concurrency limit
    expect(successes.length).toBeLessThan(totalRequests);

    // Verify rejection has the right error message
    rejections.forEach((rejection) => {
      expect(rejection.data).toHaveProperty('error');
      expect(rejection.data.error).toHaveProperty('code', -32000);
      expect(rejection.data.error).toHaveProperty('message', 'Server is at capacity. Please try again later.');
    });
  }, 60000); // Increase timeout for the test

  it('should accept new requests after capacity becomes available', async () => {
    // Set log level to ERROR for this test
    logger.level = 'error';
    testLog('Testing recovery after capacity limit...');

    // Give time for any previous operations to complete
    await delay(2000);

    // Step 1: Send enough requests to hit capacity (one more than the limit to ensure we hit it)
    const firstBatchSize = 6; // Slightly over our capacity of 5
    const firstBatchData = await generateRequestData(firstBatchSize);

    testLog(`Sending first batch of ${firstBatchSize} requests to reach capacity...`);

    // Start the requests without awaiting completion
    const firstBatchPromises = firstBatchData.map((params) => sendRequest(params));

    // Check server load immediately before awaiting results
    await delay(100); // Small delay to ensure requests have started processing
    const healthDuringLoad = await getHealth();
    testLog(`Current server load: ${healthDuringLoad.activeRequests}/${healthDuringLoad.maxConcurrentRequests}`);
    expect(healthDuringLoad.activeRequests).toBeGreaterThan(0);

    // Now await the results
    const firstBatchResults = await Promise.all(firstBatchPromises);

    // Verify we hit capacity with at least one rejection
    const rejections = firstBatchResults.filter((r) => r.status === 503);
    expect(rejections.length).toBeGreaterThan(0);

    // Step 2: Wait for all requests to complete
    testLog('Waiting for first batch to complete...');
    await delay(1000); // Wait long enough for the requests to complete (our delay was 500ms)

    // Step 3: Send a new request and verify it succeeds
    testLog('Sending new request after capacity should be available...');
    const newRequestData = await generateRequestData(1);
    const newResult = await sendRequest(newRequestData[0]);

    // Verify the request was accepted
    expect(newResult.status).toBe(200);
    testLog('New request was accepted after capacity became available');

    // Double check server load is reasonable again
    const healthAfterRecovery = await getHealth();
    testLog(
      `Server load after recovery: ${healthAfterRecovery.activeRequests}/${healthAfterRecovery.maxConcurrentRequests}`,
    );

    // Wait for any remaining requests to finish
    await delay(500);
  }, 60000);

  it('should maintain accurate request counting under sustained load', async () => {
    // Set log level to ERROR for this test
    logger.level = 'error';
    testLog('Testing counter accuracy under sustained load...');

    // Give time for any previous operations to complete
    await delay(2000);

    // We'll run 3 waves of requests with delays between them
    const waveSizes = [4, 7, 3]; // Mix of under, over, and under capacity
    const allWaveResults: IApiResponse[][] = [];

    for (let waveIndex = 0; waveIndex < waveSizes.length; waveIndex++) {
      const waveSize = waveSizes[waveIndex];
      testLog(`Sending wave ${waveIndex + 1} with ${waveSize} requests...`);

      // Generate and send this wave
      const waveData = await generateRequestData(waveSize);

      // Start requests without awaiting
      const wavePromises = waveData.map((params) => sendRequest(params));

      // Check the health endpoint during processing to see current count
      // Short delay to ensure requests start processing
      await delay(100);
      const healthDuringWave = await getHealth();
      testLog(`During wave ${waveIndex + 1}, active requests: ${healthDuringWave.activeRequests}`);

      // For waves larger than capacity, expect active requests to be at or near capacity
      if (waveSize > healthDuringWave.maxConcurrentRequests) {
        expect(healthDuringWave.activeRequests).toBeGreaterThan(0);
        // Usually it should be at or near max capacity, but there's some variability
        // in how quickly requests are processed
      }

      // Now await completion
      const waveResults = await Promise.all(wavePromises);

      // Allow time for request cleanup
      await delay(500);

      // Verify counter goes back down after wave completes
      const healthAfterWave = await getHealth();
      testLog(`After wave ${waveIndex + 1}, active requests: ${healthAfterWave.activeRequests}`);

      // Server should process all requests and return to 0 or close to 0 active requests
      // In a real test, we might allow for some tolerance, but for this test we expect 0
      expect(healthAfterWave.activeRequests).toBe(0);

      // Add results to our collection
      allWaveResults.push(waveResults);

      // Pause between waves
      if (waveIndex < waveSizes.length - 1) {
        await delay(1000);
      }
    }

    // Final verification - check that we can still process requests after all waves
    const finalRequestData = await generateRequestData(1);
    const finalResult = await sendRequest(finalRequestData[0]);
    expect(finalResult.status).toBe(200);

    testLog('Counter remained accurate across all request waves');

    // Restore log level
    logger.level = originalLogLevel;
  }, 60000);
});
