import { HexConverter } from '@unicitylabs/commons/lib/util/HexConverter.js';
import { StartedTestContainer } from 'testcontainers';

import logger from '../../src/Logger.js';
import { SmtNode } from '../../src/smt/SmtNode.js';
import { SmtStorage, LeafModel } from '../../src/smt/SmtStorage.js';
import { startMongoDb, stopMongoDb } from '../TestContainers.js';

describe('SMT Storage Tests', () => {
  jest.setTimeout(60000);

  let container: StartedTestContainer;

  beforeAll(async () => {
    container = await startMongoDb();
  });

  afterAll(() => {
    stopMongoDb(container);
  });

  it('Store and retrieve nodes', async () => {
    const storage = new SmtStorage();

    const testNodes = [
      new SmtNode(BigInt(1), new Uint8Array([1, 2, 3])),
      new SmtNode(BigInt(2), new Uint8Array([4, 5, 6])),
      // Max 256-bit value: 2^256 - 1
      new SmtNode(2n ** 256n - 1n, new Uint8Array([7, 8, 9])),
    ];

    logger.info('\nStoring test nodes...');
    for (const node of testNodes) {
      logger.info(`Storing node with path ${node.path} (hex: ${node.path.toString(16)})`);
      const result = await storage.put(node);
      logger.info(`Store result: ${result}`);
    }

    logger.info('\nRetrieving all nodes...');
    const retrieved = await storage.getAll();
    logger.info(`Retrieved ${retrieved.length} nodes`);

    logger.info('\nData comparison:');
    for (let i = 0; i < testNodes.length; i++) {
      const original = testNodes[i];
      const stored = retrieved.find((n) => n.path === original.path);

      if (stored) {
        logger.info(`Node ${original.path}:`);
        expect(stored.path).toEqual(original.path);
        expect(HexConverter.encode(stored.value)).toEqual(HexConverter.encode(original.value));
      } else {
        logger.info(`Node ${original.path} not found!`);
      }
    }
  });

  it('Store and retrieve nodes in batch', async () => {
    await LeafModel.deleteMany({});

    const storage = new SmtStorage();

    const batchTestNodes: SmtNode[] = [];
    for (let i = 0; i < 10; i++) {
      const path = BigInt(1000 + i);
      const value = new Uint8Array([i % 256, (i * 2) % 256, (i * 3) % 256]);
      batchTestNodes.push(new SmtNode(path, value));
    }

    logger.info('\nStoring test nodes in batch...');
    const result = await storage.putBatch(batchTestNodes);
    expect(result).toBe(true);

    logger.info('\nRetrieving all nodes...');
    const retrieved = await storage.getAll();
    logger.info(`Retrieved ${retrieved.length} nodes`);

    for (const original of batchTestNodes) {
      const stored = retrieved.find((n) => n.path === original.path);
      expect(stored).toBeDefined();
      expect(stored?.path).toEqual(original.path);
      expect(HexConverter.encode(stored!.value)).toEqual(HexConverter.encode(original.value));
    }
  });
});
