import { MongoDBContainer, StartedMongoDBContainer } from '@testcontainers/mongodb';
import { SigningService } from '@unicitylabs/commons/lib/signing/SigningService.js';
import { HexConverter } from '@unicitylabs/commons/lib/util/HexConverter.js';
import mongoose from 'mongoose';

import { AggregatorGateway, IGatewayConfig } from '../../src/AggregatorGateway.js';
import { MockValidationService } from '../mocks/MockValidationService.js';
import logger from '../../src/logger.js';
import { generateTestCommitments, delay, sendCommitment, getHealth } from '../TestUtils.js';

// TODO fix test
describe.skip('Aggregator HA Mode Processing Test', () => {
  jest.setTimeout(300000); // 5 minutes max for the test

  let leaderGateway: AggregatorGateway;
  let followerGateway: AggregatorGateway;
  let mongoContainer: StartedMongoDBContainer;
  let mongoUri: string;

  beforeAll(async () => {
    logger.info('=========== STARTING HA MODE PROCESSING TEST ===========');

    mongoContainer = await new MongoDBContainer('mongo:7').start();
    mongoUri = mongoContainer.getConnectionString();
    logger.info(`Connecting to MongoDB test container, using connection URI: ${mongoUri}`);

    const mockValidationServiceLeader = new MockValidationService();
    const mockValidationServiceFollower = new MockValidationService();

    const commonConfig: IGatewayConfig = {
      alphabill: {
        useMock: true,
        privateKey: HexConverter.encode(SigningService.generatePrivateKey()),
      },
      highAvailability: {
        enabled: true,
        lockTtlSeconds: 10,
        leaderHeartbeatInterval: 2000,
        leaderElectionPollingInterval: 1000,
      },
      storage: {
        uri: mongoUri + '?directConnection=true',
      },
    };

    // Start first gateway (will become leader)
    const leaderConfig = {
      ...commonConfig,
      aggregatorConfig: {
        chainId: 1,
        version: 1,
        forkId: 1,
        port: 9876,
      },
      validationService: mockValidationServiceLeader,
    };

    logger.info('Starting leader AggregatorGateway...');
    leaderGateway = await AggregatorGateway.create(leaderConfig);

    // Wait and verify that the first gateway becomes the leader before starting the follower
    logger.info('Waiting for first gateway to become leader...');
    let isLeader = false;
    let retryCount = 0;
    const maxRetries = 10;

    while (!isLeader && retryCount < maxRetries) {
      await delay(500);
      try {
        const healthResponse = await getHealth(9876);
        if (healthResponse.role === 'leader') {
          isLeader = true;
          logger.info(`First gateway confirmed as leader after ${retryCount + 1} attempts`);
        } else {
          logger.info(`First gateway not yet leader (attempt ${retryCount + 1}/${maxRetries})`);
          retryCount++;
        }
      } catch (error) {
        logger.info(`Health check failed (attempt ${retryCount + 1}/${maxRetries}): ${(error as Error).message}`);
        retryCount++;
      }
    }

    if (!isLeader) {
      logger.warn('WARNING: First gateway did not become leader within retry limit');
    }

    // Start second gateway (will become follower)
    const followerConfig = {
      ...commonConfig,
      aggregatorConfig: {
        chainId: 1,
        version: 1,
        forkId: 1,
        port: 9877,
      },
      validationService: mockValidationServiceFollower,
    };

    logger.info('Starting follower AggregatorGateway...');
    followerGateway = await AggregatorGateway.create(followerConfig);

    // Verify that we have proper leader/follower setup
    logger.info('Verifying leader/follower setup...');
    let setupVerified = false;
    retryCount = 0;

    while (!setupVerified && retryCount < maxRetries) {
      await delay(500);
      try {
        const [leaderHealth, followerHealth] = await Promise.all([
          getHealth(9876),
          getHealth(9877),
        ]);

        // Check if we have one leader and one follower
        const roles = [leaderHealth.role, followerHealth.role];
        if (roles.includes('leader') && roles.includes('follower')) {
          setupVerified = true;
          logger.info('Leader gateway health check:', leaderHealth);
          logger.info('Follower gateway health check:', followerHealth);
          logger.info('Leader/follower setup verified successfully');
        } else {
          logger.info(`Leader/follower setup not yet verified (attempt ${retryCount + 1}/${maxRetries})`);
          logger.info('Current roles:', roles);
          retryCount++;
        }
      } catch (error) {
        logger.info(`Verification failed (attempt ${retryCount + 1}/${maxRetries}): ${(error as Error).message}`);
        retryCount++;
      }
    }

    if (!setupVerified) {
      logger.warn('WARNING: Leader/follower setup could not be verified within retry limit');
    }

    logger.info('Both gateways started successfully');
  });

  afterAll(async () => {
    logger.info('Cleaning up test resources...');

    if (leaderGateway) {
      logger.info('Stopping leader AggregatorGateway...');
      await leaderGateway.stop();
    }

    if (followerGateway) {
      logger.info('Stopping follower AggregatorGateway...');
      await followerGateway.stop();
    }

    if (mongoose.connection.readyState !== 0) {
      logger.info('Closing MongoDB connection...');
      await mongoose.connection.close();
    }

    await delay(1000);

    if (mongoContainer) {
      logger.info('Stopping MongoDB container...');
      await mongoContainer.stop();
    }

    logger.info('=========== FINISHED HA MODE PROCESSING TEST ===========');
  });

  it('should process all commitments submitted to both leader and follower', async () => {
    const requestCount = 1000;
    const batchSize = 100;

    logger.info(`Generating ${requestCount} test commitments...`);
    const commitments = await generateTestCommitments(requestCount);
    logger.info(`Generated ${commitments.length} commitments`);

    let leaderSuccessCount = 0;
    let followerSuccessCount = 0;
    let failCount = 0;
    const submittedRequestIds = new Set<string>();

    // Submit commitments in alternating batches to leader and follower
    logger.info(`Submitting ${requestCount} commitments in alternating batches of ${batchSize}...`);
    for (let i = 0; i < commitments.length; i += batchSize * 2) {
      // Submit a batch to the leader
      const leaderBatch = commitments.slice(i, i + batchSize);
      const leaderPromises = leaderBatch.map(async (commitment, index) => {
        const aggregatorRecord = {
          requestId: commitment.requestId,
          transactionHash: commitment.transactionHash,
          authenticator: commitment.authenticator
        };
        
        const success = await sendCommitment(9876, aggregatorRecord);
        if (success) {
          leaderSuccessCount++;
          submittedRequestIds.add(commitment.requestId.toJSON());
          return true;
        } else {
          logger.error(`Failed to send commitment (leader) ${i + index}`);
          failCount++;
          return false;
        }
      });

      // Submit a batch to the follower
      const followerBatch = commitments.slice(i + batchSize, i + batchSize * 2);
      if (followerBatch.length > 0) {
        const followerPromises = followerBatch.map(async (commitment, index) => {
          const aggregatorRecord = {
            requestId: commitment.requestId,
            transactionHash: commitment.transactionHash,
            authenticator: commitment.authenticator
          };
          
          const success = await sendCommitment(9877, aggregatorRecord);
          if (success) {
            followerSuccessCount++;
            submittedRequestIds.add(commitment.requestId.toJSON());
            return true;
          } else {
            logger.error(`Failed to send commitment (follower) ${i + batchSize + index}`);
            failCount++;
            return false;
          }
        });

        // Wait for both batches to complete
        await Promise.all([...leaderPromises, ...followerPromises]);
      } else {
        // Just wait for leader batch if no follower batch
        await Promise.all(leaderPromises);
      }
    }

    logger.info(
      `Successfully submitted commitments - Leader: ${leaderSuccessCount}, Follower: ${followerSuccessCount}, Failed: ${failCount}`,
    );

    // Wait to ensure all blocks are processed
    logger.info('Waiting for block processing to complete...');
    await delay(5000);

    // Get the leader gateway to check commitment count
    const leaderHealth = await getHealth(9876);
    const followerHealth = await getHealth(9877);

    // Determine which gateway is the leader
    const leaderRole = leaderHealth.role;
    const followerRole = followerHealth.role;
    logger.info(`Current roles - Port 9876: ${leaderRole}, Port 9877: ${followerRole}`);

    const leader = leaderRole === 'leader' ? leaderGateway : followerGateway;

    // Get the commitment count from the leader's round manager
    const processingCount = leader.getRoundManager().getCommitmentCount();

    logger.info(`Processed commitment count: ${processingCount}`);
    logger.info(`Submitted commitment count: ${leaderSuccessCount + followerSuccessCount}`);

    // Check that all commitments were processed
    expect(processingCount).toBeGreaterThan(0);
    expect(processingCount).toBe(leaderSuccessCount + followerSuccessCount);
  });
});
