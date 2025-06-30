import { describe, it, beforeAll, afterAll, expect } from '@jest/globals';
import mongoose from 'mongoose';

import { AggregatorGateway } from '../../src/AggregatorGateway.js';
import { 
  connectToSharedMongo,
  sendCommitment,
  getRootHash,
  waitForRootHashConvergence,
  findLeader,
  getFollowers,
  waitForLeaderElection,
  createTestCommitment,
  createGatewayConfig,
  setupCluster,
  cleanupCluster,
  delay,
  disconnectFromSharedMongo,
  clearAllCollections
} from '../TestUtils.js';
import { SubmitCommitmentStatus } from '@unicitylabs/commons/lib/api/SubmitCommitmentResponse.js';

describe('Resume Token End-to-End Integration Tests', () => {
  jest.setTimeout(300000);

  let mongoUri: string;

  beforeAll(async () => {
    mongoUri = await connectToSharedMongo();
  });

  afterAll(async () => {
    await disconnectFromSharedMongo();
  });

  afterEach(async () => {
    await clearAllCollections();
  });

  async function setupTestCluster(): Promise<{ gateways: AggregatorGateway[], ports: number[] }> {
    const ports = [8001, 8002, 8003];
    return await setupCluster(ports, mongoUri);
  }

  describe('Multi-Node Resume Token Scenarios', () => {
    it('should maintain SMT synchronization across leader and followers with resume tokens', async () => {
      const { gateways, ports } = await setupTestCluster();

      try {
        const leader = findLeader(gateways)!;
        const followers = getFollowers(gateways);
        expect(followers).toHaveLength(2);

        const initialCommitments = await Promise.all(
          Array.from({ length: 5 }, (_, i) => createTestCommitment(i + 1))
        );

        const leaderPort = ports[gateways.indexOf(leader)];
        for (let i = 0; i < initialCommitments.length; i++) {
          const response = await sendCommitment(leaderPort, initialCommitments[i], i + 1);
          expect(response.data.result).toHaveProperty('status', SubmitCommitmentStatus.SUCCESS);
        }

        const initialConvergence = await waitForRootHashConvergence(ports);
        expect(initialConvergence.success).toBe(true);

        const ResumeTokenModel = mongoose.model('BlockRecordsResumeToken');
        const resumeTokens = await ResumeTokenModel.find({});
        expect(resumeTokens.length).toBeGreaterThanOrEqual(3);
        
        resumeTokens.forEach(token => {
          expect(token.token).toBeTruthy();
        });
      } finally {
        await cleanupCluster(gateways);
      }
    });

    it('should handle follower restart with resume token recovery', async () => {
      const { gateways, ports } = await setupTestCluster();

      try {
        const currentLeader = findLeader(gateways);
        const followers = getFollowers(gateways);
        expect(followers.length).toBeGreaterThan(0);
        expect(currentLeader).not.toBeNull();
        
        const currentLeaderPort = ports[gateways.indexOf(currentLeader!)];
        const initialRootHash = await getRootHash(currentLeaderPort);
        
        const followerToRestart = followers[0];
        const followerIndex = gateways.indexOf(followerToRestart);
        const followerPort = ports[followerIndex];
        const followerServerId = followerToRestart.getServerId();
        
        await followerToRestart.stop();
        gateways[followerIndex] = null as any;
        
        const leader = findLeader(gateways.filter(g => g !== null) as AggregatorGateway[])!;
        const leaderPort = ports[gateways.indexOf(leader)];
        
        const offlineCommitments = await Promise.all(
          Array.from({ length: 3 }, (_, i) => createTestCommitment(i + 10))
        );

        for (let i = 0; i < offlineCommitments.length; i++) {
          const response = await sendCommitment(leaderPort, offlineCommitments[i], i + 1);
          expect(response.data.result).toHaveProperty('status', SubmitCommitmentStatus.SUCCESS);
        }

        await delay(3000);

        const rootHashBeforeRestart = await getRootHash(leaderPort);
        expect(rootHashBeforeRestart).toBeTruthy();
        expect(rootHashBeforeRestart).not.toBe(initialRootHash);

        const restartConfig = createGatewayConfig(followerPort, followerServerId, mongoUri);
        const restartedGateway = await AggregatorGateway.create(restartConfig);
        gateways[followerIndex] = restartedGateway;

        await delay(5000);

        const restartedFollowerRootHash = await getRootHash(followerPort);
        expect(restartedFollowerRootHash).toBe(rootHashBeforeRestart);

        const finalCommitments = await Promise.all(
          Array.from({ length: 2 }, (_, i) => createTestCommitment(i + 20))
        );

        for (let i = 0; i < finalCommitments.length; i++) {
          const response = await sendCommitment(leaderPort, finalCommitments[i], i + 1);
          expect(response.data.result).toHaveProperty('status', SubmitCommitmentStatus.SUCCESS);
        }

        const finalConvergence = await waitForRootHashConvergence(ports);
        expect(finalConvergence.success).toBe(true);
      } finally {
        await cleanupCluster(gateways.filter(g => g !== null) as AggregatorGateway[]);
      }
    });

    it('should handle leader failover with resume token continuity', async () => {
      const { gateways, ports } = await setupTestCluster();

      try {
        const currentLeader = findLeader(gateways)!;
        const leaderIndex = gateways.indexOf(currentLeader);
        const leaderPort = ports[leaderIndex];
        const leaderServerId = currentLeader.getServerId();
        
        const initialRootHash = await getRootHash(leaderPort);
        expect(initialRootHash).toBeTruthy();
        
        await currentLeader.stop();
        gateways[leaderIndex] = null as any;
        
        await waitForLeaderElection(gateways.filter(g => g !== null) as AggregatorGateway[]);
        
        const newLeader = findLeader(gateways.filter(g => g !== null) as AggregatorGateway[])!;
        const newLeaderPort = ports[gateways.indexOf(newLeader)];
        
        const newLeaderRootHash = await getRootHash(newLeaderPort);
        expect(newLeaderRootHash).toBe(initialRootHash);
        
        const failoverCommitments = await Promise.all(
          Array.from({ length: 3 }, (_, i) => createTestCommitment(i + 30))
        );

        for (let i = 0; i < failoverCommitments.length; i++) {
          const response = await sendCommitment(newLeaderPort, failoverCommitments[i], i + 1);
          expect(response.data.result).toHaveProperty('status', SubmitCommitmentStatus.SUCCESS);
        }

        await delay(3000);

        const activePortsAfterFailover = ports.filter((_, index) => gateways[index] !== null);
        const failoverConvergence = await waitForRootHashConvergence(activePortsAfterFailover);
        expect(failoverConvergence.success).toBe(true);
        expect(failoverConvergence.rootHash).not.toBe(initialRootHash);
        
        const followerConfig = createGatewayConfig(leaderPort, leaderServerId, mongoUri);
        const restartedAsFollower = await AggregatorGateway.create(followerConfig);
        gateways[leaderIndex] = restartedAsFollower;
        
        await delay(3000);
        expect(restartedAsFollower.isLeader()).toBe(false);
        
        const finalRootHash = await getRootHash(leaderPort);
        expect(finalRootHash).toBe(failoverConvergence.rootHash);
      } finally {
        await cleanupCluster(gateways.filter(g => g !== null) as AggregatorGateway[]);
      }
    });

    it('should handle multiple simultaneous node restarts', async () => {
      const { gateways, ports } = await setupTestCluster();

      try {
        const leader = findLeader(gateways)!;
        const leaderPort = ports[gateways.indexOf(leader)];
        const initialRootHash = await getRootHash(leaderPort);
        
        const followers = getFollowers(gateways);
        const followerIndices = followers.map(f => gateways.indexOf(f));
        const followerConfigs = followers.map(f => ({
          port: ports[gateways.indexOf(f)],
          serverId: f.getServerId()
        }));
        
        await Promise.all(followers.map(f => f.stop()));
        followerIndices.forEach(index => { gateways[index] = null as any; });
        
        const restartCommitments = await Promise.all(
          Array.from({ length: 4 }, (_, i) => createTestCommitment(i + 40))
        );

        for (let i = 0; i < restartCommitments.length; i++) {
          const response = await sendCommitment(leaderPort, restartCommitments[i], i + 1);
          expect(response.data.result).toHaveProperty('status', SubmitCommitmentStatus.SUCCESS);
        }

        await delay(6000);
        const leaderRootHashAfterCommitments = await getRootHash(leaderPort);
        expect(leaderRootHashAfterCommitments).not.toBe(initialRootHash);
        
        const restartPromises = followerConfigs.map(async (config, i) => {
          const restartConfig = createGatewayConfig(config.port, config.serverId, mongoUri);
          const restartedGateway = await AggregatorGateway.create(restartConfig);
          gateways[followerIndices[i]] = restartedGateway;
          return restartedGateway;
        });
        
        await Promise.all(restartPromises);
        
        const finalConvergence = await waitForRootHashConvergence(ports);
        expect(finalConvergence.success).toBe(true);
        expect(finalConvergence.rootHash).toBe(leaderRootHashAfterCommitments);
        
        const ResumeTokenModel = mongoose.model('BlockRecordsResumeToken');
        const finalResumeTokens = await ResumeTokenModel.find({});
        expect(finalResumeTokens.length).toBeGreaterThanOrEqual(3);
      } finally {
        await cleanupCluster(gateways.filter(g => g !== null) as AggregatorGateway[]);
      }
    });
  });
}); 