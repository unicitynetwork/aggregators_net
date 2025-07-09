import { DataHasherFactory } from '@unicitylabs/commons/lib/hash/DataHasherFactory.js';
import { HashAlgorithm } from '@unicitylabs/commons/lib/hash/HashAlgorithm.js';
import { NodeDataHasher } from '@unicitylabs/commons/lib/hash/NodeDataHasher.js';
import { SparseMerkleTreeBuilder } from '@unicitylabs/commons/lib/smt/SparseMerkleTreeBuilder.js';
import { HexConverter } from '@unicitylabs/commons/lib/util/HexConverter.js';

import logger from '../../src/logger.js';
import { SmtNode } from '../../src/smt/SmtNode.js';
import { SmtStorage, LeafModel } from '../../src/smt/SmtStorage.js';
import { connectToSharedMongo, disconnectFromSharedMongo, clearAllCollections } from '../TestUtils.js';

describe('SMT Storage Tests', () => {
  jest.setTimeout(120000);

  beforeAll(async () => {
    await connectToSharedMongo();
  });

  afterAll(async () => {
    await disconnectFromSharedMongo();
  });

  afterEach(async () => {
    await clearAllCollections();
  });

  it('Store and retrieve nodes', async () => {
    const storage = new SmtStorage();

    const testNodes = [
      new SmtNode(BigInt(1), new Uint8Array([1, 2, 3])),
      new SmtNode(BigInt(2), new Uint8Array([4, 5, 6])),
      new SmtNode(2n ** 256n - 1n, new Uint8Array([7, 8, 9])),
    ];

    logger.info('Storing test nodes...');
    for (const node of testNodes) {
      logger.info(`Storing node with path ${node.path} (hex: ${node.path.toString(16)})`);
      const result = await storage.put(node);
      logger.info(`Store result: ${result}`);
    }

    logger.info('Retrieving all nodes...');
    const retrieved = await storage.getAll();
    logger.info(`Retrieved ${retrieved.length} nodes`);

    logger.info('Data comparison:');
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

    logger.info('Storing test nodes in batch...');
    const result = await storage.putBatch(batchTestNodes);
    expect(result).toBe(true);

    logger.info('Retrieving all nodes...');
    const retrieved = await storage.getAll();
    logger.info(`Retrieved ${retrieved.length} nodes`);

    for (const original of batchTestNodes) {
      const stored = retrieved.find((n) => n.path === original.path);
      expect(stored).toBeDefined();
      expect(stored?.path).toEqual(original.path);
      expect(HexConverter.encode(stored!.value)).toEqual(HexConverter.encode(original.value));
    }
  });

  it('Retrieve multiple nodes by their paths using getByPaths', async () => {
    await LeafModel.deleteMany({});

    const storage = new SmtStorage();

    const testNodes: SmtNode[] = [];
    for (let i = 0; i < 20; i++) {
      const path = BigInt(5000 + i);
      const value = new Uint8Array([i, 100 - i, i * 2]);
      testNodes.push(new SmtNode(path, value));
    }

    logger.info('Storing 20 test nodes for getByPaths test...');
    const storeResult = await storage.putBatch(testNodes);
    expect(storeResult).toBe(true);

    // Select a subset of paths to retrieve
    const pathsToRetrieve = [
      BigInt(5003),
      BigInt(5007),
      BigInt(5012),
      BigInt(5019),
      BigInt(9999), // Path that doesn't exist
    ];

    logger.info(`Retrieving nodes with specific paths: ${pathsToRetrieve.map((p) => p.toString()).join(', ')}...`);
    const retrievedNodes = await storage.getByPaths(pathsToRetrieve);

    logger.info(`Retrieved ${retrievedNodes.length} nodes from ${pathsToRetrieve.length} requested paths`);

    // We should get 4 nodes, not 5, since one path doesn't exist
    expect(retrievedNodes.length).toBe(4);

    for (const retrievedNode of retrievedNodes) {
      const expectedNode = testNodes.find((n) => n.path === retrievedNode.path);
      expect(expectedNode).toBeDefined();
      expect(HexConverter.encode(retrievedNode.value)).toEqual(HexConverter.encode(expectedNode!.value));
      logger.info(`Verified node with path ${retrievedNode.path}`);
    }

    // Check that the non-existent path wasn't returned
    const nonExistentNode = retrievedNodes.find((n) => n.path === BigInt(9999));
    expect(nonExistentNode).toBeUndefined();

    // Verify retrieving an empty path array returns empty result
    const emptyPathResult = await storage.getByPaths([]);
    expect(emptyPathResult.length).toBe(0);
  });

  it('Try to store the same batch of SMT nodes twice', async () => {
    await LeafModel.deleteMany({});

    const storage = new SmtStorage();

    const testNodes: SmtNode[] = [];
    for (let i = 0; i < 3; i++) {
      const path = BigInt(2000 + i);
      const value = new Uint8Array([10 + i, 20 + i, 30 + i]);
      testNodes.push(new SmtNode(path, value));
    }

    logger.info('\nFirst batch insertion of SMT nodes...');
    const firstResult = await storage.putBatch(testNodes);
    expect(firstResult).toBe(true);

    const originalNodes = testNodes.map((node) => ({
      path: node.path,
      value: new Uint8Array(node.value),
    }));

    logger.info('\nSecond batch insertion of same SMT nodes...');
    const secondResult = await storage.putBatch(testNodes);
    expect(secondResult).toBe(true);

    const modifiedNodes: SmtNode[] = [];
    for (let i = 0; i < 3; i++) {
      const path = BigInt(2000 + i);
      const value = new Uint8Array([50 + i, 60 + i, 70 + i]);
      modifiedNodes.push(new SmtNode(path, value));
    }

    logger.info('\nThird batch insertion (same paths, new values)...');
    const thirdResult = await storage.putBatch(modifiedNodes);
    expect(thirdResult).toBe(true);

    const allNodes = await storage.getAll();
    for (const original of originalNodes) {
      const retrieved = allNodes.find((n) => n.path === original.path);
      expect(retrieved).toBeDefined();
      expect(retrieved!.path).toEqual(original.path);
      expect(HexConverter.encode(retrieved!.value)).toEqual(HexConverter.encode(original.value));
    }

    const newNode = new SmtNode(BigInt(9999), new Uint8Array([99, 99, 99]));

    const mixedBatch = [...modifiedNodes, newNode];
    logger.info('\nFourth batch insertion (mix of existing and new nodes)...');
    const fourthResult = await storage.putBatch(mixedBatch);
    expect(fourthResult).toBe(true);

    const updatedNodes = await storage.getAll();

    const retrievedNew = updatedNodes.find((n) => n.path === newNode.path);
    expect(retrievedNew).toBeDefined();
    if (retrievedNew) {
      expect(retrievedNew.path).toEqual(newNode.path);
      expect(HexConverter.encode(retrievedNew.value)).toEqual(HexConverter.encode(newNode.value));
    }

    expect(updatedNodes.length).toBe(4);
  });

  it('Try adding the same leaf to SMT tree twice', async () => {
    const smt = new SparseMerkleTreeBuilder(new DataHasherFactory(HashAlgorithm.SHA256, NodeDataHasher));

    const path = BigInt(12345);
    const value = new Uint8Array([1, 2, 3, 4, 5]);

    smt.addLeaf(path, value);
    const rootHashAfterFirstAddition = await smt.calculateRoot();
    logger.info(`Root hash after first addition: ${rootHashAfterFirstAddition.toString()}`);

    try {
      smt.addLeaf(path, value);
      expect(false).toBe(true);
    } catch (error) {
      logger.info('Got expected error when adding the same leaf twice:', error);
      expect((error as Error).message).toContain('Cannot add leaf inside branch');
    }

    const differentPath = BigInt(54321);
    try {
      smt.addLeaf(differentPath, value);
      logger.info('Successfully added leaf with same value but different path');
    } catch (error) {
      logger.error('Unexpected error when adding leaf with same value but different path:', error);
      expect(error).toBeUndefined();
    }
  });

  it('Store nodes atomically using putBatch', async () => {
    await LeafModel.deleteMany({});

    const storage = new SmtStorage();

    const testNodes: SmtNode[] = [];
    for (let i = 0; i < 5; i++) {
      const path = BigInt(3000 + i);
      const value = new Uint8Array([20 + i, 30 + i, 40 + i]);
      testNodes.push(new SmtNode(path, value));
    }

    logger.info('Inserting nodes atomically...');
    const result = await storage.putBatch(testNodes);
    expect(result).toBe(true);

    const allNodes = await storage.getAll();

    const insertedNodes = allNodes.filter((node) => testNodes.some((testNode) => testNode.path === node.path));
    expect(insertedNodes.length).toBe(5);

    for (const original of testNodes) {
      const stored = allNodes.find((n) => n.path === original.path);
      expect(stored).toBeDefined();
      expect(HexConverter.encode(stored!.value)).toEqual(HexConverter.encode(original.value));
    }

    const countBefore = await LeafModel.countDocuments();
    logger.info(`Node count before bad transaction: ${countBefore}`);

    const originalBulkWrite = LeafModel.bulkWrite;
    LeafModel.bulkWrite = jest.fn().mockImplementationOnce(() => {
      throw new Error('Simulated transaction error');
    });

    const badBatch = [
      new SmtNode(BigInt(4000), new Uint8Array([1, 2, 3])),
      new SmtNode(BigInt(4001), new Uint8Array([4, 5, 6])),
    ];

    let errorCaught = false;
    try {
      await storage.putBatch(badBatch);
    } catch (error) {
      logger.info('Got expected error from atomic operation:', error);
      errorCaught = true;
    } finally {
      LeafModel.bulkWrite = originalBulkWrite;
    }

    expect(errorCaught).toBe(true);

    const countAfter = await LeafModel.countDocuments();
    logger.info(`Node count after bad transaction: ${countAfter}`);

    expect(countAfter).toBe(countBefore);

    const finalNodes = await storage.getAll();
    const badNode = finalNodes.find((n) => n.path === BigInt(4000));
    expect(badNode).toBeUndefined();

    expect(finalNodes.filter((node) => testNodes.some((testNode) => testNode.path === node.path)).length).toBe(5);
  });
});
