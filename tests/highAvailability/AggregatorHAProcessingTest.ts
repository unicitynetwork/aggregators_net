import { Authenticator } from '@unicitylabs/commons/lib/api/Authenticator.js';
import { RequestId } from '@unicitylabs/commons/lib/api/RequestId.js';
import { DataHash } from '@unicitylabs/commons/lib/hash/DataHash.js';
import { HashAlgorithm } from '@unicitylabs/commons/lib/hash/HashAlgorithm.js';
import { Signature } from '@unicitylabs/commons/lib/signing/Signature.js';
import { v4 as uuidv4 } from 'uuid';
import mongoose from 'mongoose';
import axios from 'axios';
import { MongoDBContainer, StartedMongoDBContainer } from '@testcontainers/mongodb';

import { AggregatorGateway, IGatewayConfig } from '../../src/AggregatorGateway.js';
import { Commitment } from '../../src/commitment/Commitment.js';
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
  return new Promise(resolve => setTimeout(resolve, ms));
}

// TODO fix test
describe.skip('Aggregator HA Mode Processing Test', () => {
  jest.setTimeout(300000); // 5 minutes max for the test
  
  let leaderGateway: AggregatorGateway;
  let followerGateway: AggregatorGateway;
  let mongoContainer: StartedMongoDBContainer;
  let mongoUri: string;
  
  beforeAll(async () => {
    console.log('\n=========== STARTING HA MODE PROCESSING TEST ===========');
    
    mongoContainer = await new MongoDBContainer('mongo:7').start();
    mongoUri = mongoContainer.getConnectionString();
    console.log(`Connecting to MongoDB test container, using connection URI: ${mongoUri}`);
    
    const commonConfig: IGatewayConfig = {
      alphabill: {
        useMock: true
      },
      highAvailability: {
        enabled: true,
        lockTtlSeconds: 10,
        leaderHeartbeatInterval: 2000,
        leaderElectionPollingInterval: 1000
      },
      storage: {
        uri: mongoUri + '?directConnection=true'
      }
    };
    
    // Start first gateway (will become leader)
    const leaderConfig = {
      ...commonConfig,
      aggregatorConfig: {
        chainId: 1,
        version: 1,
        forkId: 1,
        port: 9876
      }
    };
    
    console.log('Starting leader AggregatorGateway...');
    leaderGateway = await AggregatorGateway.create(leaderConfig);
    
    // Wait and verify that the first gateway becomes the leader before starting the follower
    console.log('Waiting for first gateway to become leader...');
    let isLeader = false;
    let retryCount = 0;
    const maxRetries = 10;
    
    while (!isLeader && retryCount < maxRetries) {
      await wait(500);
      try {
        const healthResponse = await axios.get('http://localhost:9876/health');
        if (healthResponse.data.role === 'leader') {
          isLeader = true;
          console.log(`First gateway confirmed as leader after ${retryCount + 1} attempts`);
        } else {
          console.log(`First gateway not yet leader (attempt ${retryCount + 1}/${maxRetries})`);
          retryCount++;
        }
      } catch (error) {
        console.log(`Health check failed (attempt ${retryCount + 1}/${maxRetries}): ${error.message}`);
        retryCount++;
      }
    }
    
    if (!isLeader) {
      console.warn('WARNING: First gateway did not become leader within retry limit');
    }
    
    // Start second gateway (will become follower)
    const followerConfig = {
      ...commonConfig,
      aggregatorConfig: {
        chainId: 1,
        version: 1,
        forkId: 1,
        port: 9877
      }
    };
    
    console.log('Starting follower AggregatorGateway...');
    followerGateway = await AggregatorGateway.create(followerConfig);
    
    // Verify that we have proper leader/follower setup
    console.log('Verifying leader/follower setup...');
    let setupVerified = false;
    retryCount = 0;
    
    while (!setupVerified && retryCount < maxRetries) {
      await wait(500);
      try {
        const [leaderHealth, followerHealth] = await Promise.all([
          axios.get('http://localhost:9876/health'),
          axios.get('http://localhost:9877/health')
        ]);
        
        // Check if we have one leader and one follower
        const roles = [leaderHealth.data.role, followerHealth.data.role];
        if (roles.includes('leader') && roles.includes('follower')) {
          setupVerified = true;
          console.log('Leader gateway health check:', leaderHealth.data);
          console.log('Follower gateway health check:', followerHealth.data);
          console.log('Leader/follower setup verified successfully');
        } else {
          console.log(`Leader/follower setup not yet verified (attempt ${retryCount + 1}/${maxRetries})`);
          console.log('Current roles:', roles);
          retryCount++;
        }
      } catch (error) {
        console.log(`Verification failed (attempt ${retryCount + 1}/${maxRetries}): ${error.message}`);
        retryCount++;
      }
    }
    
    if (!setupVerified) {
      console.warn('WARNING: Leader/follower setup could not be verified within retry limit');
    }
    
    console.log('Both gateways started successfully');
  });

  afterAll(async () => {
    console.log('\nCleaning up test resources...');
    
    if (leaderGateway) {
      console.log('Stopping leader AggregatorGateway...');
      await leaderGateway.stop();
    }
    
    if (followerGateway) {
      console.log('Stopping follower AggregatorGateway...');
      await followerGateway.stop();
    }

    if (mongoose.connection.readyState !== 0) {
      console.log('Closing MongoDB connection...');
      await mongoose.connection.close();
    }
    
    await wait(1000);
    
    if (mongoContainer) {
      console.log('Stopping MongoDB container...');
      await mongoContainer.stop();
    }
    
    console.log('=========== FINISHED HA MODE PROCESSING TEST ===========\n');
  });

  it('should process all commitments submitted to both leader and follower', async () => {
    const requestCount = 1000;
    const batchSize = 100;
    
    console.log(`Generating ${requestCount} test commitments...`);
    const commitments = await generateTestCommitments(requestCount);
    console.log(`Generated ${commitments.length} commitments`);
    
    const leaderUrl = `http://localhost:9876`;
    const followerUrl = `http://localhost:9877`;
    
    let leaderSuccessCount = 0;
    let followerSuccessCount = 0;
    let failCount = 0;
    const submittedRequestIds = new Set<string>();
    
    // Submit commitments in alternating batches to leader and follower
    console.log(`Submitting ${requestCount} commitments in alternating batches of ${batchSize}...`);
    for (let i = 0; i < commitments.length; i += batchSize * 2) {
      // Submit a batch to the leader
      const leaderBatch = commitments.slice(i, i + batchSize);
      const leaderPromises = leaderBatch.map((commitment, index) => {
        const requestId = commitment.requestId.toDto();
        
        return axios.post(leaderUrl, {
          jsonrpc: '2.0',
          method: 'submit_commitment',
          params: {
            requestId: requestId,
            transactionHash: commitment.transactionHash.toDto(),
            authenticator: commitment.authenticator.toDto(),
          },
          id: i + index + 1,
        })
        .then(response => {
          if (response.data && response.data.status === SubmitCommitmentStatus.SUCCESS) {
            leaderSuccessCount++;
            submittedRequestIds.add(requestId);
            return true;
          } else {
            console.error(`Failed response for commitment (leader) ${i + index}:`, response.data);
            failCount++;
            return false;
          }
        })
        .catch(error => {
          console.error(`Exception submitting commitment (leader) ${i + index}:`, error.message);
          failCount++;
          return false;
        });
      });
      
      // Submit a batch to the follower
      const followerBatch = commitments.slice(i + batchSize, i + batchSize * 2);
      if (followerBatch.length > 0) {
        const followerPromises = followerBatch.map((commitment, index) => {
          const requestId = commitment.requestId.toDto();
          
          return axios.post(followerUrl, {
            jsonrpc: '2.0',
            method: 'submit_commitment',
            params: {
              requestId: requestId,
              transactionHash: commitment.transactionHash.toDto(),
              authenticator: commitment.authenticator.toDto(),
            },
            id: i + batchSize + index + 1,
          })
          .then(response => {
            if (response.data && response.data.status === SubmitCommitmentStatus.SUCCESS) {
              followerSuccessCount++;
              submittedRequestIds.add(requestId);
              return true;
            } else {
              console.error(`Failed response for commitment (follower) ${i + batchSize + index}:`, response.data);
              failCount++;
              return false;
            }
          })
          .catch(error => {
            console.error(`Exception submitting commitment (follower) ${i + batchSize + index}:`, error.message);
            failCount++;
            return false;
          });
        });
        
        // Wait for both batches to complete
        await Promise.all([...leaderPromises, ...followerPromises]);
      } else {
        // Just wait for leader batch if no follower batch
        await Promise.all(leaderPromises);
      }
    }
    
    console.log(`Successfully submitted commitments - Leader: ${leaderSuccessCount}, Follower: ${followerSuccessCount}, Failed: ${failCount}`);
    
    // Wait to ensure all blocks are processed
    console.log('Waiting for block processing to complete...');
    await wait(5000);
    
    // Get the leader gateway to check commitment count
    const leaderHealth = await axios.get('http://localhost:9876/health');
    const followerHealth = await axios.get('http://localhost:9877/health');
    
    // Determine which gateway is the leader
    const leaderRole = leaderHealth.data.role;
    const followerRole = followerHealth.data.role;
    console.log(`Current roles - Port 9876: ${leaderRole}, Port 9877: ${followerRole}`);
    
    const leader = leaderRole === 'leader' ? leaderGateway : followerGateway;
    
    // Get the commitment count from the leader's round manager
    const processingCount = leader.getRoundManager().getCommitmentCount();
    
    console.log(`Processed commitment count: ${processingCount}`);
    console.log(`Submitted commitment count: ${leaderSuccessCount + followerSuccessCount}`);
    
    // Check that all commitments were processed
    expect(processingCount).toBeGreaterThan(0);
    expect(processingCount).toBe(leaderSuccessCount + followerSuccessCount);
  });
}); 