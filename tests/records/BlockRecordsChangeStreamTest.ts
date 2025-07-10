import logger from '../../src/logger.js';
import { BlockRecords } from '../../src/records/BlockRecords.js';
import { BlockRecordsStorage } from '../../src/records/BlockRecordsStorage.js';
import { SmtNode } from '../../src/smt/SmtNode.js';
import { SmtStorage } from '../../src/smt/SmtStorage.js';
import { delay, generateTestCommitments, connectToSharedMongo, disconnectFromSharedMongo, clearAllCollections } from '../TestUtils.js';

describe('BlockRecords Change Stream Test', () => {
  jest.setTimeout(120000);

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
    await connectToSharedMongo();
  });

  afterAll(async () => {
    if (blockRecordsStorage) {
      blockRecordsStorage.removeChangeListener(changeListener);
      await blockRecordsStorage.cleanup();
    }

    await disconnectFromSharedMongo();
  });

  afterEach(async () => {
    await clearAllCollections();
    receivedEvents.length = 0;
  });

  it('should detect new block records and allow retrieving corresponding SMT leaves', async () => {
    blockRecordsStorage = await BlockRecordsStorage.create('test-server');
    smtStorage = new SmtStorage();

    blockRecordsStorage.addChangeListener(changeListener);
    logger.info('Change stream listening started');
    
    await delay(500);

    const commitments = await generateTestCommitments(5);
    logger.info(`Generated ${commitments.length} test commitments`);

    const smtLeaves: SmtNode[] = commitments.map((commitment) => {
      const nodePath = commitment.requestId.toBitString().toBigInt();
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

    const paths = event.requestIds.map((id) => id.toBitString().toBigInt());
    const leaves = await smtStorage.getByPaths(paths);

    expect(leaves.length).toBe(smtLeaves.length);

    for (const leaf of leaves) {
      const matchingRequestId = requestIds.find((rid) => rid.toBitString().toBigInt() === leaf.path);
      expect(matchingRequestId).toBeDefined();
    }
  });
});
