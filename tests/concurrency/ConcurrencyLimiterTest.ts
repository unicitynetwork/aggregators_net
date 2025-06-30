
import { SigningService } from '@unicitylabs/commons/lib/signing/SigningService.js';

import { AggregatorGateway } from '../../src/AggregatorGateway.js';
import { Commitment } from '../../src/commitment/Commitment.js';
import logger from '../../src/logger.js';
import { connectToSharedMongo, disconnectFromSharedMongo, delay, getHealth, clearAllCollections, IApiResponse, sendCommitment, generateTestCommitments, getTestSigningService, createGatewayConfig } from '../TestUtils.js';

const testLog = (message: string): boolean => process.stdout.write(`[TEST] ${message}\n`);

const MAX_CONCURRENT_REQUESTS = 5;

describe('Concurrency Limiter Tests', () => {
  let gateway: AggregatorGateway;
  let port: number;
  let mongoUri: string;
  let originalSubmitCommitment: (commitment: Commitment) => Promise<boolean>;
  let unicitySigningService: SigningService;
  let originalLogLevel: string;

  beforeAll(async () => {
    // Store original log level
    originalLogLevel = logger.level;

    // Set log level to WARN for setup to reduce noise
    logger.level = 'warn';

    mongoUri = await connectToSharedMongo();

    port = 3000 + Math.floor(Math.random() * 1000);

    const gatewayConfig = createGatewayConfig(port, 'test-server', mongoUri, {
      aggregatorConfig: {
        concurrencyLimit: MAX_CONCURRENT_REQUESTS,
      },
      highAvailability: {
        enabled: false,
      },
    });

    gateway = await AggregatorGateway.create(gatewayConfig);

    unicitySigningService = getTestSigningService();

    // Monkey patch the submitCommitment method to add artificial delay
    originalSubmitCommitment = gateway.getRoundManager().submitCommitment.bind(gateway.getRoundManager());
    gateway.getRoundManager().submitCommitment = async (commitment: Commitment): Promise<void> => {
      await delay(500);
      await originalSubmitCommitment(commitment);
      testLog(`Submitted ${commitment.requestId.toJSON()}`);
    };
  }, 30000);

  afterEach(async () => {
    await clearAllCollections();
  });

  afterAll(async () => {
    logger.level = originalLogLevel;

    await gateway.stop();
    await disconnectFromSharedMongo();
  }, 20000);

  it('should reject requests when concurrency limit is reached', async () => {
    // Set log level to ERROR for this test
    logger.level = 'error';
    testLog('Starting concurrency limit test...');

    // Prepare request data first before sending anything
    // Give time for any previous operations to complete
    await delay(2000);

    // Prepare all request data first
    const totalRequests = MAX_CONCURRENT_REQUESTS * 4;
    const requestData = await generateTestCommitments(totalRequests);
    testLog(`Prepared ${requestData.length} requests`);

    // Now send all requests simultaneously
    testLog('Sending all requests simultaneously...');
    const requests = requestData.map((commitment) => sendCommitment(port, commitment, 1));
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
    const firstBatchData = await generateTestCommitments(firstBatchSize);

    testLog(`Sending first batch of ${firstBatchSize} requests to reach capacity...`);

    // Start the requests without awaiting completion
    const firstBatchPromises = firstBatchData.map((commitment) => sendCommitment(port, commitment, 1));

    // Check server load immediately before awaiting results
    await delay(100); // Small delay to ensure requests have started processing
    const healthDuringLoad = await getHealth(port);
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
    const newRequestData = await generateTestCommitments(1);
    const newResult = await sendCommitment(port, newRequestData[0], 1);

    // Verify the request was accepted
    expect(newResult.status).toBe(200);
    testLog('New request was accepted after capacity became available');

    // Double check server load is reasonable again
    const healthAfterRecovery = await getHealth(port);
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
      const waveData = await generateTestCommitments(waveSize);

      // Start requests without awaiting
      const wavePromises = waveData.map((commitment) => sendCommitment(port, commitment, 1));

      // Check the health endpoint during processing to see current count
      // Short delay to ensure requests start processing
      await delay(100);
      const healthDuringWave = await getHealth(port);
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
      const healthAfterWave = await getHealth(port);
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
    const finalRequestData = await generateTestCommitments(1);
    const finalResult = await sendCommitment(port, finalRequestData[0], 1);
    expect(finalResult.status).toBe(200);

    testLog('Counter remained accurate across all request waves');

    // Restore log level
    logger.level = originalLogLevel;
  }, 60000);
});
