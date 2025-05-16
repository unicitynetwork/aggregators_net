import mongoose from 'mongoose';

import logger from '../../src/logger.js';
import { BlockRecords } from '../../src/records/BlockRecords.js';
import { BlockRecordsStorage } from '../../src/records/BlockRecordsStorage.js';
import { SmtNode } from '../../src/smt/SmtNode.js';
import { SmtStorage } from '../../src/smt/SmtStorage.js';
import { IReplicaSet, delay, generateTestCommitments, setupReplicaSet } from '../TestUtils.js';

describe('BlockRecords Change Stream Test', () => {
  jest.setTimeout(120000);

  let replicaSet: IReplicaSet;
  let blockRecordsStorage: BlockRecordsStorage;
  let smtStorage: SmtStorage;

  const receivedEvents: Array<BlockRecords> = [];
  const changeListener = (blockRecords: BlockRecords) => {
    logger.info(
      `Received event for block ${blockRecords.blockNumber} with ${blockRecords.requestIds.length} requestIds`,
    );
    receivedEvents.push(blockRecords);
  };

  beforeAll(async () => {
    replicaSet = await setupReplicaSet('block-records-test-');
    logger.info(`Connecting to MongoDB replica set at ${replicaSet.uri}`);
    await mongoose.connect(replicaSet.uri);

    if (mongoose.connection.db) {
      await mongoose.connection.db.dropDatabase();
    }
  });

  afterAll(async () => {
    if (blockRecordsStorage) {
      blockRecordsStorage.removeChangeListener(changeListener);
      await blockRecordsStorage.stopWatchingChanges();
    }

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
  });

  beforeEach(() => {
    receivedEvents.length = 0;
  });

  it('should detect new block records and allow retrieving corresponding SMT leaves', async () => {
    blockRecordsStorage = new BlockRecordsStorage();
    smtStorage = new SmtStorage();

    blockRecordsStorage.addChangeListener(changeListener);
    logger.info('Change stream listening started');

    const commitments = await generateTestCommitments(5);
    logger.info(`Generated ${commitments.length} test commitments`);

    const smtLeaves: SmtNode[] = commitments.map((commitment) => {
      const nodePath = commitment.requestId.toBigInt();
      const value = new Uint8Array(32);
      value.set(Buffer.from(nodePath.toString().padStart(32, '0').slice(0, 32)));
      return new SmtNode(nodePath, value);
    });

    logger.info(`Storing ${smtLeaves.length} SMT leaves`);
    await smtStorage.putBatch(smtLeaves);

    const storedLeaves = await smtStorage.getAll();
    logger.info(`Verified ${storedLeaves.length} SMT leaves are stored`);
    expect(storedLeaves.length).toBeGreaterThanOrEqual(smtLeaves.length);

    const blockNumber = BigInt(1);
    const requestIds = commitments.map((c) => c.requestId);
    const blockRecords = new BlockRecords(blockNumber, requestIds);

    logger.info(`Storing block record with ${requestIds.length} request IDs`);
    await blockRecordsStorage.put(blockRecords);

    logger.info('Waiting for change stream to process the event...');
    await delay(1000);

    expect(receivedEvents.length).toBe(1);

    const event = receivedEvents[0];
    expect(event.blockNumber).toBe(blockNumber);
    expect(event.requestIds.length).toBe(requestIds.length);

    for (let i = 0; i < requestIds.length; i++) {
      expect(event.requestIds[i].toString()).toBe(requestIds[i].toString());
    }

    const paths = event.requestIds.map((id) => id.toBigInt());
    const leaves = await smtStorage.getByPaths(paths);

    expect(leaves.length).toBe(smtLeaves.length);

    for (const leaf of leaves) {
      const matchingRequestId = requestIds.find((rid) => rid.toBigInt() === leaf.path);
      expect(matchingRequestId).toBeDefined();
    }
  });
});
