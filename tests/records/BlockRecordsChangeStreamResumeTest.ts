import { describe, it, beforeEach, afterEach, expect } from '@jest/globals';
import mongoose from 'mongoose';

import { BlockRecords } from '../../src/records/BlockRecords.js';
import { BlockRecordsStorage } from '../../src/records/BlockRecordsStorage.js';
import { getTestSigningService, createTestRequestId, connectToSharedMongo, clearAllCollections, disconnectFromSharedMongo } from '../TestUtils.js';

describe('BlockRecordsStorage Resume Token Tests', () => {
  jest.setTimeout(120000);

  let storage1: BlockRecordsStorage;
  let storage2: BlockRecordsStorage;
  const signingService = getTestSigningService();

  beforeAll(async () => {
    await connectToSharedMongo();
  });

  afterAll(async () => {
    await disconnectFromSharedMongo();
  });

  beforeEach(async () => {
    const testId = Date.now();
    storage1 = await BlockRecordsStorage.create(`server1_${testId}`);
    storage2 = await BlockRecordsStorage.create(`server2_${testId}`);
  });

  afterEach(async () => {
    if (storage1) await storage1.cleanup();
    if (storage2) await storage2.cleanup();
    await clearAllCollections();
  });

  describe('Resume Token Persistence', () => {
    it('should save resume token after processing change event', async () => {
      const receivedEvents: BlockRecords[] = [];
      
      storage1.addChangeListener((blockRecords) => {
        receivedEvents.push(blockRecords);
      });

      // Wait a bit for change stream to start
      await new Promise(resolve => setTimeout(resolve, 100));

      // Insert a block record
      const blockRecords = new BlockRecords(1n, [await createTestRequestId(signingService)]);
      await storage1.put(blockRecords);

      // Wait for change event to be processed
      await new Promise(resolve => setTimeout(resolve, 200));

      expect(receivedEvents).toHaveLength(1);
      expect(receivedEvents[0].blockNumber).toBe(1n);

      // Check that resume token was persisted
      const ResumeTokenModel = mongoose.model('BlockRecordsResumeToken');
      const tokenDoc = await ResumeTokenModel.findOne({ _id: { $regex: /server1_/ } });
      expect(tokenDoc).toBeTruthy();
      expect(tokenDoc.token).toBeTruthy();
    });

    it('should use separate resume tokens for different server IDs', async () => {
      const events1: BlockRecords[] = [];
      const events2: BlockRecords[] = [];

      storage1.addChangeListener((blockRecords) => events1.push(blockRecords));
      storage2.addChangeListener((blockRecords) => events2.push(blockRecords));

      await new Promise(resolve => setTimeout(resolve, 100));

      // Insert records through first storage to ensure both listeners receive events
      await storage1.put(new BlockRecords(1n, [await createTestRequestId(signingService)]));
      await storage1.put(new BlockRecords(2n, [await createTestRequestId(signingService)]));

      await new Promise(resolve => setTimeout(resolve, 300));

      // Both should receive the events (they watch the same collection)
      expect(events1.length).toBeGreaterThanOrEqual(2);
      expect(events2.length).toBeGreaterThanOrEqual(2);

      // But they should have separate resume token documents
      const ResumeTokenModel = mongoose.model('BlockRecordsResumeToken');
      const token1 = await ResumeTokenModel.findOne({ _id: { $regex: /server1_/ } });
      const token2 = await ResumeTokenModel.findOne({ _id: { $regex: /server2_/ } });

      expect(token1).toBeTruthy();
      expect(token2).toBeTruthy();
      expect(token1._id).not.toBe(token2._id);
      expect(token1.token).toBeTruthy();
      expect(token2.token).toBeTruthy();
    });
  });

  describe('Stream Resumption', () => {
    it('should resume from last token after restart', async () => {
      const events1: BlockRecords[] = [];
      const events2: BlockRecords[] = [];
      const serverId = `server_restart_${Date.now()}`;

      // Start first stream and process some events
      const storage1Initial = await BlockRecordsStorage.create(serverId);
      storage1Initial.addChangeListener((blockRecords) => events1.push(blockRecords));
      await new Promise(resolve => setTimeout(resolve, 100));

      await storage1Initial.put(new BlockRecords(1n, [await createTestRequestId(signingService)]));
      await storage1Initial.put(new BlockRecords(2n, [await createTestRequestId(signingService)]));
      await new Promise(resolve => setTimeout(resolve, 200));

      expect(events1).toHaveLength(2);
      expect(events1[0].blockNumber).toBe(1n);
      expect(events1[1].blockNumber).toBe(2n);

      // Stop the first stream
      await storage1Initial.cleanup();

      // Insert more records while stream is down (these should be caught by resume)
      await storage1Initial.put(new BlockRecords(3n, [await createTestRequestId(signingService)]));
      await storage1Initial.put(new BlockRecords(4n, [await createTestRequestId(signingService)]));

      // Start new stream with same server ID (simulating restart)
      const storage1Restarted = await BlockRecordsStorage.create(serverId);
      storage1Restarted.addChangeListener((blockRecords) => events2.push(blockRecords));
      await new Promise(resolve => setTimeout(resolve, 100));

      // Insert one more record after restart
      await storage1Restarted.put(new BlockRecords(5n, [await createTestRequestId(signingService)]));
      await new Promise(resolve => setTimeout(resolve, 300));

      // Should receive all events that occurred while stream was down (3, 4) plus new event (5)
      expect(events2).toHaveLength(3);
      expect(events2.some(e => e.blockNumber === 3n)).toBe(true);
      expect(events2.some(e => e.blockNumber === 4n)).toBe(true);
      expect(events2.some(e => e.blockNumber === 5n)).toBe(true);

      await storage1Restarted.cleanup();
    });

    it('should use startAtOperationTime when no resume token exists', async () => {
      const events: BlockRecords[] = [];
      const serverId = `fresh_${Date.now()}`;

      // Verify no resume token exists initially
      const ResumeTokenModel = mongoose.model('BlockRecordsResumeToken');
      const resumeTokenId = `blockRecords_${serverId}`;
      let tokenDoc = await ResumeTokenModel.findOne({ _id: resumeTokenId });
      expect(tokenDoc).toBeFalsy();

      // Create storage (which captures cluster time automatically)
      const storage = await BlockRecordsStorage.create(serverId);
      
      storage.addChangeListener((blockRecords) => events.push(blockRecords));
      await new Promise(resolve => setTimeout(resolve, 100));

      // Insert record after stream start
      await storage.put(new BlockRecords(1n, [await createTestRequestId(signingService)]));
      await new Promise(resolve => setTimeout(resolve, 200));

      expect(events).toHaveLength(1);
      expect(events[0].blockNumber).toBe(1n);

      // Verify resume token was created after processing event
      tokenDoc = await ResumeTokenModel.findOne({ _id: resumeTokenId });
      expect(tokenDoc).toBeTruthy();
      expect(tokenDoc.token).toBeTruthy();

      await storage.cleanup();
    });
  });

  describe('Error Recovery', () => {
    it('should handle generic stream errors and restart', async () => {
      const events: BlockRecords[] = [];
      
      storage1.addChangeListener((blockRecords) => events.push(blockRecords));
      await new Promise(resolve => setTimeout(resolve, 100));

      // Insert initial record
      await storage1.put(new BlockRecords(1n, [await createTestRequestId(signingService)]));
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(events).toHaveLength(1);
      expect(events[0].blockNumber).toBe(1n);

      // Verify resume token exists
      const ResumeTokenModel = mongoose.model('BlockRecordsResumeToken');
      let tokenDoc = await ResumeTokenModel.findOne({ _id: { $regex: /server1_/ } });
      expect(tokenDoc).toBeTruthy();
      const originalToken = tokenDoc.token;

      // Simulate stream error by closing the change stream manually
      // @ts-ignore - accessing private property for testing
      const changeStream = storage1.changeStream;
      if (changeStream) {
        // Emit error to trigger restart logic
        changeStream.emit('error', new Error('Simulated network error'));
      }

      // Wait for restart and then insert another record
      await new Promise(resolve => setTimeout(resolve, 1500));
      await storage1.put(new BlockRecords(2n, [await createTestRequestId(signingService)]));
      await new Promise(resolve => setTimeout(resolve, 300));

      // Should receive exactly 2 events (original + new)
      expect(events).toHaveLength(2);
      expect(events[0].blockNumber).toBe(1n);
      expect(events[1].blockNumber).toBe(2n);

      // Resume token should still exist (not cleared for generic errors)
      tokenDoc = await ResumeTokenModel.findOne({ _id: { $regex: /server1_/ } });
      expect(tokenDoc).toBeTruthy();
      expect(tokenDoc.token).toBeTruthy();
    });

    it('should handle ChangeStreamHistoryLost error', async () => {
      const events: BlockRecords[] = [];
      
      storage1.addChangeListener((blockRecords) => events.push(blockRecords));
      await new Promise(resolve => setTimeout(resolve, 100));

      // Insert initial record and verify token exists
      await storage1.put(new BlockRecords(1n, [await createTestRequestId(signingService)]));
      await new Promise(resolve => setTimeout(resolve, 200));

      expect(events).toHaveLength(1);
      expect(events[0].blockNumber).toBe(1n);

      const ResumeTokenModel = mongoose.model('BlockRecordsResumeToken');
      let tokenDoc = await ResumeTokenModel.findOne({ _id: { $regex: /server1_/ } });
      expect(tokenDoc).toBeTruthy();
      expect(tokenDoc.token).toBeTruthy();

      // Simulate ChangeStreamHistoryLost error
      // @ts-ignore - accessing private property for testing
      const changeStream = storage1.changeStream;
      if (changeStream) {
        const historyLostError = new Error('ChangeStreamHistoryLost') as Error & { code: number; codeName: string };
        historyLostError.code = 286;
        historyLostError.codeName = 'ChangeStreamHistoryLost';
        changeStream.emit('error', historyLostError);
      }

      // Wait for error handling and restart
      await new Promise(resolve => setTimeout(resolve, 1500));

      // Token should be cleared after ChangeStreamHistoryLost
      tokenDoc = await ResumeTokenModel.findOne({ _id: { $regex: /server1_/ } });
      expect(tokenDoc).toBeFalsy();

      // Should still be able to receive new events after restart
      await storage1.put(new BlockRecords(2n, [await createTestRequestId(signingService)]));
      await new Promise(resolve => setTimeout(resolve, 300));

      // Should have received both events (original + new after restart)
      expect(events).toHaveLength(2);
      expect(events[0].blockNumber).toBe(1n);
      expect(events[1].blockNumber).toBe(2n);

      // New resume token should be created
      tokenDoc = await ResumeTokenModel.findOne({ _id: { $regex: /server1_/ } });
      expect(tokenDoc).toBeTruthy();
      expect(tokenDoc.token).toBeTruthy();
    });
  });

  describe('Concurrent Followers', () => {
    it('should allow multiple followers to run simultaneously', async () => {
      const events1: BlockRecords[] = [];
      const events2: BlockRecords[] = [];
      const events3: BlockRecords[] = [];

      // Start three concurrent followers
      const testId = Date.now();
      const follower1 = await BlockRecordsStorage.create(`follower1_${testId}`);
      const follower2 = await BlockRecordsStorage.create(`follower2_${testId}`);
      const follower3 = await BlockRecordsStorage.create(`follower3_${testId}`);

      follower1.addChangeListener((br) => events1.push(br));
      follower2.addChangeListener((br) => events2.push(br));
      follower3.addChangeListener((br) => events3.push(br));

      await new Promise(resolve => setTimeout(resolve, 100));

      // Insert records sequentially to ensure proper ordering
      await storage1.put(new BlockRecords(1n, [await createTestRequestId(signingService)]));
      await new Promise(resolve => setTimeout(resolve, 100));
      await storage1.put(new BlockRecords(2n, [await createTestRequestId(signingService)]));
      await new Promise(resolve => setTimeout(resolve, 100));
      await storage1.put(new BlockRecords(3n, [await createTestRequestId(signingService)]));

      await new Promise(resolve => setTimeout(resolve, 400));

      // All followers should receive all events (allow for timing variations)
      expect(events1.length).toBeGreaterThanOrEqual(3);
      expect(events2.length).toBeGreaterThanOrEqual(3);
      expect(events3.length).toBeGreaterThanOrEqual(3);

      // Verify specific events were received
      expect(events1.some(e => e.blockNumber === 1n)).toBe(true);
      expect(events1.some(e => e.blockNumber === 2n)).toBe(true);
      expect(events1.some(e => e.blockNumber === 3n)).toBe(true);

      // Verify they maintain separate resume tokens
      const ResumeTokenModel = mongoose.model('BlockRecordsResumeToken');
      const tokens = await ResumeTokenModel.find({});
      const followerTokens = tokens.filter(t => t._id.includes('follower'));
      expect(followerTokens).toHaveLength(3);

      const tokenIds = followerTokens.map(t => t._id);
      expect(new Set(tokenIds).size).toBe(3);
      followerTokens.forEach(token => {
        expect(token.token).toBeTruthy();
      });

      await follower1.cleanup();
      await follower2.cleanup();
      await follower3.cleanup();
    });
  });
}); 