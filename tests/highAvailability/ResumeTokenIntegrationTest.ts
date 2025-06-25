import { describe, it, beforeAll, afterAll, expect } from '@jest/globals';
import mongoose from 'mongoose';

import { AggregatorGateway, IGatewayConfig } from '../../src/AggregatorGateway.js';
import { AggregatorRecord } from '../../src/records/AggregatorRecord.js';
import { 
  setupReplicaSet, 
  getTestSigningService, 
  generateTestCommitments, 
  IReplicaSet, 
  sendCommitment,
  getRootHash,
  waitForRootHashConvergence,
  findLeader,
  getFollowers,
  waitForLeaderElection,
  createTestCommitment,
  createGatewayConfig,
  clearDatabase,
  setupCluster,
  cleanupCluster,
  delay
} from '../TestUtils.js';
import { MockValidationService } from '../mocks/MockValidationService.js';

describe('Resume Token End-to-End Integration Tests', () => {
  jest.setTimeout(300000);

  let replicaSet: IReplicaSet;
  const signingService = getTestSigningService();

  beforeAll(async () => {
    replicaSet = await setupReplicaSet('test-resume-e2e');
    await mongoose.connect(replicaSet.uri);
  });

  afterAll(async () => {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.connection.close();
    }
    
    if (replicaSet?.containers) {
      await Promise.all(replicaSet.containers.map(container => container.stop()));
    }
  });

  async function setupTestCluster(): Promise<{ gateways: AggregatorGateway[], ports: number[] }> {
    const ports = [8001, 8002, 8003];
    return await setupCluster(ports, replicaSet.uri);
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
        for (const commitment of initialCommitments) {
          const success = await sendCommitment(leaderPort, commitment);
          expect(success).toBe(true);
        }

        await delay(5000);

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

        for (const commitment of offlineCommitments) {
          const success = await sendCommitment(leaderPort, commitment);
          expect(success).toBe(true);
        }

        await delay(3000);

        const rootHashBeforeRestart = await getRootHash(leaderPort);
        expect(rootHashBeforeRestart).toBeTruthy();
        expect(rootHashBeforeRestart).not.toBe(initialRootHash);

        const restartConfig = createGatewayConfig(followerPort, followerServerId, replicaSet.uri);
        const restartedGateway = await AggregatorGateway.create(restartConfig);
        gateways[followerIndex] = restartedGateway;

        await delay(5000);

        const restartedFollowerRootHash = await getRootHash(followerPort);
        expect(restartedFollowerRootHash).toBe(rootHashBeforeRestart);

        const finalCommitments = await Promise.all(
          Array.from({ length: 2 }, (_, i) => createTestCommitment(i + 20))
        );

        for (const commitment of finalCommitments) {
          const success = await sendCommitment(leaderPort, commitment);
          expect(success).toBe(true);
        }

        await delay(3000);
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

        for (const commitment of failoverCommitments) {
          const success = await sendCommitment(newLeaderPort, commitment);
          expect(success).toBe(true);
        }

        await delay(5000);
        
        const activePortsAfterFailover = ports.filter((_, index) => gateways[index] !== null);
        const failoverConvergence = await waitForRootHashConvergence(activePortsAfterFailover);
        expect(failoverConvergence.success).toBe(true);
        expect(failoverConvergence.rootHash).not.toBe(initialRootHash);
        
        const followerConfig = createGatewayConfig(leaderPort, leaderServerId, replicaSet.uri);
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

        for (const commitment of restartCommitments) {
          const success = await sendCommitment(leaderPort, commitment);
          expect(success).toBe(true);
        }

        await delay(6000);
        const leaderRootHashAfterCommitments = await getRootHash(leaderPort);
        expect(leaderRootHashAfterCommitments).not.toBe(initialRootHash);
        
        const restartPromises = followerConfigs.map(async (config, i) => {
          const restartConfig = createGatewayConfig(config.port, config.serverId, replicaSet.uri);
          const restartedGateway = await AggregatorGateway.create(restartConfig);
          gateways[followerIndices[i]] = restartedGateway;
          return restartedGateway;
        });
        
        await Promise.all(restartPromises);
        
        await delay(8000);
        
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